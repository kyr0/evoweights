"""Fail when public/engine/huggingdoom-engine-source.zip differs from the files it packages (stdlib only)."""
import sys
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
ZIP = ROOT / 'public/engine/huggingdoom-engine-source.zip'

stale = []
with ZipFile(ZIP) as archive:
    for name in archive.namelist():
        path = ROOT / name
        if not path.is_file() or path.read_bytes() != archive.read(name):
            stale.append(name)
if stale:
    print('engine source zip is stale for: ' + ', '.join(stale[:8]))
    print('fix: python3 scripts/package-engine-source.py && make build')
    sys.exit(1)
print(f'engine source zip matches {len(archive.namelist())} files')
