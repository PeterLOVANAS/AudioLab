"""Deterministic synthetic R02B inputs; generated recordings/data are CC0.

No downloaded media, voices or research corpus. This is a test fixture, not an
alternate domain model: definitions and canonical v1 manifests pass the actual
application validators when the HTTP acceptance runner uses them.
"""
import hashlib
import json
import math
from pathlib import Path
import struct
import uuid
import wave
from generate_example_dataset import textgrid

OPTIONS = [{'id': 'steady', 'label': 'Steady tone'}, {'id': 'pulsed', 'label': 'Pulsed tone'}]
GROUND_INTERVALS = [[(1, 5)], [(3, 7)], [(1, 3), (5, 7)]]


def timeline(intervals, prefix='event'):
    """Create the existing timeline-answer shape without merging submitted events."""
    return {'tiers': {'events': [{'id': f'{prefix}-{i}', 'start': start, 'end': end, 'text': 'tone'}
                                 for i, (start, end) in enumerate(intervals)]}}


def binding(field, kind='string', **extra):
    return {'kind': 'dataset', 'fieldId': 'item.' + field, 'type': kind, **extra}


def ground_block(prefill=False):
    block = {'id': 'ground', 'type': 'timeline_annotation', 'label': 'Tone intervals',
             'required': False, 'groundingMode': 'sound',
             'tiers': [{'id': 'events', 'name': 'Events', 'kind': 'interval',
                        'labelMode': 'text', 'allowOverlap': True}],
             'sourceBindings': {'label': binding('ground_prompt')}}
    if prefill:
        block['sourceBindings']['value'] = binding('starter_intervals', 'textgrid', mode='prefill')
    return block


def draft(name, blocks):
    return {'name': name, 'description': 'R02B synthetic release acceptance', 'domain': 'sound',
            'instructions': 'Listen independently. These are generated test tones, not research ground truth.',
            'policy': {'requiredIndependentVotes': 3, 'blindToOthers': True, 'requiresReview': False},
            'blocks': blocks}


