#!/usr/bin/env python3
"""Compara STT en sesiones Vapi aisladas; las grabaciones y resultados quedan fuera de Git."""
import argparse
import asyncio
from datetime import datetime
import json
import ipaddress
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.parse import urlsplit
import wave

import aiohttp
import yaml

ROOT = Path.home() / 'Library/Application Support/Tiskz/diagnosticos/20261018-033041'
PROVIDERS = {
    'scribe': {'provider': '11labs', 'model': 'scribe_v2_realtime', 'language': 'es',
               'silenceThresholdSeconds': .4, 'confidenceThreshold': .5, 'minSpeechDurationMs': 150, 'minSilenceDurationMs': 150},
    'nova3': {'provider': 'deepgram', 'model': 'nova-3', 'language': 'es-419',
              'endpointing': 300, 'confidenceThreshold': 0, 'smartFormat': False, 'numerals': False,
              'profanityFilter': False, 'mipOptOut': True},
    'flux': {'provider': 'deepgram', 'model': 'flux-general-multi', 'languages': ['es'],
             'eotThreshold': .7, 'eotTimeoutMs': 1000, 'confidenceThreshold': 0, 'mipOptOut': True},
    'soniox': {'provider': 'soniox', 'model': 'stt-rt-v5', 'languages': ['es'], 'languageHintsStrict': True,
               'maxEndpointDelayMs': 700, 'endpointLatencyAdjustmentLevel': 0, 'endpointSensitivity': 0},
    'soniox-balanced': {'provider': 'soniox', 'model': 'stt-rt-v5', 'languages': ['es'], 'languageHintsStrict': True,
                       'maxEndpointDelayMs': 500, 'endpointLatencyAdjustmentLevel': 1, 'endpointSensitivity': 0,
                       'confidenceThreshold': .4},
    'google': {'provider': 'google', 'model': 'gemini-2.5-flash', 'language': 'Spanish'},
}
PROVIDERS['soniox-peru'] = {
    **PROVIDERS['soniox'],
    'customVocabulary': ['Yape', 'Plin', 'BCP', 'SUNAT', 'soles'],
    'contextGeneral': [{'key': 'domain', 'value': 'Conversaciones telefónicas en español de Perú'}],
}
SYNTHETIC = {
    'negacion': 'No necesito dinero ni códigos. Solo quiero coordinar una reunión mañana a las cinco de la tarde.',
    'relato': 'Ayer me dijeron que mi familia estaba secuestrada. Era una grabación. No te estoy amenazando ni pidiendo dinero.',
    'cantidad': 'Necesito que me devuelvas cincuenta soles por Yape. No son quinientos, son cincuenta.',
}


class ApiResolver(aiohttp.abc.AbstractResolver):
    """Permite probar una IP resuelta del API sin cambiar el host TLS ni DNS del Mac."""
    def __init__(self, address):
        self.address = address
        self.default = aiohttp.resolver.DefaultResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        if host == 'api.vapi.ai' and self.address:
            return [{'hostname': host, 'host': self.address, 'port': port,
                     'family': socket.AF_INET, 'proto': 0, 'flags': 0}]
        return await self.default.resolve(host, port, family)

    async def close(self):
        await self.default.close()


