#!/usr/bin/env python3
"""Rebuild HuggingDOOM's original, deterministic PCM sound effects with Python's stdlib."""

import argparse
import hashlib
import json
import math
import random
import struct
import wave
from pathlib import Path

RATE = 44100
TAU = math.tau
DESTINATION = Path(__file__).resolve().parents[1] / 'public/assets/huggingdoom/sounds'


def envelope(t, duration, attack=0.014, release=0.08):
    if t < 0 or t >= duration:
        return 0.0
    return min(1.0, t / attack) * min(1.0, (duration - t) / release)


def tone(t, frequency, duration, decay=3.0):
    return (math.sin(TAU * frequency * t) + 0.18 * math.sin(TAU * frequency * 2 * t)) * envelope(t, duration) * math.exp(-decay * t)


def bell(t, frequency, duration):
    return (math.sin(TAU * frequency * t) * math.exp(-4 * t)
            + 0.16 * math.sin(TAU * frequency * 2.01 * t) * math.exp(-9 * t)) * envelope(t, duration, 0.008, 0.14)


def make(name, duration, sample):
    rng = random.Random(20261105)
    values = [sample(i / RATE, rng) for i in range(round(duration * RATE))]
    # Remove any DC offset; a short fade also guarantees quiet endpoints.
    mean = sum(values) / len(values)
    values = [(value - mean) * envelope(i / RATE, duration, 0.004, 0.025) for i, value in enumerate(values)]
    peak = max(abs(value) for value in values) or 1.0
    gain = 0.32 / peak
    pcm = b''.join(struct.pack('<h', round(value * gain * 32767)) for value in values)
    destination = DESTINATION / (name + '.wav')
    with wave.open(str(destination), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm)
    return {'file': destination.name, 'seconds': duration, 'sampleRate': RATE,
            'channels': 1, 'bitsPerSample': 16,
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}


def plop(t, _rng):
    # A descending rounded bubble, with a tiny honey droplet after it.
    phase = TAU * (150 * t + 52 * (1 - math.exp(-18 * t)))
    return math.sin(phase) * math.exp(-14 * t) * envelope(t, 0.42, 0.006, 0.08) + 0.22 * tone(t - 0.13, 420, 0.22, 15)


def click(t, _rng):
    return tone(t, 680, 0.11, 46) + 0.35 * tone(t - 0.025, 340, 0.09, 45)


def unfold(t, _rng):
    phase = TAU * (130 * t + 240 * t * t)
    return math.sin(phase) * envelope(t, 0.65, 0.08, 0.23) * (0.55 + 0.18 * math.sin(TAU * 9 * t))


def eating(t, rng):
    result = 0.0
    for start, frequency in [(0.0, 270), (0.21, 350), (0.43, 310)]:
        local = t - start
        if 0 <= local < 0.18:
            result += tone(local, frequency, 0.18, 18) + rng.uniform(-0.10, 0.10) * envelope(local, 0.1) * math.exp(-23 * local)
    return result


def mmmrrraww(t, _rng):
    # Formant-weighted harmonics of a gently wavering low tone. This is a
    # synthetic bear murmur, not a human recording or intelligible speech.
    duration = 1.25
    frequency = 112 + 16 * math.sin(math.pi * t / duration)
    phase = TAU * (frequency * t + 0.23 * math.sin(TAU * 4.2 * t))
    vowel = math.sin(math.pi * min(1.0, t / 0.9)) ** 2
    result = 0.0
    for harmonic in range(1, 15):
        hz = harmonic * frequency
        formant = math.exp(-((hz - (280 + 380 * vowel)) / 220) ** 2)
        result += (0.11 / harmonic + 0.18 * formant / math.sqrt(harmonic)) * math.sin(phase * harmonic)
    return result * envelope(t, duration, 0.13, 0.35)


def hug(t, _rng):
    return sum(0.8 * bell(t - delay, frequency, 0.9) for delay, frequency in [(0, 523.25), (0.10, 659.25), (0.20, 783.99)])


def chomp(t, _rng):
    # Two soft mouth pops, without a sharp impact or scary growl.
    return tone(t, 185, 0.19, 16) + 0.8 * tone(t - 0.075, 125, 0.24, 12)


def dizzy(t, _rng):
    return sum(bell(t - delay, frequency, 0.5) for delay, frequency in [(0, 880), (0.17, 1046.5), (0.34, 987.77), (0.51, 783.99)])


def finale(t, _rng):
    return sum(bell(t - delay, frequency, 1.1) for delay, frequency in [(0, 392), (0.16, 493.88), (0.32, 587.33), (0.58, 783.99)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    DESTINATION.mkdir(parents=True, exist_ok=True)
    sounds = [make(name, seconds, synth) for name, seconds, synth in [
        ('plop', 0.42, plop), ('empty-click', 0.16, click), ('unfold', 0.65, unfold),
        ('eating', 0.72, eating), ('mmmrrraww', 1.25, mmmrrraww), ('hug', 1.2, hug),
        ('chomp', 0.4, chomp), ('dizzy', 1.1, dizzy), ('finale', 1.85, finale),
    ]]
    (DESTINATION / 'manifest.json').write_text(json.dumps({'generator': 'scripts/generate-picnic-sounds.py', 'sounds': sounds}, indent=2) + '\n')
    print(f'Wrote {len(sounds)} original sounds to {DESTINATION}')


if __name__ == '__main__':
    main()
