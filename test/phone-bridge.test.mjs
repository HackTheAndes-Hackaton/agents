import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createPhoneBridge } from '../phone-bridge.mjs';
const secret = 'test-webhook-secret-1234567890';
const code = 'test-owner-private-code';
const assistantId = 'test-assistant';
const id = '11111111-2222-3333-4444-555555555555';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, overrides = {}) {
  const inputs = [], events = [];
  const bridge = createPhoneBridge({ accessCode: code, secret, assistantId, ai: {}, analysisMs: 5,
    detect: async incident => { inputs.push(incident.transcripcion); return { alerta: true, probabilidad: .9 }; },
    understand: async () => ({ resumen: 'Ejemplo ficticio', evidencias: [], participantes_mencionados: [] }), ...overrides });
  const server = http.createServer((req, res) => void bridge.http(req, res, new URL(req.url, 'http://localhost').pathname));
  server.on('upgrade', (req, socket, head) => bridge.upgrade(req, socket, head, new URL(req.url, 'http://localhost').pathname));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { bridge.close(); await new Promise(r => server.close(r)); });
  async function connect() {
    const response = await fetch(base + '/v1/phone/monitor', { method: 'POST', headers: { 'X-Voice-Token': code, 'Content-Type': 'application/json' }, body: JSON.stringify({ consentimiento_analisis: true }) });
    const { ticket } = await response.json();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/calls?channel=phone&ticket=' + ticket);
    ws.on('message', raw => events.push(JSON.parse(raw)));
    await once(ws, 'open'); t.after(() => ws.terminate()); return ws;
  }
  const post = (message, token = secret) => fetch(base + '/v1/phone/vapi', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vapi-Secret': token }, body: JSON.stringify({ message }) });
  return { inputs, events, connect, post, base };
}
const conversation = (text, timestamp = 1, callId = id) => ({ type: 'conversation-update', timestamp, call: { id: callId, assistantId }, messages: [{ role: 'assistant', message: 'Soy un asistente virtual.' }, { role: 'user', message: text }] });
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.fail('No llegó el evento esperado'); }

test('rechaza webhooks falsos y no analiza sin pantalla autorizada', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(conversation('Ejemplo.'), 'wrong')).status, 401);
  assert.equal((await f.post(conversation('Ejemplo.'))).status, 200);
  await delay(20); assert.deepEqual(f.inputs, []);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/phone');
  assert.match((await once(ws, 'error'))[0].message, /401/);
});

test('conserva negaciones, excluye voz del agente y deduplica eventos atrasados', async t => {
  const f = await fixture(t); await f.connect();
  const text = 'No necesito pagos ni datos personales.';
  await f.post(conversation(text, 20));
  await until(() => f.events.some(e => e.type === 'understanding.update'));
  await f.post(conversation('Necesito pagos.', 10));
  await f.post(conversation(text, 20));
  await f.post({ ...conversation('Otro.', 30), call: { id, assistantId: 'other-assistant' } });
  await delay(30);
  assert.deepEqual(f.inputs, [text]);
  assert.equal(f.events.find(e => e.type === 'alert.updated').alerta, true);
  assert.equal(f.events.find(e => e.type === 'transcript.update').text, text);
});

test('no mezcla llamadas ni resucita llamadas finalizadas con reintentos', async t => {
  const f = await fixture(t); const ws = await f.connect();
  await f.post(conversation('Primera llamada.'));
  await until(() => f.inputs.length === 1);
  await f.post(conversation('Otra llamada.', 2, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  assert.deepEqual(f.inputs, ['Primera llamada.']);
  await f.post({ type: 'status-update', status: 'ended', call: { id, assistantId } });
  await until(() => f.events.some(e => e.type === 'call.ended'));
  await f.post(conversation('Reintento tardío.', 100)); await delay(20);
  assert.deepEqual(f.inputs, ['Primera llamada.']);
  ws.close();
});

test('fallo de detección no produce FALSE y comprensión sigue disponible', async t => {
  const f = await fixture(t, { detect: async () => { throw Error('API caída'); } }); await f.connect();
  await f.post(conversation('Caso ficticio.'));
  await until(() => f.events.some(e => e.type === 'understanding.update'));
  assert.ok(f.events.some(e => e.type === 'error'));
  assert.equal(f.events.some(e => e.type === 'alert.updated'), false);
});

test('el código privado solo crea tickets con consentimiento y cada ticket se consume una vez', async t => {
  const f = await fixture(t);
  const monitor = consent => fetch(f.base + '/v1/phone/monitor', { method: 'POST', headers: { 'X-Voice-Token': code, 'Content-Type': 'application/json' }, body: JSON.stringify({ consentimiento_analisis: consent }) });
  assert.equal((await monitor(false)).status, 400);
  const r = await monitor(true); assert.equal(r.status, 201);
  const { ticket } = await r.json(); assert.notEqual(ticket, code);
  const url = f.base.replace('http:', 'ws:') + '/ws/calls?channel=phone&ticket=' + ticket;
  const ws = new WebSocket(url); await once(ws, 'open'); t.after(() => ws.terminate());
  const replay = new WebSocket(url); assert.match((await once(replay, 'error'))[0].message, /401/);
});

test('GPT-Live analiza solo finales del interlocutor y ordena reintentos sin mezclar snapshots', async t => {
  const f = await fixture(t); await f.connect();
  const transcript = (text, timestamp, extra = {}) => ({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: text, timestamp, call: { id, assistantId }, ...extra });
  await f.post(transcript('Necesito pagos', 10, { transcriptType: 'partial' }));
  await f.post(transcript('Paga ahora.', 11, { role: 'assistant' }));
  await delay(20); assert.deepEqual(f.inputs, []);
  assert.equal(f.events.some(e => e.type === 'phone.call'), false);
  await f.post(transcript('No necesito pagos ni datos personales.', 30));
  await until(() => f.inputs.length === 1);
  await f.post(transcript('Hola, confirmo la reunión.', 20));
  await until(() => f.inputs.length === 2);
  await f.post(transcript('No necesito pagos ni datos personales.', 30));
  await f.post(conversation('No necesito pagos ni datos personales.', 40));
  await delay(20);
  assert.deepEqual(f.inputs, ['No necesito pagos ni datos personales.', 'Hola, confirmo la reunión.\nNo necesito pagos ni datos personales.']);
  assert.equal(f.events.filter(e => e.type === 'transcript.update').at(-1).source, 'vapi_transcript_final');
});
