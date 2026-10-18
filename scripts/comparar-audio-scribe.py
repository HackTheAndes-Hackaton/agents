#!/usr/bin/env python3
"""Reproduce dos WAV autorizados en sesiones aisladas con el mismo Scribe de Vapi."""
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import time
from urllib.parse import urlsplit
import wave

import aiohttp
import yaml

FOLDER = Path.home() / 'Library/Application Support/Tiskz/diagnosticos/20261018-033041'
ASSISTANT = '2bccff10-dfc6-4ea4-a235-f254830111f4'


async def main():
    os.umask(0o077)
    account = yaml.safe_load((Path.home() / '.vapi-cli.yaml').read_text())
    headers = {'Authorization': 'Bearer ' + account['accounts'][account['active_account']]['apikey'],
               'User-Agent': 'vapi-cli/0.2.1'}
    run_folder = FOLDER / ('comparacion-scribe-' + datetime.now().strftime('%H%M%S'))
    run_folder.mkdir(mode=0o700)
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(family=socket.AF_INET),
                                    timeout=aiohttp.ClientTimeout(total=20),
                                    headers={'User-Agent': 'vapi-cli/0.2.1'}) as http:
        async def api(method, path, **kwargs):
            async with http.request(method, 'https://api.vapi.ai' + path, headers=headers, **kwargs) as r:
                if r.status not in (200, 201):
                    detail = await r.json()
                    raise RuntimeError('Vapi HTTP ' + str(r.status) + ': ' + str(detail.get('message', ''))[:800])
                return await r.json()

        production = await api('GET', '/assistant/' + ASSISTANT)
        transcriber = production['transcriber']
        settings = {'transcriber': transcriber, 'language': 'es', 'input_processing': 'none',
                    'stream_pacing': 'realtime', 'provider_artifacts_disabled': True,
                    'note': 'Replay through WebSocket, not a new telephone conference. No manual reference provided.'}
        (run_folder / 'configuracion.json').write_text(json.dumps(settings, ensure_ascii=False, indent=2))

        async def transcribe(label, name):
            path = FOLDER / name
            with wave.open(str(path)) as w:
                assert w.getnchannels() == 1 and w.getsampwidth() == 2
                rate = w.getframerate()
                pcm = w.readframes(w.getnframes())
            assistant = {
                'name': 'Tiskz ASR aislado ' + label,
                'transcriber': transcriber,
                'model': {'provider': 'openai', 'model': 'gpt-4.1-mini', 'maxTokens': 50,
                          'messages': [{'role': 'system', 'content': 'Esta sesión solo comprueba el reconocimiento de voz. Responde únicamente «Entendido». No hagas preguntas ni uses herramientas.'}],
                          'tools': []},
                'voice': {'provider': '11labs', 'voiceId': 'sarah', 'model': 'eleven_flash_v2_5'},
                'firstMessageMode': 'assistant-waits-for-user',
                'maxDurationSeconds': 60, 'silenceTimeoutSeconds': 45,
                'backgroundSound': 'off',
                'backgroundSpeechDenoisingPlan': {'smartDenoisingPlan': {'enabled': False}, 'fourierDenoisingPlan': {'enabled': False}},
                'clientMessages': ['transcript'], 'serverMessages': [],
                'artifactPlan': {'recordingEnabled': False, 'loggingEnabled': False,
                                 'pcapEnabled': False, 'fullMessageHistoryEnabled': False,
                                 'transcriptPlan': {'enabled': False}},
            }
            events, call, failure = [], None, None
            started = time.monotonic()
            print(json.dumps({'stage': 'starting', 'variant': label}), flush=True)
            try:
                call = await api('POST', '/call', json={'assistant': assistant, 'transport': {
                    'provider': 'vapi.websocket', 'audioFormat': {'format': 'pcm_s16le', 'container': 'raw', 'sampleRate': rate}}})
                url = call['transport']['websocketCallUrl']
                u = urlsplit(url)
                if not (u.scheme == 'wss' and u.hostname and u.hostname.endswith('.vapi.ai') and not u.query and u.path == '/' + call['id'] + '/transport'):
                    raise ValueError('Transporte no válido')
                async with http.ws_connect(url) as ws:
                    async def receive():
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                continue  # La voz generada jamás se devuelve al transcriptor.
                            event = json.loads(msg.data)
                            if event.get('type') == 'transcript' and event.get('role') == 'user':
                                events.append({'received_seconds': round(time.monotonic() - started, 3),
                                               'transcriptType': event.get('transcriptType'), 'text': event.get('transcript', '')})
                    rx = asyncio.create_task(receive())
                    try:
                        # Enviar a velocidad real y conservar los silencios del archivo.
                        size = rate // 50 * 2
                        start_send = time.monotonic()
                        for offset in range(0, len(pcm), size):
                            await asyncio.sleep(max(0, start_send + offset / (rate * 2) - time.monotonic()))
                            await ws.send_bytes(pcm[offset:offset + size])
                        for _ in range(350):
                            if ws.closed:
                                break
                            await ws.send_bytes(bytes(size))
                            await asyncio.sleep(.02)
                    finally:
                        rx.cancel()
                        await asyncio.gather(rx, return_exceptions=True)
            except Exception as e:
                failure = type(e).__name__ + (': ' + str(e) if isinstance(e, (RuntimeError, ValueError)) else '')
            finally:
                if call:
                    try:
                        state = await api('GET', '/call/' + call['id'])
                        control = state.get('monitor', {}).get('controlUrl', '')
                        u = urlsplit(control)
                        if (state.get('status') != 'ended' and u.scheme == 'https' and u.hostname
                                and u.hostname.endswith('.vapi.ai') and not u.query and u.path == '/' + call['id'] + '/control'):
                            async with http.post(control, json={'type': 'end-call'}) as r:
                                pass
                    except Exception:
                        failure = failure or 'cleanup_not_confirmed'
            finals = [e['text'] for e in events if e['transcriptType'] == 'final']
            result = {'variant': label, 'source': name, 'transcriber': transcriber,
                      'audio_seconds': len(pcm) / (rate * 2), 'sample_rate': rate,
                      'call_id': call['id'] if call else None,
                      'text': '\n'.join(finals), 'final_segments': len(finals), 'events': events, 'error': failure}
            (run_folder / (label + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2))
            (run_folder / (label + '.txt')).write_text(result['text'] + '\n')
            print(json.dumps({k: result[k] for k in ('variant', 'text', 'final_segments', 'error')}, ensure_ascii=False), flush=True)
            return result

        # Mismo motor, mismo idioma, mismo PCM y ritmo; únicamente cambia la limpieza del archivo.
        results = await asyncio.gather(transcribe('original', 'llamante.wav'),
                                       transcribe('limpieza', 'llamante-limpieza-suave.wav'))
        (run_folder / 'resultados.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(json.dumps({'folder': str(run_folder), 'finished': True}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
