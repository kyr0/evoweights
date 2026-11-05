#!/usr/bin/env python3
"""Refresh the downloadable corresponding-source archive from the checked-in files."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/engine/huggingdoom-engine-source.zip'


def main():
    paths = list((ROOT / 'source/engine').rglob('*'))
    listed = [ROOT / p for p in (
        'scripts/build-huggingdoom-assets.py', 'scripts/package-engine-source.py',
        'src/engine/arena.ts', 'source/README.md',
        # The build scripts' compiler wrappers belong to the corresponding source (GPL v2 section 3).
        'source/toolchain/zig-cc', 'source/toolchain/zig-wasm-ld',
        'public/assets/huggingdoom/PROVENANCE.md',
        'public/assets/huggingdoom/PROMPTS.json',
        'public/assets/huggingdoom/bear-no-bib-source.png',
    )]
    missing = [p.relative_to(ROOT).as_posix() for p in listed if not p.is_file()]
    if missing:
        raise SystemExit('missing listed files: ' + ', '.join(missing))
    paths += listed
    paths += list((ROOT / 'tests/fixtures/legacy-engine').glob('*'))
    paths += list((ROOT / 'public/assets/huggingdoom').glob('*atlas.png'))
    with ZipFile(OUT, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(set(paths)):
            relative = path.relative_to(ROOT)
            if not path.is_file() or any(p in relative.parts for p in ('build', 'dist', '__pycache__')):
                continue
            info = ZipInfo(relative.as_posix(), (2026, 11, 5, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = (0o100755 if path.stat().st_mode & 0o111 else 0o100644) << 16
            archive.writestr(info, path.read_bytes())
    print(f'{OUT.name}: {OUT.stat().st_size} bytes')


if __name__ == '__main__':
    main()
