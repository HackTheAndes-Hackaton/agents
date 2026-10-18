import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CallerPcm, scribeAssistant, startScribeComparison, vapiSocketUrl } from '../scribe-sidecar.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const url = (value, kind = 'transport') => `wss://phone-call-websocket.aws-us-west-2-backend-production3.vapi.ai/${value}/${kind}`;
const tick = () => new Promise(r => setImmediate(r));

test('extrae solo customer incluso si un frame corta una muestra estéreo', () => {
  const bytes = Buffer.alloc(12); [11, 999, -22, 777, 33, 666].forEach((v, i) => bytes.writeInt16LE(v, i * 2));
  const pcm = new CallerPcm();
  const result = Buffer.concat([pcm.read(bytes.subarray(0, 3)), pcm.read(bytes.subarray(3, 9)), pcm.read(bytes.subarray(9))]);
  assert.deepEqual([0, 2, 4].map(i => result.readInt16LE(i)), [11, -22, 33]);
});

test('rechaza sockets de otras llamadas, redirects, credenciales y hosts externos', () => {
  assert.equal(vapiSocketUrl(url(id), id), url(id));
  for (const value of [url(sid), `ws://api.vapi.ai/${id}/transport`, `wss://vapi.ai.evil.test/${id}/transport`, url(id) + '?secret=x', `wss://key@api.vapi.ai/${id}/transport`]) assert.equal(vapiSocketUrl(value, id), null);
});

test('la sesión Scribe es efímera, no llama números ni retiene audio ni entrega voz', () => {
  const a = scribeAssistant();
  assert.equal(a.transcriber.model, 'scribe_v2_realtime');
  assert.equal(a.transcriber.silenceThresholdSeconds, .3);
  assert.equal(a.transcriber.minSilenceDurationMs, 300);
  assert.equal(a.artifactPlan.recordingEnabled, false);
  assert.equal(a.artifactPlan.loggingEnabled, false);
  assert.deepEqual(a.serverMessages, []);
  assert.deepEqual(a.model.tools, []);
});

test('separa audio, publica parcial/final y cierra ambos sockets al revocar', async () => {
  const sockets = [], requests = [], captions = [];
  class Socket extends EventEmitter {
    readyState = 0; bufferedAmount = 0; sent = [];
    constructor(address) { super(); this.address = address; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const fetch = async (address, init) => {
    requests.push({ address, init });
    return { ok: true, json: async () => init.method === 'POST'
      ? { id: sid, transport: { websocketCallUrl: url(sid) } }
      : { id, assistantId: 'test', status: 'in-progress', monitor: { listenUrl: url(id, 'listen') } } };
  };
  const s = startScribeComparison({ apiKey: 'fake', callId: id, assistantId: 'test', WebSocket: Socket, fetch, onCaption: e => captions.push(e) });
  await tick(); const listen = sockets[0];
  listen.emit('message', Buffer.from(JSON.stringify({ type: 'start', encoding: 'linear16', container: 'raw', sampleRate: 24000, channels: 2 })), false);
  const stereo = Buffer.from([7, 0, 9, 0, 8, 0, 9, 0]); listen.emit('message', stereo, true);
  await tick(); const shadow = sockets[1];
  assert.deepEqual(Buffer.concat(shadow.sent), Buffer.from([7, 0, 8, 0]));
  for (const [role, kind] of [['assistant', 'final'], ['user', 'partial'], ['user', 'final']]) shadow.emit('message', Buffer.from(JSON.stringify({ type: 'transcript', role, transcriptType: kind, transcript: 'No necesito pagos.' })), false);
  assert.equal(captions.length, 2); assert.equal(captions[0].id, captions[1].id);
  assert.equal(captions[0].final, false); assert.equal(captions[1].final, true);
  s.close(); assert.ok(sockets.every(ws => ws.readyState === 3));
  assert.equal(JSON.parse(shadow.sent.at(-1)).type, 'end-call');
  shadow.emit('message', Buffer.from(JSON.stringify({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: 'Tardío' })), false);
  assert.equal(captions.length, 2);
  assert.ok(requests.every(r => !r.address.includes('/control')));
});

test('no abre transcriptor si no hay dos canales identificados', async () => {
  const sockets = [], statuses = [];
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() { super(); sockets.push(this); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  let requests = 0;
  const s = startScribeComparison({ apiKey: 'fake', callId: id, assistantId: 'test', WebSocket: Socket,
    onStatus: e => statuses.push(e.status), fetch: async () => { requests++; return { ok: true, json: async () => ({ id, assistantId: 'test', monitor: { listenUrl: url(id, 'listen') } }) }; } });
  await tick(); sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'start', encoding: 'linear16', container: 'raw', sampleRate: 24000, channels: 1 })), false);
  assert.equal(requests, 1); assert.ok(statuses.includes('unsupported_audio_format')); s.close();
});
