#!/usr/bin/env python3
"""Extracción local optativa. No sube audio, no registra referencias ni identifica personas."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import uuid
import wave

MODEL = 'speechbrain/spkrec-ecapa-voxceleb'
REVISION = '0f99f2d0ebe89ac095bcc5903c4dd8f72b367286'
MODEL_VERSION = REVISION + ':sb1.1.2:pcm16-v1'
WEIGHTS_SHA256 = '0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2'


def read_audio(path):
    import numpy as np
    with wave.open(str(path)) as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('Se requiere WAV PCM16 mono de 16 kHz; no se selecciona un hablante de una mezcla.')
        if not 48000 <= w.getnframes() <= 240000:
            raise ValueError('Se requieren entre 3 y 15 segundos; duración no equivale a habla útil.')
        raw = w.readframes(w.getnframes())
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768
    if len(x) != w.getnframes():
        raise ValueError('Audio truncado.')
    frames = x[:len(x) // 320 * 320].reshape(-1, 320)
    active = float((np.sqrt(np.mean(frames ** 2, axis=1)) > 10 ** (-45 / 20)).sum() * .02)
    clipped = float(np.mean(np.abs(x) >= .999))
    if active < 3 or clipped > .01:
        raise ValueError('Audio insuficiente o saturado; hace falta otra muestra.')
    return x, {'duration_s': len(x) / 16000, 'energy_active_s': active, 'clipped_fraction': clipped,
               'speech_vad_validated': False, 'single_speaker_verified_by_model': False}


def extract(path, *, consent=False, single_speaker_reviewed=False, cache=None):
    if not consent or not single_speaker_reviewed:
        raise ValueError('Se requiere autorización para comparación vocal y revisión de un único hablante del canal llamante.')
    x, quality = read_audio(path)
    import torch
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import LocalEntryNotFoundError
    from speechbrain.lobes.features import Fbank
    from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN
    from speechbrain.processing.features import InputNormalization
    # Solo hacen falta los pesos de embedding: no descargar clasificador de nombres
    # ni ejecutar HyperPyYAML/Python remoto. Arquitectura de la revisión oficial fijada.
    options = dict(repo_id=MODEL, filename='embedding_model.ckpt', revision=REVISION, token=False, cache_dir=cache)
    try:
        weights = hf_hub_download(**options, local_files_only=True)
    except LocalEntryNotFoundError:
        weights = hf_hub_download(**options)
    with open(weights, 'rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != WEIGHTS_SHA256:
            raise ValueError('Checksum del modelo incorrecto.')
    torch.set_num_threads(4)
    features = Fbank(n_mels=80).eval()
    normalization = InputNormalization(norm_type='sentence', std_norm=False).eval()
    encoder = ECAPA_TDNN(input_size=80, channels=[1024, 1024, 1024, 1024, 3072],
        kernel_sizes=[5, 3, 3, 3, 1], dilations=[1, 2, 3, 4, 1], attention_channels=128, lin_neurons=192).eval()
    encoder.load_state_dict(torch.load(weights, map_location='cpu', weights_only=True), strict=True)
    started = time.monotonic()
    with torch.inference_mode():
        signal = torch.from_numpy(x).unsqueeze(0)
        vector = encoder(normalization(features(signal), torch.ones(1))).flatten().float()
    norm = float(torch.linalg.vector_norm(vector))
    if vector.numel() != 192 or not torch.isfinite(vector).all() or norm <= 0:
        raise ValueError('El extractor no produjo un embedding válido.')
    return {'model_id': MODEL, 'model_version': MODEL_VERSION, 'embedding': (vector / norm).tolist(),
            'channel': 'caller_only', 'single_speaker_reviewed': True, 'quality': quality,
            'inference_ms': round((time.monotonic() - started) * 1000),
            'identity_verified': False, 'reference_enabled': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wav', type=Path)
    parser.add_argument('--consent-voice-comparison', action='store_true')
    parser.add_argument('--reviewed-single-caller', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    result = extract(args.wav, consent=args.consent_voice_comparison, single_speaker_reviewed=args.reviewed_single_caller)
    destination = Path.home() / 'Library/Application Support/Tiskz/muestras-voz'
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = destination / (str(uuid.uuid4()) + '.json')
    with output.open('x') as f:
        json.dump(result, f, allow_nan=False)
    print(json.dumps({'file': str(output), 'dimensions': len(result['embedding']), 'model_version': MODEL_VERSION,
                      'inference_ms': result['inference_ms'], 'identity_verified': False, 'reference_enabled': False}))