def prepare(case, folder, cleaned):
    if case == 'real':
        return ROOT / ('llamante-limpieza-suave.wav' if cleaned else 'llamante.wav')
    aiff, wav = folder / (case + '.aiff'), folder / (case + '.wav')
    if not wav.exists():
        subprocess.run(['say', '-v', 'Paulina', '-r', '175', '-o', str(aiff), SYNTHETIC[case]], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-n', '-i', str(aiff), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(wav)], check=True)
    return wav


async def main(args):
    os.umask(0o077)
    folder = ROOT / ('motores-' + datetime.now().strftime('%H%M%S'))
    folder.mkdir(mode=0o700)
    cases = {case: prepare(case, folder, args.cleaned) for case in args.cases.split(',')}
    c = yaml.safe_load((Path.home() / '.vapi-cli.yaml').read_text())
    headers = {'Authorization': 'Bearer ' + c['accounts'][c['active_account']]['apikey'], 'User-Agent': 'vapi-cli/0.2.1'}
    sem = asyncio.Semaphore(args.concurrency)
    config = {'providers': {k: PROVIDERS[k] for k in args.providers.split(',')}, 'cases': list(cases),
              'krisp': True, 'fourier': False, 'cleaned_file': args.cleaned, 'reference_used_as_prompt': False,
              'provider_artifacts_disabled': True, 'pstn_tested': False}
    (folder / 'configuracion.json').write_text(json.dumps(config, indent=2))
    connector = aiohttp.TCPConnector(family=socket.AF_INET, resolver=ApiResolver(args.api_address))
    async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=40, connect=12, sock_connect=12), headers={'User-Agent': 'vapi-cli/0.2.1'}) as http:
        async def api(method, path, **kwargs):
            for attempt in range(3):
                try:
                    async with http.request(method, 'https://api.vapi.ai' + path, headers=headers, **kwargs) as r:
                        data = await r.json()
                        if r.status not in (200, 201):
                            raise RuntimeError('HTTP ' + str(r.status) + ': ' + str(data.get('message', ''))[:500])
                        return data
                except (aiohttp.ClientConnectorError, aiohttp.ConnectionTimeoutError):
                    # Solo reintentar si la conexión falló antes de enviar la petición.
                    # Un timeout de respuesta al crear una llamada tiene resultado incierto.
                    if attempt == 2:
                        raise
                    await asyncio.sleep(.25 * (attempt + 1))

        async def connect_audio(url):
            for attempt in range(2):
                try:
                    return await http.ws_connect(url, timeout=aiohttp.ClientWSTimeout(ws_close=2))
                except (aiohttp.ClientConnectorError, aiohttp.ConnectionTimeoutError):
                    # Todavía no se envió audio. Reusar la misma llamada, sin crear otra.
                    if attempt == 1:
                        raise
                    await asyncio.sleep(.5)

        async def run(provider, case):
            async with sem:
                source = cases[case]
                with wave.open(str(source)) as w:
                    assert w.getsampwidth() == 2 and w.getnchannels() == 1
                    rate, pcm = w.getframerate(), w.readframes(w.getnframes())
                transcriber = PROVIDERS[provider]
                assistant = {'name': 'Tiskz STT ' + provider, 'transcriber': transcriber,
                             'model': {'provider': 'openai', 'model': 'gpt-4.1-mini', 'maxTokens': 50,
                                       'messages': [{'role': 'system', 'content': 'Esta es una prueba de reconocimiento de voz. Responde únicamente «Entendido». No hagas preguntas ni uses herramientas.'}], 'tools': []},
                             'voice': {'provider': '11labs', 'model': 'eleven_flash_v2_5', 'voiceId': 'sarah'},
                             'firstMessageMode': 'assistant-waits-for-user', 'modelOutputInMessagesEnabled': True,
                             'backgroundSound': 'off', 'maxDurationSeconds': 65, 'silenceTimeoutSeconds': 50,
                             'backgroundSpeechDenoisingPlan': {'smartDenoisingPlan': {'enabled': True}, 'fourierDenoisingPlan': {'enabled': False}},
                             'clientMessages': ['transcript'], 'serverMessages': [],
                             'artifactPlan': {'recordingEnabled': False, 'loggingEnabled': False, 'pcapEnabled': False,
                                              'fullMessageHistoryEnabled': False, 'transcriptPlan': {'enabled': False}}}
                result = {'provider': provider, 'case': case, 'transcriber': transcriber, 'file': source.name,
                          'duration_s': len(pcm) / (rate * 2), 'events': [], 'text': '', 'error': None}
                call, sent_end = None, None
                print(json.dumps({'stage': 'starting', 'provider': provider, 'case': case}), flush=True)
                try:
                    call = await api('POST', '/call', json={'assistant': assistant, 'transport': {
                        'provider': 'vapi.websocket', 'audioFormat': {'format': 'pcm_s16le', 'container': 'raw', 'sampleRate': rate}}})
                    result['call_id'] = call['id']
                    url = call['transport']['websocketCallUrl']; u = urlsplit(url)
                    assert u.scheme == 'wss' and u.hostname.endswith('.vapi.ai') and u.path == '/' + call['id'] + '/transport' and not u.query
                    result['audio_host'] = u.hostname
                    print(json.dumps({'stage': 'connecting_audio', 'provider': provider, 'case': case, 'audio_host': u.hostname}), flush=True)
                    async with await connect_audio(url) as ws:
                        start = time.monotonic()
                        async def receive():
                            async for msg in ws:
                                if msg.type == aiohttp.WSMsgType.TEXT:
                                    e = json.loads(msg.data)
                                    if e.get('type') == 'transcript' and e.get('role') == 'user':
                                        item = {'at_s': round(time.monotonic() - start, 3), 'type': e.get('transcriptType'), 'text': e.get('transcript', '')}
                                        result['events'].append(item)
                                        # Guardar progreso aunque falle una petición de cierre.
                                        with (folder / (provider + '-' + case + '-eventos.jsonl')).open('a') as out:
                                            out.write(json.dumps(item, ensure_ascii=False) + '\n')
                        rx = asyncio.create_task(receive())
                        try:
                            size = rate // 50 * 2
                            for offset in range(0, len(pcm), size):
                                await asyncio.sleep(max(0, start + offset / (rate * 2) - time.monotonic()))
                                await ws.send_bytes(pcm[offset:offset + size])
                            sent_end = len(pcm) / (rate * 2)
                            for _ in range(400):
                                if ws.closed:
                                    break
                                await ws.send_bytes(bytes(size)); await asyncio.sleep(.02)
                        finally:
                            rx.cancel()
                            await asyncio.wait([rx], timeout=3)
                except Exception as e:
                    result['error'] = str(e) if isinstance(e, (RuntimeError, AssertionError)) else type(e).__name__
                finally:
                    if call:
                        try:
                            state = await api('GET', '/call/' + call['id'])
                            control = state.get('monitor', {}).get('controlUrl', ''); u = urlsplit(control)
                            if state.get('status') != 'ended' and u.scheme == 'https' and u.hostname.endswith('.vapi.ai') and u.path == '/' + call['id'] + '/control' and not u.query:
                                async with http.post(control, json={'type': 'end-call'}) as r:
                                    pass
                        except Exception:
                            result['cleanup_requires_verification'] = True
                finals = [e for e in result['events'] if e['type'] == 'final']
                result['text'] = '\n'.join(e['text'] for e in finals)
                result['last_final_after_file_end_ms'] = round((finals[-1]['at_s'] - sent_end) * 1000) if finals and sent_end is not None else None
                (folder / (provider + '-' + case + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2))
                (folder / (provider + '-' + case + '.txt')).write_text(result['text'] + '\n')
                print(json.dumps({k: result.get(k) for k in ['provider', 'case', 'text', 'error', 'last_final_after_file_end_ms']}, ensure_ascii=False), flush=True)
                return result

        results = await asyncio.gather(*(run(provider, case) for provider in args.providers.split(',') for case in cases))
        (folder / 'resultados.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(json.dumps({'folder': str(folder), 'finished': True}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--providers', default='scribe,nova3,flux,soniox')
    parser.add_argument('--cases', default='real')
    parser.add_argument('--cleaned', action='store_true')
    parser.add_argument('--concurrency', type=int, choices=[1, 2], default=2)
    parser.add_argument('--api-address', type=lambda value: str(ipaddress.IPv4Address(value)),
                        help='IP previamente resuelta de api.vapi.ai para diagnosticar un nodo inaccesible; conserva TLS y Host.')
    args = parser.parse_args()
    if any(k not in PROVIDERS for k in args.providers.split(',')) or any(k not in ['real', *SYNTHETIC] for k in args.cases.split(',')):
        parser.error('Proveedor o caso desconocido')
    asyncio.run(main(args))
