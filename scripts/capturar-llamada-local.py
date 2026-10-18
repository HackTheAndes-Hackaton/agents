#!/usr/bin/env python3
"""Captura manual y acotada de UNA prueba autorizada; no cambia Vapi ni la APK."""
import argparse
import asyncio
from collections import deque
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import signal
import socket
import struct
import time
from urllib.parse import urlsplit
import wave

import aiohttp
import yaml

ROOT = Path(__file__).resolve().parent.parent
BASE = 'https://api.maritime.sh/a/ebf0eb81-42c0-4437-a044-1af84af1b755'
ASSISTANT = '2bccff10-dfc6-4ea4-a235-f254830111f4'
PHONE = '272961c5-1a2e-4000-bb4c-c12fd19c041e'
EVENTS = {'transcript.update', 'assessment.update', 'risk.update', 'alert.updated',
          'understanding.update', 'call.ready_to_answer', 'agent.status',
          'call.hangup_requested', 'call.hangup_result', 'call.ended', 'phone.call'}


def socket_url(value, call_id):
    u = urlsplit(value or '')
    if (u.scheme != 'wss' or not u.hostname or not u.hostname.endswith('.vapi.ai')
            or u.username or u.password or u.query or u.fragment or u.port
            or u.path != '/' + call_id + '/listen'):
        raise ValueError('URL de escucha no válida')
    return value