def scenarios():
    """Supported answer kinds, with deterministic independent worker submissions."""
    common = {'label': binding('prompt'), 'options': binding('category', 'choices')}
    return {
        'negation': {'blocks': [
            {'id': 'present', 'type': 'boolean', 'label': 'Is the tone present?', 'required': True},
            {'id': 'choice', 'type': 'single_choice', 'label': 'Sound category', 'required': True,
             'sourceBindings': common}],
            'answers': [{'present': i != 1, 'choice': OPTIONS[i % 2]['id']} for i in range(3)]},
        'grounding': {'blocks': [ground_block()],
                      'answers': [{'ground': timeline(value, str(i))} for i, value in enumerate(GROUND_INTERVALS)]},
        'grounding-multi': {'twoAudio': True, 'blocks': [{**ground_block(), 'numBatch': 2}],
            'answers': [{'ground': [timeline(GROUND_INTERVALS[i], str(i)), timeline([(0, 1)], 'second')]} for i in range(3)]},
        'grounding-empty-missing': {'blocks': [ground_block()],
            'answers': [{'ground': timeline([])}, {}, {'ground': timeline([(1, 5)])}]},
        'grounding-absence': {'blocks': [ground_block()],
            'answers': [{'ground': timeline([])} for _ in range(3)]},
        'speech': {'blocks': [
            {'id': 'transcript', 'type': 'transcript', 'label': 'Synthetic transcription', 'required': True,
             'sourceBindings': {'value': binding('starter_text', mode='prefill')}},
            {'id': 'note', 'type': 'text', 'label': 'Listening note', 'required': True}],
            'answers': [{'transcript': value, 'note': 'Independent note ' + str(i)}
                        for i, value in enumerate(['A synthetic tone.', 'A generated tone.', 'Tone only.'])]},
        'classification': {'blocks': [
            {'id': 'labels', 'type': 'multiple_choice', 'label': 'Audible labels', 'required': True,
             'minSelections': 1, 'sourceBindings': common}],
            'answers': [{'labels': ['steady']}, {'labels': ['steady', 'pulsed']}, {'labels': ['pulsed']}]},
        'preference': {'twoAudio': True, 'blocks': [
            {'id': 'rank-labels', 'type': 'ranking', 'label': 'Rank properties', 'required': True,
             'rankingMode': 'labels', 'rankingInput': 'arrows',
             'rankLabels': [{'id': 'clear', 'label': 'Clarity'}, {'id': 'warm', 'label': 'Warmth'}]},
            {'id': 'rank-audio', 'type': 'ranking', 'label': 'Rank recordings', 'required': True,
             'rankingMode': 'audios', 'rankingInput': 'arrows', 'stimulusSlots': ['First', 'Second']},
            {'id': 'compare', 'type': 'audio_comparison', 'label': 'Preferred recording', 'required': True,
             'numBatch': 2, 'comparisonSize': 2, 'stimulusSlots': ['First', 'Second'],
             'options': [{'id': 'left', 'label': 'First recording'}, {'id': 'right', 'label': 'Second recording'}]}],
            'answers': [{'rank-labels': ['warm', 'clear'] if i == 1 else ['clear', 'warm'],
                         'rank-audio': ['slot-1', 'slot-0'] if i == 1 else ['slot-0', 'slot-1'],
                         'compare': ['right' if i == 1 else 'left']} for i in range(3)]},
        'complex': {'blocks': [
            {'id': 'heading', 'type': 'section', 'label': 'Synthetic event notes', 'required': False},
            {'id': 'context', 'type': 'callout', 'label': 'Context', 'text': 'Generated audio only.', 'required': False},
            {'id': 'audio', 'type': 'audio_player', 'label': 'Listen to the recording', 'required': False},
            {'id': 'number', 'type': 'number', 'label': 'Count', 'required': True, 'min': 0, 'max': 20},
            {'id': 'rating', 'type': 'rating_scale', 'label': 'Confidence', 'required': True, 'min': 1, 'max': 5, 'step': 1},
            {'id': 'events', 'type': 'repeated_group', 'label': 'Event descriptions', 'required': True,
             'minItems': 1, 'maxItems': 3, 'itemLabel': 'Event', 'blocks': [
                 {'id': 'description', 'type': 'text', 'label': 'Event note', 'required': True},
                 {'id': 'position', 'type': 'number', 'label': 'Approximate second', 'required': True, 'min': 0, 'max': 10}]}],
            'answers': [{'number': i + 1, 'rating': i + 2,
                         'events': [{'id': 'independent-' + str(i), 'answers': {'description': 'Tone event ' + str(i), 'position': i + 1}}]}
                        for i in range(3)]},
        'preannotated': {'blocks': [ground_block(prefill=True)],
                        'answers': [{'ground': timeline([(0, 1)], str(i))} for i in range(3)]},
    }


def generate(directory):
    """Generate two exact 10-second PCM16 WAVs and one canonical-v1 manifest."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'audio').mkdir()
    records, hashes = [], {}
    for name, frequency in [('primary', 440), ('secondary', 660)]:
        file = directory / 'audio' / (name + '.wav')
        with wave.open(str(file), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(8000)
            audio.writeframes(b''.join(struct.pack('<h', int(3000 * math.sin(2 * math.pi * frequency * i / 8000))) for i in range(80000)))
        hashes[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
        def field(value, type='text', visibility='worker'):
            return {'type': type, 'visibility': visibility, 'value': value}
        records.append({'sample_id': name, 'audio_id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'audiolab.r02b/' + name)),
            'metadata': {'originalPath': file.name, 'license': 'CC0-1.0', 'private': 'R02B_PRIVATE_SOURCE'},
            'fields': {'instruction': field('Annotate this generated recording independently.')},
            'items': [{'item_id': 'listen', 'fields': {
                'prompt': field('Which kind of tone is audible?'), 'ground_prompt': field('Mark tone intervals'),
                'category': field(OPTIONS, 'choices'), 'starter_text': field('A synthetic recording.'),
                'starter_intervals': field(textgrid([(0, 1)], duration=10), 'textgrid'),
                'private_reference': field('R02B_PRIVATE_REFERENCE', visibility='admin'),
                'reference_intervals': field(textgrid([(1, 5)], duration=10), 'textgrid', 'admin')},
                'reference': {'field': 'category', 'value': 'steady'}}]})
    manifest = {'schema_version': 1, 'dataset_id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'audiolab.r02b/dataset')),
                'source_version': 'v1', 'provenance': {'origin': 'r02b-synthetic', 'revision': '1'}, 'records': records}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (directory / 'SHA256SUMS.json').write_text(json.dumps(hashes, indent=2))
    return manifest
