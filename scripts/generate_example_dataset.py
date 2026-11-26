#!/usr/bin/env python3
"""Generate the redistributable synthetic canonical-v1 example, with no downloads.

Refuses an existing output directory. UUIDs are deterministic planned aliases,
not real project/user identities. The importer materializes actual asset IDs.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import uuid
import wave


def textgrid(intervals, duration=4):
    """Praat long-text IntervalTier; silence is explicit between tone regions."""
    regions = []
    position = 0
    for start, end in intervals:
        if start > position:
            regions.append((position, start, ''))
        regions.append((start, end, 'tone'))
        position = end
    if position < duration:
        regions.append((position, duration, ''))
    header = f'''File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = {duration}
tiers? <exists>
size = 1
item []:
item [1]:
class = "IntervalTier"
name = "Events"
xmin = 0
xmax = {duration}
intervals: size = {len(regions)}
'''
    return header + ''.join(f'intervals [{i}]:\nxmin = {start}\nxmax = {end}\ntext = "{label}"\n'
                            for i, (start, end, label) in enumerate(regions, 1))


def generate(output):
    output.mkdir(parents=True, exist_ok=False)
    (output / 'audio').mkdir()
    records, hashes = [], {}
    for name, frequency, intervals, answer in [
        ('steady-tone', 440, [(1, 3)], 'steady'),
        ('pulsed-tone', 660, [(0.5, 1.5), (2.5, 3.5)], 'pulsed'),
    ]:
        relative = name + '.wav'
        file = output / 'audio' / relative
        rate = 8000
        frames = []
        for index in range(rate * 4):
            time = index / rate
            on = any(start <= time < end for start, end in intervals)
            # Mathematical tone only; no recording, voice, sampled media or model asset.
            frames.append(struct.pack('<h', int(5000 * math.sin(2 * math.pi * frequency * time)) if on else 0))
        with wave.open(str(file), 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
            wav.writeframes(b''.join(frames))
        hashes[relative] = hashlib.sha256(file.read_bytes()).hexdigest()
        records.append({'sample_id': name, 'audio_id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'audiolab.synthetic/1/' + name)),
            'metadata': {'originalPath': relative, 'durationSeconds': 4, 'license': 'CC0-1.0', 'generator': 'generate_example_dataset.py'},
            'fields': {'instruction': {'type': 'text', 'visibility': 'worker', 'value': 'Listen and annotate the synthetic tone.'},
                       'frequency_hz': {'type': 'number', 'visibility': 'admin', 'value': frequency}},
            'items': [{'item_id': 'listen', 'fields': {
                'prompt': {'type': 'text', 'visibility': 'worker', 'value': 'Is the tone steady or pulsed? Mark its audible intervals in a grounding task.'},
                'category': {'type': 'choices', 'visibility': 'worker', 'value': [{'id': 'steady', 'label': 'Steady tone'}, {'id': 'pulsed', 'label': 'Pulsed tone'}]},
                'alignment': {'type': 'textgrid', 'visibility': 'admin', 'value': textgrid(intervals)}},
                'reference': {'field': 'category', 'value': answer}}]})
    manifest = {'schema_version': 1, 'dataset_id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'audiolab.synthetic/1/dataset')),
                'source_version': 'v1', 'provenance': {'origin': 'synthetic-tones', 'revision': 'generator-v1'}, 'records': records}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'SHA256SUMS.json').write_text(json.dumps(hashes, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    generate(args.output)
    print('Generated two synthetic PCM16 WAVs and a canonical v1 manifest:', args.output)
