"""Export the untouched checkpoint and its own support cache for the existing Kumo kernels."""
import argparse
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import torch

from export import Export, digest, specialize


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('experiment', type=Path)
    ap.add_argument('checkpoint', type=Path)
    ap.add_argument('--out', type=Path, default=Path('dist'))
    ap.add_argument('--tests', type=Path, default=Path('tests'))
    ap.add_argument('--layout', type=Path, default=Path('src/layout.h'))
    args = ap.parse_args()
    sys.path.insert(0, str(args.experiment.resolve()))
    from policy import Policy, build, checkpoint, WEIGHTS_SHA
    root = args.experiment / 'results'
    torch.set_num_threads(2)
    model = build()
    model.load_state_dict(checkpoint(args.checkpoint))
    assert all(v.dtype == torch.float32 for v in model.parameters())
    with np.load(root / 'support.npz') as support:
        policy = Policy(model, support['x'], support['y'])
        support_count = int(len(support['x']))
    # Empty packed map forces all tensors (including each projected support K/V) to FP32.
    export = Export(model, {})
    header = specialize(policy, export)
    layout = args.layout.read_text().splitlines()[1:]
    if layout != '\n'.join(header).splitlines():
        raise ValueError('Original tensor offsets differ from those of the production kernels')
    raw = np.zeros(export.offset, dtype='<f4')
    table = []
    for item in export.items:
        assert item['type'] == 'f32'
        start, count = item['start'], item['count']
        values = np.frombuffer(export.raw, dtype='<f4', count=count, offset=item['fileOffset'])
        raw[start:start + count] = values
        table.append(dict(name=item['name'], start=start, count=count))
    args.out.mkdir(parents=True, exist_ok=True)
    args.tests.mkdir(parents=True, exist_ok=True)
    # Byte planes preserve the four original bytes of each float and improve gzip compression.
    chunk_floats = 2 * 1024 * 1024
    chunks = []
    for i, start in enumerate(range(0, len(raw), chunk_floats)):
        floats = raw[start:start + chunk_floats]
        shuffled = floats.view(np.uint8).reshape(-1, 4).T.copy().tobytes()
        compressed = gzip.compress(shuffled, compresslevel=6, mtime=0)
        name = f'original-{i:02d}.pack'
        (args.out / name).write_bytes(compressed)
        chunks.append(dict(path=name, bytes=len(compressed), rawBytes=len(shuffled),
                           sha256=digest(compressed), rawSha256=digest(shuffled)))
    info = json.loads((root / 'support.json').read_text())
    manifest = dict(format=2, precision='fp32', encoding='f32le-byteplanes-gzip',
                    floatCount=len(raw), rawBytes=raw.nbytes, chunks=chunks, tensors=table,
                    actions=['LEFT', 'RIGHT', 'FIRE'], features=info['features'],
                    checkpointSHA256=WEIGHTS_SHA, supportSHA256=digest((root/'support.npz').read_bytes()),
                    supportCount=support_count, layoutSHA256=digest(args.layout.read_bytes()),
                    payloadSHA256=digest(raw.tobytes()))
    (args.out / 'original-manifest.json').write_text(json.dumps(manifest,separators=(',',':'))+'\n')
    # All fixed development observations. Calculate reference with the stock PyTorch FP32 graph.
    with np.load(root/'dev-w4-trace.npz') as trace:
        observations = trace['x']
    predicted = torch.cat([policy.logits(observations[i:i+32]) for i in range(0,len(observations),32)])
    reference = dict(checkpointSHA256=WEIGHTS_SHA, observations=observations.tolist(),
                     logits=predicted.tolist(), supportSHA256=manifest['supportSHA256'])
    (args.tests/'original-reference.json').write_text(json.dumps(reference,separators=(',',':'))+'\n')
    print(f'{len(table)} tensors; {support_count} support rows; {len(predicted)} reference rows; '
          f'{raw.nbytes:,} decoded bytes, {sum(c["bytes"] for c in chunks):,} transferred bytes, {len(chunks)} chunks')


if __name__=='__main__':
    main()
