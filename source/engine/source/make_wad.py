"""Build a compact single-map Freedoom IWAD. Source asset is ViZDoom 1.3.0 freedoom2.wad."""
import gzip
import hashlib
import math
import struct
import sys
from pathlib import Path

def name(x):
    return x.encode().ljust(8, b'\0')

def lump(n, fmt, rows):
    return n, b''.join(struct.pack('<'+fmt,*r) for r in rows)

def arena():
    n=16
    v=[(round(800*math.cos(i*math.tau/n)),round(-800*math.sin(i*math.tau/n))) for i in range(n)]
    # One convex subsector: no BSP partitions are necessary.
    seq=[('MAP01',b''),lump('THINGS','hhhhh',[(0,0,0,1,7)]),
         lump('LINEDEFS','HHHHHHH',[(i,(i+1)%n,1,0,0,i,65535) for i in range(n)]),
         lump('SIDEDEFS','hh8s8s8sH',[(0,0,name('-'),name('-'),name('TANROCK2'),0) for i in range(n)]),
         lump('VERTEXES','hh',v),
         lump('SEGS','6H',[(i,(i+1)%n,round(math.atan2(v[(i+1)%n][1]-v[i][1],v[(i+1)%n][0]-v[i][0])*65536/math.tau)%65536,i,0,0) for i in range(n)]),
         lump('SSECTORS','HH',[(n,0)]),('NODES',b''),
         lump('SECTORS','hh8s8shhh',[(0,300,name('FLOOR0_5'),name('CEIL4_1'),210,0,0)]),('REJECT',b'\0')]
    cells=14*14
    grid=[-896,-896,14,14]+[4+cells]*cells+[0,*range(n),-1]
    seq.append(('BLOCKMAP',struct.pack(f'<{len(grid)}h',*grid)))
    return seq

def run(source, dest):
    data=Path(source).read_bytes()
    _,size,off=struct.unpack_from('<4sII',data)
    lumps=[(key.rstrip(b'\0').decode('ascii'),data[i:i+s]) for i,s,key in struct.iter_unpack('<II8s',data[off:off+size*16])]
    assets=dict(lumps)
    raw=assets['TEXTURE1']
    positions=struct.unpack_from(f"<{struct.unpack_from('<I',raw)[0]}I",raw,4)
    required_patches=set()
    textures=[]
    for idx,pos in enumerate(positions):
        texname=raw[pos:pos+8].rstrip(b'\0').decode()
        if idx and texname not in ('TANROCK2','SKY1','SKY2','SKY3') and not texname.startswith(('SW1','SW2')):continue
        count=struct.unpack_from('<H',raw,pos+20)[0]
        textures.append(raw[pos:pos+22+10*count])
        for j in range(count):
            patch=struct.unpack_from('<H',raw,pos+22+j*10+4)[0]
            required_patches.add(assets['PNAMES'][4+8*patch:12+8*patch].rstrip(b'\0').decode())
    texoff=4+4*len(textures)
    texhead=struct.pack('<I',len(textures))
    for part in textures:texhead+=struct.pack('<I',texoff);texoff+=len(part)
    limited_textures=texhead+b''.join(textures)
    out=arena()
    # Preserve legacy engine lump namespace and all texture/flat indexes. Drop
    # unrelated maps, demo recordings, music and sprites unused in this arena.
    active=False
    in_sprites=False
    in_patches=False
    for key,blob in lumps:
        if key=='PLAYPAL': active=True
        if not active: continue
        if key=='P_START': in_patches=True
        if key=='P_END': in_patches=False
        if in_patches and key not in required_patches and not key.endswith(('START','END')):continue
        if key=='TEXTURE1': blob=limited_textures
        if key=='S_START': in_sprites=True;out.append((key,blob)); continue
        if key=='S_END': in_sprites=False
        if in_sprites and key[:4] not in ('SARG','POSS','PLAY','PISG','PISF','PUFF','BLUD','BAL1','TNT1','PUNG'):continue
        if key.startswith('D_'):
            # Keep music handles valid; the browser arena intentionally disables sound.
            blob=b'MUS\x1a'+struct.pack('<6H',1,16,0,0,0,0)+b'\x60'
        if key.startswith('DEMO'):continue
        out.append((key,blob))
    body=bytearray(b'\0'*12)
    directory=b''
    for key,blob in out:
        directory+=struct.pack('<II8s',len(body),len(blob),name(key))
        body.extend(blob)
    struct.pack_into('<4sII',body,0,b'IWAD',len(out),len(body));body.extend(directory)
    Path(dest).write_bytes(gzip.compress(body,compresslevel=9,mtime=0))
    print(f'{len(body)} raw, {Path(dest).stat().st_size} gzip, IWAD source sha256 {hashlib.sha256(data).hexdigest()}')
if __name__=='__main__':run(*sys.argv[1:])
