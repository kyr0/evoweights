HuggingDOOM — original procedural sound effects

All nine WAV files were synthesized for this project by
scripts/generate-picnic-sounds.py using Python's standard library. No samples,
recorded voices, music tracks, external sound libraries, or AI speech services
were used. The “mmmrrraww” effect is a synthetic formant-shaped bear murmur;
it is not a spoken recording.

Rebuild from the repository root:
  python3 scripts/generate-picnic-sounds.py

Format: mono PCM, 44,100 Hz, 16-bit signed samples. Each file peaks at roughly
32% full scale, before the page's 36% master volume. The master volume and
six-voice cap prevent unbounded stacking. Output loudness still depends on the
listener's device volume. The looping background music and the bite reactions
are separate MP3 files in ../gamemusic/; see ../PROVENANCE.md.

plop.wav        Soft descending honey bubble
empty-click.wav Rounded empty-thrower click
unfold.wav      Rising, gently wobbling soft-arm unfold
eating.wav      Three soft chewing pops
mmmrrraww.wav   Contented synthetic bear murmur
hug.wav         Warm ascending chime
chomp.wav       Two muffled cartoon mouth pops
dizzy.wav       Four small circling-star bells
finale.wav      Friendly emergency-honey reveal

manifest.json records sample formats, durations and SHA-256 hashes.
The generator is deterministic for the Python runtime used to build it;
transcendental-function rounding may differ across platforms.

These are original assets generated within this repository. They contain no
third-party samples. The repository's licensing terms apply; no separate
license grant for the repository is made by this file.