def audio_stats(data):
    values = struct.unpack('<' + 'h' * (len(data) // 2), data)
    if not values:
        return {}
    rms = math.sqrt(sum(v * v for v in values) / len(values))
    return {'samples': len(values), 'rms_dbfs': round(20 * math.log10(max(rms, .032768) / 32768), 2),
            'peak': max(abs(v) for v in values),
            'clipped_samples': sum(abs(v) >= 32760 for v in values),
            'zero_samples': sum(v == 0 for v in values)}


class AudioFiles:
    def __init__(self, folder, start):
        rate, channels = start.get('sampleRate'), start.get('channels')
        if (start.get('encoding') != 'linear16' or start.get('container') != 'raw'
                or rate not in (8000, 16000, 24000, 44100, 48000) or channels != 2):
            raise ValueError('Formato de audio no compatible; no se supondrá su frecuencia')
        self.rate, self.channels, self.tail, self.frames = rate, channels, b'', 0
        self.files = []
        for name, count in [('vapi-estereo.wav', 2), ('llamante.wav', 1), ('agente.wav', 1)]:
            w = wave.open(str(folder / name), 'wb')
            w.setnchannels(count)
            w.setsampwidth(2)
            w.setframerate(rate)
            self.files.append(w)

    def write(self, raw):
        raw = self.tail + raw
        end = len(raw) - len(raw) % 4
        data, self.tail = raw[:end], raw[end:]
        if not data:
            return None
        words = struct.unpack('<' + 'h' * (len(data) // 2), data)
        caller = struct.pack('<' + 'h' * (len(words) // 2), *words[::2])
        agent = struct.pack('<' + 'h' * (len(words) // 2), *words[1::2])
        self.files[0].writeframesraw(data)
        self.files[1].writeframesraw(caller)
        self.files[2].writeframesraw(agent)
        at = self.frames / self.rate
        self.frames += len(data) // 4
        return {'audio_offset_s': round(at, 4), 'bytes': len(data),
                'caller': audio_stats(caller), 'agent': audio_stats(agent)}

    def close(self):
        for w in self.files:
            w.close()


async def main(args):
    os.umask(0o077)
    c = yaml.safe_load((Path.home() / '.vapi-cli.yaml').read_text())
    headers = {'Authorization': 'Bearer ' + c['accounts'][c['active_account']]['apikey'],
               'User-Agent': 'vapi-cli/0.2.1'}
    access = json.loads((ROOT / '.maritime/live-trial-20261018/previous-runtime-private.json').read_text())['VOICE_ACCESS_CODE']
    deadline = time.monotonic() + args.wait_seconds
    folder = Path.home() / 'Library/Application Support/Tiskz/diagnosticos' / datetime.now().strftime('%Y%m%d-%H%M%S')
    folder.mkdir(parents=True, mode=0o700)
    event_file = (folder / 'eventos-apk.jsonl').open('x')
    text_file = (folder / 'transcripcion.log').open('x')
    frames_file = (folder / 'audio-frames.jsonl').open('x')
    metadata = {'created_at': datetime.now(timezone.utc).isoformat(), 'status': 'starting',
                'synthetic_probe': bool(args.call_id),
                'scope': 'one_authorized_test_call', 'max_audio_seconds': args.max_seconds,
                'audio_source': 'Vapi listen monitor; not a guaranteed tap after STT preprocessing',
                'channel_mapping': {'0': 'caller', '1': 'assistant'},
                'audio_processing_applied_locally': False, 'events_source': 'same backend channel used by APK',
                'provider_recording_enabled_by_this_script': False}
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    target = None
    buffered = deque(maxlen=300)
    announced_call = None
    announced = asyncio.Event()
    audio = None
    monitor = None
    monitor_task = None

    def save_meta():
        (folder / 'resumen.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))

    def write_event(e, received):
        if e.get('type') not in EVENTS or e.get('session_id') != target:
            return
        event_file.write(json.dumps({'received_at_ms': received, 'event': e}, ensure_ascii=False) + '\n')
        event_file.flush()
        if e.get('type') == 'transcript.update':
            text_file.write(json.dumps({k: e.get(k) for k in ('speaker', 'text', 'id', 'sequence', 'final', 'source', 'server_sent_at_ms')}, ensure_ascii=False) + '\n')
            text_file.flush()

    timeout = aiohttp.ClientTimeout(total=10, connect=5)
    connector = aiohttp.TCPConnector(family=socket.AF_INET)
    async with aiohttp.ClientSession(headers={'User-Agent': 'vapi-cli/0.2.1'}, timeout=timeout, connector=connector) as http:
        async def api(path):
            for attempt in range(3):
                try:
                    async with http.get('https://api.vapi.ai' + path, headers=headers) as r:
                        if r.status == 429 or r.status >= 500:
                            raise aiohttp.ClientConnectionError('Respuesta temporal del proveedor')
                        if r.status != 200:
                            raise RuntimeError('Vapi HTTP ' + str(r.status))
                        return await r.json()
                except (asyncio.TimeoutError, aiohttp.ClientConnectionError):
                    metadata['network_retries'] = metadata.get('network_retries', 0) + 1
                    save_meta()
                    if attempt == 2:
                        raise
                    await asyncio.sleep(.5 * (attempt + 1))

        async def read_monitor():
            nonlocal announced_call
            async for msg in monitor:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    e = json.loads(msg.data)
                    received = round(time.time() * 1000)
                    if e.get('type') == 'phone.call' and e.get('call_id'):
                        announced_call = e['call_id']
                        announced.set()
                    if target:
                        write_event(e, received)
                    elif e.get('type') in EVENTS:
                        buffered.append((e, received))

        try:
            if not args.call_id:
                current = await api('/call?limit=10')
                existing = {x['id'] for x in current}
                async with http.post(BASE + '/v1/phone/monitor', headers={'X-Voice-Token': access},
                        json={'consentimiento_analisis': True, 'consentimiento_corte_automatico': False}) as r:
                    if r.status != 201:
                        raise RuntimeError('No se pudo abrir observador: HTTP ' + str(r.status))
                    ticket = (await r.json())['ticket']
                monitor = await http.ws_connect(BASE.replace('https:', 'wss:') + '/ws/calls?channel=phone', params={'ticket': ticket})
                monitor_task = asyncio.create_task(read_monitor())
                metadata['status'] = 'armed'
                save_meta()
                print(json.dumps({'status': 'armed', 'folder': str(folder), 'wait_seconds': args.wait_seconds}), flush=True)
                while not stop.is_set() and time.monotonic() < deadline:
                    if announced_call:
                        try:
                            call = await api('/call/' + announced_call)
                            if (call.get('assistantId') == ASSISTANT and call.get('phoneNumberId') == PHONE
                                    and call.get('status') != 'ended'):
                                break
                            announced_call = None
                            announced.clear()
                        except (asyncio.TimeoutError, aiohttp.ClientConnectionError):
                            continue
                    poll = asyncio.create_task(api('/call?limit=10'))
                    notification = asyncio.create_task(announced.wait())
                    done, pending = await asyncio.wait([poll, notification], return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    if notification in done and announced_call:
                        # Preferir el evento real de llamada a esperar el siguiente sondeo.
                        if poll in done:
                            await asyncio.gather(poll, return_exceptions=True)
                        continue
                    try:
                        calls = poll.result()
                    except (asyncio.TimeoutError, aiohttp.ClientConnectionError):
                        # Un timeout temporal NO debe desarmar la captura.
                        continue
                    call = next((x for x in calls if x['id'] not in existing and x.get('assistantId') == ASSISTANT
                                 and x.get('phoneNumberId') == PHONE and x.get('status') in ('ringing', 'in-progress')), None)
                    if call:
                        break
                    try:
                        await asyncio.wait_for(announced.wait(), timeout=1.5)
                    except asyncio.TimeoutError:
                        pass
                else:
                    metadata['status'] = 'no_test_call'
                    return
            else:
                call = await api('/call/' + args.call_id)
                if call.get('assistantId') != 'e699fb7d-b814-4eae-8948-da1e60477484':
                    raise ValueError('El modo call-id está limitado al asistente de pruebas sintéticas')
            target = call['id']
            for e, received in buffered:
                write_event(e, received)
            buffered.clear()
            metadata.update(call_id=target, provider_started_at=call.get('startedAt'),
                            captured_at=datetime.now(timezone.utc).isoformat(), status='capturing')
            save_meta()
            print(json.dumps({'status': 'capturing', 'call_id': target}), flush=True)
            async with http.ws_connect(socket_url(call.get('monitor', {}).get('listenUrl'), target), max_msg_size=1048576) as listen:
                until = time.monotonic() + args.max_seconds
                while not stop.is_set() and time.monotonic() < until:
                    try:
                        msg = await listen.receive(timeout=2)
                    except asyncio.TimeoutError:
                        try:
                            current = await api('/call/' + target)
                        except (asyncio.TimeoutError, aiohttp.ClientConnectionError):
                            continue
                        if current.get('status') == 'ended':
                            break
                        continue
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        e = json.loads(msg.data)
                        if e.get('type') == 'start' and audio is None:
                            audio = AudioFiles(folder, e)
                            metadata['audio_format'] = {k: e.get(k) for k in ('encoding', 'container', 'sampleRate', 'channels')}
                            metadata['audio_capture_start_ms'] = round(time.time() * 1000)
                            save_meta()
                        elif e.get('type') == 'transcript':
                            # Present only if provider exposes transcript events on this monitor.
                            with (folder / 'eventos-vapi.jsonl').open('a') as out:
                                out.write(json.dumps({'received_at_ms': round(time.time()*1000), 'event': e}, ensure_ascii=False)+'\n')
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        if audio is None:
                            raise RuntimeError('Audio recibido sin descriptor start; no se supondrá el formato')
                        stat = audio.write(msg.data)
                        if stat:
                            stat['received_at_ms'] = round(time.time() * 1000)
                            frames_file.write(json.dumps(stat) + '\n')
                            frames_file.flush()
                        if audio.frames >= audio.rate * args.max_seconds:
                            break
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                        break
            await asyncio.sleep(2)
            metadata['status'] = 'captured' if audio and audio.frames else 'no_audio_captured'
        except Exception as e:
            metadata.update(status='failed', error=type(e).__name__, http_status=getattr(e, 'status', None))
        finally:
            if audio:
                metadata['audio_seconds'] = round(audio.frames / audio.rate, 3)
                metadata['discarded_trailing_bytes'] = len(audio.tail)
                audio.close()
            if monitor_task:
                monitor_task.cancel()
                await asyncio.gather(monitor_task, return_exceptions=True)
            if monitor:
                await monitor.close()
            event_file.close()
            text_file.close()
            frames_file.close()
            metadata['finished_at'] = datetime.now(timezone.utc).isoformat()
            save_meta()
            print(json.dumps({'status': metadata['status'], 'folder': str(folder),
                              'audio_seconds': metadata.get('audio_seconds'), 'error': metadata.get('error')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wait-seconds', type=int, default=300)
    parser.add_argument('--max-seconds', type=int, default=180)
    parser.add_argument('--call-id', help='Solo para adjuntar una prueba sintética controlada')
    args = parser.parse_args()
    if not (1 <= args.wait_seconds <= 600 and 1 <= args.max_seconds <= 180):
        parser.error('Espera máxima 600 s; audio máximo 180 s')
    asyncio.run(main(args))
