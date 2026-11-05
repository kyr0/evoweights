#!/usr/bin/env python3
"""Compile generated PNG atlases into the DOOM patch/flat formats; retain IWAD support lumps.

Requires Pillow. The PNGs are original generated source assets, not third-party game art.
No image synthesis occurs here: this is atlas slicing, size conversion and palette encoding.
"""
import gzip
import hashlib
import json
import struct
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'public/assets/huggingdoom'
BASE = ROOT / 'tests/fixtures/legacy-engine/arena.wad.gz'
OUT = ROOT / 'public/engine/arena.wad.gz'


def cell(image, cols, rows, x, y):
    w, h = image.size
    return image.crop((round(x*w/cols), round(y*h/rows), round((x+1)*w/cols), round((y+1)*h/rows))).convert('RGBA')


def read_wad(path):
    data = gzip.decompress(path.read_bytes())
    _, count, offset = struct.unpack_from('<4sII', data)
    return [(name.rstrip(b'\0').decode(), data[p:p+s]) for p,s,name in struct.iter_unpack('<II8s', data[offset:offset+count*16])]


def n8(name):
    return name.encode().ljust(8, b'\0')


def main():
    bears = Image.open(ART / 'bear-atlas.png')
    meadow = Image.open(ART / 'meadow-atlas.png')
    props = Image.open(ART / 'props-atlas.png')
    palette_source = Image.new('RGB', (384, 128))
    for i, im in enumerate((bears, meadow, props)):
        palette_source.paste(im.convert('RGB').resize((128,128)), (128*i,0))
    palette = palette_source.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    pal = bytes(palette.getpalette()[:768])

    def indexed(im):
        return im.convert('RGB').quantize(palette=palette, dither=Image.Dither.NONE)

    def patch(im, width, height, left=None, top=None, ground=True):
        im = im.resize((width,height), Image.Resampling.LANCZOS)
        colors = indexed(im).tobytes()
        alpha = im.getchannel('A').tobytes()
        header = struct.pack('<hhhh', width, height, width//2 if left is None else left,
                             height if top is None and ground else (0 if top is None else top))
        columns = bytearray(); offsets = []
        for x in range(width):
            offsets.append(8+width*4+len(columns))
            y = 0
            while y < height:
                while y < height and alpha[y*width+x] < 180: y += 1
                if y == height: break
                start = y
                while y < height and alpha[y*width+x] >= 180 and y-start < 254: y += 1
                if start >= 255: raise ValueError('patch height must fit classic Doom posts')
                columns.extend((start, y-start, 0))
                columns.extend(colors[v*width+x] for v in range(start,y))
                columns.append(0)
            columns.append(255)
        return header + struct.pack(f'<{width}I', *offsets) + columns

    replacements = {}
    grass = cell(meadow,2,2,0,0)
    hedge = cell(meadow,2,2,1,0)
    sky = cell(meadow,2,2,0,1)
    vista = cell(meadow,2,2,1,1)
    for name, im in [('grass',grass),('hedge',hedge),('sky',sky),('meadow',vista)]:
        im.save(ART / f'{name}.png')
    replacements['FLOOR0_5'] = indexed(grass.resize((64,64))).tobytes()
    replacements['CEIL4_1'] = indexed(sky.resize((64,64))).tobytes()
    replacements['F_SKY1'] = indexed(sky.resize((64,64))).tobytes()
    for i in range(16):
        sprite = Image.open(ART / 'bear-no-bib-source.png').convert('RGBA') if i == 9 else cell(bears,4,4,i%4,i//4)
        sprite.save(ART / f'bear-{chr(65+i)}.png')
        # Walking bears grow 10%; seated guests shrink 10%, rounded to sprite pixels.
        # Keep each pose group consistent and the feet on the same ground.
        size = round(44 * 1.1) if i < 8 else round(40 * .9)
        replacements[f'SARG{chr(65+i)}0'] = patch(sprite,size,size)
    flower = cell(props,2,2,0,1)
    flower.save(ART/'flowers.png')
    replacements['COLUA0'] = patch(flower,27,29)
    toss = cell(props,2,2,0,0)
    hug = cell(props,2,2,1,0)
    honey = cell(props,2,2,1,1)
    for name,im in [('honey-tosser',toss),('hug-arms',hug),('honeycomb',honey)]: im.save(ART/f'{name}.png')
    # Doom psprite ready anchor is (1,32), not the screen center. Negative offsets place tools at the bottom center.
    # Keep the honey pose low enough that the atlas's cropped sleeve edges stay below the screen.
    for ch in 'ABCDE': replacements['PISG'+ch+'0'] = patch(toss,116,104,left=-102,top=-88)
    # Doom plays A-B-C-D-C-B-A for a hug. Reach in, squeeze, then release using
    # the existing textured arms; padded cuffs stay outside the moving view.
    arms = hug.resize((336,140), Image.Resampling.LANCZOS)
    # Spread the resting arms outward, then sweep inward for a visible shoulder squeeze.
    # Do not lift or cross the hands over the bear's face at the tightest pose.
    for ch, shear, lift in [('A',-.12,0),('B',.2,-6),('C',.4,-3),('D',.55,0)]:
        pose = Image.new('RGBA',(464,140))
        for side in (1,-1):
            arm = Image.new('RGBA',pose.size)
            if side == 1:
                arm.paste(arms.crop((0,0,168,140)),(64,0))
                arm.paste(arms.crop((0,0,1,140)).resize((64,140)),(0,0))
            else:
                arm.paste(arms.crop((168,0,336,140)),(232,0))
                arm.paste(arms.crop((335,0,336,140)).resize((64,140)),(400,0))
            arm = arm.transform(pose.size, Image.Transform.AFFINE,
                                (1,side*shear,side*shear*(lift-140),0,1,lift),
                                Image.Resampling.BICUBIC)
            pose.alpha_composite(arm)
        replacements['PUNG'+ch+'0'] = patch(pose,464,140,left=72,top=-80)
    # No muzzle flash, blood or impact smoke. Contact feedback comes from picnic sprites/UI.
    empty = Image.new('RGBA',(1,1))
    empty_patch = patch(empty,1,1)
    lumps = read_wad(BASE)
    for name,blob in lumps:
        if name.startswith(('BLUD','PUFF','PISF','BAL1','POSS','PLAY')) and name not in ('PLAYPAL',):
            replacements[name]=empty_patch
    # Doom selects palettes 1-8 while damagecount fades. Preserve the meadow
    # palette for the unused bonus/radiation slots, but restore its red hit flash.
    red_palettes = [bytes(round(value + ((255 if i % 3 == 0 else 0) - value) * level / 9)
                         for i, value in enumerate(pal)) for level in range(1,9)]
    replacements['PLAYPAL'] = pal + b''.join(red_palettes) + pal*5
    # Retain gentle depth shading and full-bright sky instead of dark dungeon colormaps.
    maps=[]
    for level in range(34):
        factor=1-min(level,31)/100
        shade=Image.new('RGB',(256,1));shade.putdata([tuple(round(pal[i*3+k]*factor) for k in range(3)) for i in range(256)])
        maps.append(indexed(shade).tobytes())
    replacements['COLORMAP']=b''.join(maps)
    # Preserve PNAMES / texture names expected by the Doom engine, redirect just their patches.
    pnames = dict(lumps)['PNAMES']
    patch_names = [pnames[i:i+8].rstrip(b'\0').decode() for i in range(4,len(pnames),8)]
    for key in ('HUGHEDGE','HUGSKY'):
        if key not in patch_names: patch_names.append(key)
    replacements['PNAMES'] = struct.pack('<I',len(patch_names))+b''.join(n8(x) for x in patch_names)
    replacements['HUGHEDGE'] = patch(hedge,128,128,left=0,top=0)
    sky_half = sky.resize((128,128), Image.Resampling.LANCZOS)
    sky_tile = Image.new('RGBA',(256,128)); sky_tile.paste(sky_half,(0,0)); sky_tile.paste(sky_half.transpose(Image.Transpose.FLIP_LEFT_RIGHT),(128,0))
    replacements['HUGSKY'] = patch(sky_tile,256,128,left=0,top=0)
    tex = dict(lumps)['TEXTURE1']; count=struct.unpack_from('<I',tex)[0]
    offsets=struct.unpack_from(f'<{count}I',tex,4); parts=[]
    for offset in offsets:
        name=tex[offset:offset+8].rstrip(b'\0').decode(); pc=struct.unpack_from('<H',tex,offset+20)[0]
        part=tex[offset:offset+22+10*pc]
        if name=='TANROCK2' or name.startswith('SKY'):
            pn='HUGHEDGE' if name=='TANROCK2' else 'HUGSKY'
            w=128 if name=='TANROCK2' else 256
            part=struct.pack('<8sIhhIH',n8(name),0,w,128,0,1)+struct.pack('<hhHhh',0,0,patch_names.index(pn),0,0)
        parts.append(part)
    pos=4+4*len(parts); offs=[]
    for part in parts: offs.append(pos);pos+=len(part)
    replacements['TEXTURE1']=struct.pack('<I',len(parts))+struct.pack(f'<{len(parts)}I',*offs)+b''.join(parts)
    # Open-air meadow: sky ceiling above a low hedge boundary. Identical floor/wall collision polygon.
    sectors=bytearray(dict(lumps)['SECTORS'])
    for i in range(0,len(sectors),26):
        struct.pack_into('<h',sectors,i+2,128)
        sectors[i+12:i+20]=n8('F_SKY1')
        struct.pack_into('<h',sectors,i+20,255)
    replacements['SECTORS']=bytes(sectors)
    out=[]; seen=set()
    for name,blob in lumps:
        if name.startswith('SARG'): continue
        if name=='S_END':
            for k,v in replacements.items():
                if k.startswith('SARG') or k=='COLUA0': out.append((k,v));seen.add(k)
        if name=='P_END':
            for k in ('HUGHEDGE','HUGSKY'): out.append((k,replacements[k]));seen.add(k)
        out.append((name,replacements.get(name,blob)));seen.add(name)
    for name,blob in replacements.items():
        if name not in seen: out.append((name,blob))
    body=bytearray(b'\0'*12); directory=bytearray()
    for name,blob in out:
        directory.extend(struct.pack('<II8s',len(body),len(blob),n8(name)));body.extend(blob)
    struct.pack_into('<4sII',body,0,b'IWAD',len(out),len(body));body.extend(directory)
    OUT.write_bytes(gzip.compress(body,compresslevel=9,mtime=0))
    manifest={'ruleset':'huggingdoom-v1','source':'Original generated PNG atlases, compiled with Pillow; legacy support lumps retain their existing licenses.', 'frames':{chr(65+i):s for i,s in enumerate(['waddle 1','waddle 2','waddle 3','waddle 4','lick lips','eager lick','cartoon chomp','impatient foot tap','honey catch','picnic eating','picnic chewing','reciprocal hug','peaceful heart','peaceful smile','emergency honey discovery','peaceful guest'])},'wadSHA256':hashlib.sha256(OUT.read_bytes()).hexdigest(),'assets':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ART.glob('*.png'))}}
    (ART/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(f'{OUT}: {len(out)} lumps, {len(body)} raw bytes, {OUT.stat().st_size} gzip bytes')

if __name__ == '__main__': main()
