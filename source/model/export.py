"""Specialize the frozen Kumo policy for one query at a time; rebuild by running build.sh."""
import argparse
import gzip
import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


class Export:
    def __init__(self, model, packed):
        self.model = model
        self.state = model.state_dict()
        self.packed = packed
        self.offset = 4
        self.raw = bytearray()
        self.items = []

    def put(self, name, tensor, encoded=None):
        values = tensor.detach().to(torch.float32).contiguous().numpy().astype("<f4", copy=False)
        entry = {"name": name, "type": "f32", "start": self.offset, "count": values.size,
                 "fileOffset": len(self.raw)}
        if encoded is None:
            self.raw.extend(values.tobytes())
        else:
            scales, data = encoded
            entry.update(type="q4", width=values.shape[-1])
            if values.shape[-1] % 64 != 0:
                # PyTorch pads each row-group: for 32-wide matrices keep the first 32 codes.
                assert values.shape[-1] == 32
            self.raw.extend(scales.detach().contiguous().numpy().astype("<f2").tobytes())
            self.raw.extend(data.detach().contiguous().numpy().tobytes())
        entry["bytes"] = len(self.raw) - entry["fileOffset"]
        self.items.append(entry)
        start = self.offset
        self.offset += values.size
        self.offset = (self.offset + 3) & ~3
        return start

    def param(self, key, rows=None, begin=0):
        t = self.state[key]
        n = t.shape[0] if rows is None else rows
        val = t[begin:begin+n]
        p = self.packed.get(key)
        if p:
            encoded = p['scale'][begin:begin+n], p['data'][begin:begin+n]
        else:
            encoded = None
        return self.put(key if begin == 0 else f'{key}@{begin}', val, encoded)

    def lin(self, name, rows=None, begin=0):
        return '{' + ','.join(str(self.param(name + ending, rows, begin)) for ending in ('.weight','.bias')) + '}'

    def block(self, path, mode, cache, channels, key_count, rope):
        # A cached attention site only uses its query projection during play.
        q = self.lin(path + '.attn.qkv_lin', channels)
        kv = self.lin(path + '.attn.qkv_lin', 2*channels, channels) if mode == 'row' else '{0,0}'
        out = self.lin(path + '.attn.out_lin')
        m1, m2 = self.lin(path + '.mlp.1'), self.lin(path + '.mlp.3')
        nq = self.param(path + '.query_norm.weight')
        nk = self.param(path + '.key_value_norm.weight') if mode == 'row' else 0
        nm = self.param(path + '.mlp.0.weight')
        key, value = 0, 0
        if cache:
            key = self.put(path + '#keys', cache.key)
            value = self.put(path + '#values', cache.value)
        scale = 0
        if mode in ('row', 'icl'):
            v = self.state[path+'.attn.sdpa.query_scaling.head_scale']
            scale = self.put(path+'#query_scale', v * torch.tensor(float(key_count)).log())
        gate1, gate2 = ('{0,0}', '{0,0}')
        if mode == 'row':
            gate1 = self.lin(path+'.attn.sdpa.query_scaling.gate.0')
            gate2 = self.lin(path+'.attn.sdpa.query_scaling.gate.2')
        return '{' + ','.join(map(str, (q, kv, out, m1, m2, gate1, gate2, nq, nk, nm, key, value, scale, rope))) + '}'


def specialize(policy, ex):
    """Emit the shared one-query layout for either the original or quantized parameters."""
    h=[]

    def define(key,val):
        h.append(f'#define {key} {val}')

    define('MEAN', ex.put('support.mean',policy.mean))
    define('STD', ex.put('support.std',policy.std))
    define('FREQ', ex.param('row_embedding.cell_embedding.num_freq'))
    define('CELL_WEIGHT',ex.param('row_embedding.cell_embedding.num_lin.weight'))
    define('CELL_BIAS',ex.param('row_embedding.cell_embedding.num_lin.bias'))
    define('READOUT',ex.param('row_embedding.readout_token'))
    define('ROW_NORM',ex.param('row_embedding.norm.weight'))
    define('ICL_NORM',ex.param('icl_block.norm.weight'))
    col, row, icl = [], [], []
    for i in range(4):
        path=f'row_embedding.col_blocks.{i}.output_block'
        col.append(ex.block(path,'col',policy.cache[f'row_embedding.col_block{i}'],128,128,0))
        path=f'row_embedding.row_blocks.{i}'
        inv=ex.state[path+'.attn.query_transform.0.inv_freq']
        phase=torch.arange(18)[:, None]*inv[None, :]
        rope=ex.put(f'{path}#rope',torch.stack((phase.cos(),phase.sin()),1))
        row.append(ex.block(path,'row',None,128,18,rope))
    for i in range(12):
        path=f'icl_block.layers.{i}'
        icl.append(ex.block(path,'icl',policy.cache[f'icl_block.layer{i}'],512,96,0))
    for name,blocks in [('col',col),('row',row),('icl',icl)]:
        h.append(f'static const Block {name}[]={{\n'+',\n'.join(blocks)+'\n};')
    h.append('static const Linear HEAD1='+ex.lin('icl_block.head.0')+';')
    h.append('static const Linear HEAD2='+ex.lin('icl_block.head.2',3)+';')
    define('TOTAL_FLOATS',ex.offset)
    return h


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('experiment',type=Path)
    args=ap.parse_args()
    root=args.experiment.resolve()
    sys.path.insert(0, str(root))
    from run import policy_for
    from policy import HEAD
    torch.set_num_threads(2)
    source=root/'results'
    packed=torch.load(source/'kumo-small-w4.pt',weights_only=True)
    policy=policy_for(source,None,'w4')
    model=policy.model
    ex=Export(model,packed['packed'])
    h = specialize(policy, ex)
    (HERE/'src'/'layout.h').write_text('// Generated tensor offsets; regeneration requires the matching exported weights.\n'+'\n'.join(h)+'\n')
    dist=HERE/'dist'; dist.mkdir(exist_ok=True)
    chunks=[]; size=4*1024*1024
    for i,k in enumerate(range(0,len(ex.raw),size)):
        raw=ex.raw[k:k+size]; blob=gzip.compress(raw,compresslevel=6,mtime=0)
        name=f'model-{i:02d}.pack'
        (dist/name).write_bytes(blob)
        chunks.append({'path':name,'bytes':len(blob),'rawBytes':len(raw),'sha256':digest(blob),'rawSha256':digest(raw)})
    edit=json.loads((source/'edit.json').read_text())
    bias=json.loads((source/'bias-control.json').read_text())
    assert edit['tensor']==HEAD and packed['group']==64
    manifest={'format':1,'floatCount':ex.offset,'rawBytes':len(ex.raw),'chunks':chunks,'tensors':ex.items,'edit':edit['edits'],'biasOffset':bias['fire_logit_offset'],
              'actions':['LEFT','RIGHT','FIRE'],'features':json.loads((source/'support.json').read_text())['features'],
              'packedSHA256':digest((source/'kumo-small-w4.pt').read_bytes())}
    (dist/'manifest.json').write_text(json.dumps(manifest,separators=(',',':'))+'\n')
    npz=np.load(source/'dev-w4-trace.npz')
    xs=npz['x']; refs=[]
    for which in ('w4','edited','bias'):
        p=policy_for(source,None,which)
        zs=torch.cat([p.logits(xs[i:i+32]) for i in range(0,len(xs),32)]).tolist()
        refs.append(zs)
    (HERE/'tests'/'reference.json').write_text(json.dumps({'observations':xs.tolist(),'variants':['w4','edited','bias'],'logits':refs},separators=(',',':'))+'\n')
    print('Inference tensors',len(ex.items),'FP32 bytes',4*ex.offset,'packed bytes',len(ex.raw),'gzipped',sum(c['bytes'] for c in chunks),'parity states',len(xs))


if __name__=='__main__':
    main()
