import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createPhoneBridge } from '../phone-bridge.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const otherId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const assistantId = 'live-candidate';
const secret = 'fake-independent-live-secret-12345';
const webhookSecret = 'fake-webhook-secret-for-tests-12345';
const code = 'fake-owner-code-for-tests';
const ficha = { nombre: '', entidad: '', motivo: '', peticion: '' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(5); } assert.fail('No llegó el evento'); }
async function fixture(t, overrides = {}) {
  const events = [], inputs = []; let cuts = 0;
  const bridge = createPhoneBridge({ liveEnabled: true, liveSecret: secret, secret: webhookSecret, accessCode: code, assistantId,
    liveLookupCall: async callId => ({ id: callId, assistantId, status: 'in-progress' }), ai: {},
    detect: async incident => { inputs.push(incident.transcripcion); return { alerta: false, probabilidad: .01 }; },
    understand: async incident => ({ rol: 'comprension', evidencias: [{ tipo: 'contexto', cita: incident.transcripcion }] }),
    endCall: async () => { cuts++; return 'requested'; }, ...overrides });
  const server = http.createServer((req, res) => void bridge.http(req, res, new URL(req.url, 'http://localhost').pathname));
  server.on('upgrade', (req, socket, head) => bridge.upgrade(req, socket, head, new URL(req.url, 'http://localhost').pathname));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { bridge.close(); await new Promise(resolve => server.close(resolve)); });
  async function connect(autoHangup = false) {
    const r = await fetch(base + '/v1/phone/monitor', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Voice-Token': code },
      body: JSON.stringify({ consentimiento_analisis: true, consentimiento_corte_automatico: autoHangup }) });
    const { ticket } = await r.json();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/calls?channel=phone&ticket=' + ticket);
    ws.on('message', raw => events.push(JSON.parse(raw))); await once(ws, 'open'); t.after(() => ws.terminate()); return ws;
  }
  async function rpc(method, params, options = {}) {
    const r = await fetch(base + '/v1/phone/live/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tiskz-Live-Secret': options.secret ?? secret, 'X-Call-Id': options.callId ?? id },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, body: await r.json() };
  }
  const tool = async (name, args = {}, options) => {
    const { status, body } = await rpc('tools/call', { name, arguments: args }, options);
    return { status, rpc: body, value: body.result?.content ? JSON.parse(body.result.content[0].text) : null };
  };
  const evaluate = (text, revision = 0, request = 'request_1', fields = ficha) => tool('evaluar_conversacion', {
    request_id: request, revision_previa: revision, transcripcion_interlocutor: text, ficha: fields });
  const end = () => fetch(base + '/v1/phone/vapi', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vapi-Secret': webhookSecret }, body: JSON.stringify({ message: { type: 'status-update', status: 'ended', call: { id, assistantId } } }) });
  return { rpc, tool, evaluate, connect, end, events, inputs, cuts: () => cuts, base };
}

test('Live MCP está apagado por defecto y exige configuración y funciones compatibles', async t => {
  const f = await fixture(t, { liveEnabled: false });
  assert.equal((await f.rpc('tools/list')).status, 404);
  assert.throws(() => createPhoneBridge({ liveEnabled: true }), /requiere secreto/);
  for (const feature of ['scribeEnabled', 'evidenceEnabled']) {
    assert.throws(() => createPhoneBridge({ liveEnabled: true, liveSecret: secret, assistantId, liveLookupCall() {}, [feature]: true }), /no admite la escucha/);
  }
});

test('MCP negocia y descubre herramientas autenticadas; una clave incorrecta no expone el catálogo', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('initialize', {}, { secret: 'wrong' })).status, 401);
  const init = await f.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  const list = await f.rpc('tools/list');
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['evaluar_conversacion', 'consultar_estado', 'solicitar_corte', 'finalizar_por_peticion']);
  assert.equal((await f.rpc('unsupported')).body.error.code, -32601);
});

test('rechaza análisis sin monitor, asistente incorrecto y una llamada distinta', async t => {
  const f = await fixture(t);
  assert.equal((await f.evaluate('Texto ficticio.')).value.status, 'unavailable');
  assert.deepEqual(f.inputs, []);
  await f.connect();
  await f.evaluate('Caso ficticio.');
  assert.equal((await f.tool('consultar_estado', {}, { callId: otherId })).value.status, 'unavailable');
  const g = await fixture(t, { liveLookupCall: async () => ({ id, assistantId: 'wrong', status: 'in-progress' }) });
  await g.connect();
  assert.equal((await g.evaluate('Caso ficticio.')).value.status, 'unavailable');
  assert.deepEqual(g.inputs, []);
});

test('retorna el análisis a Live y publica en la APK sin prometer identidad; espera cuatro declaraciones', async t => {
  const f = await fixture(t); await f.connect();
  const first = await f.evaluate('Hola.');
  assert.equal(first.value.ready_to_answer, false);
  assert.equal(first.value.identity_verified, false);
  assert.equal(first.value.assessment.estado, 'observar');
  const text = 'Me llamo Persona de Prueba. Llamo como particular. Quiero dejar un recado. No pido dinero ni datos.';
  const fields = { nombre: 'Me llamo Persona de Prueba.', entidad: 'Llamo como particular.', motivo: 'Quiero dejar un recado.', peticion: 'No pido dinero ni datos.' };
  const result = await f.evaluate(text, 1, 'request_2', fields);
  assert.equal(result.value.ready_to_answer, true);
  await until(() => f.events.some(e => e.type === 'call.ready_to_answer'));
  const ready = f.events.find(e => e.type === 'call.ready_to_answer');
  assert.equal(ready.revision, 2); assert.equal(ready.identity_verified, false);
  assert.equal(f.events.some(e => e.type === 'call.ready_to_answer' && e.revision === 1), false);
  const caption = f.events.find(e => e.type === 'transcript.update');
  assert.equal(caption.source, 'live_reasoner_report_not_audio_verified');
  assert.equal(caption.final, false);
  assert.equal(result.value.audio_evidence, 'unavailable_in_vapi_live');
});

test('reintento idempotente no repite inferencia y rechaza reutilizar la clave o inventar citas', async t => {
  const f = await fixture(t); await f.connect();
  await f.evaluate('Negación ficticia: no solicito pagos.');
  await f.evaluate('Negación ficticia: no solicito pagos.');
  assert.equal(f.inputs.length, 1);
  assert.equal((await f.evaluate('Texto distinto.')).value.status, 'unavailable');
  const invented = await f.evaluate('Texto ficticio.', 1, 'next', { ...ficha, nombre: 'Nombre inventado' });
  assert.equal(invented.rpc.error.code, -32602);
  const stale = await f.evaluate('Otro texto ficticio.', 0, 'old_revision');
  assert.equal(stale.value.status, 'rejected'); assert.equal(f.inputs.length, 1);
});

test('una corrección invalida el resultado anterior aunque la comprensión llegue tarde', async t => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { understand: async incident => {
    if (incident.transcripcion === 'Primera interpretación ficticia.') { entered = true; await gate; }
    return { rol: 'comprension', evidencias: [{ tipo: 'contexto', cita: incident.transcripcion }] };
  } });
  await f.connect();
  const old = f.evaluate('Primera interpretación ficticia.');
  await until(() => entered);
  const corrected = await f.evaluate('Corrección ficticia: no solicito dinero.', 1, 'correction');
  assert.equal(corrected.value.revision, 2);
  release();
  assert.equal((await old).value.status, 'superseded');
  await until(() => f.events.some(e => e.type === 'assessment.update' && e.revision === 2));
  assert.equal(f.events.some(e => e.type === 'assessment.update' && e.revision === 1), false);
  const current = await f.tool('consultar_estado');
  assert.equal(current.value.revision, 2);
  assert.equal(current.value.assessment.estado, 'observar');
});

test('«no me cortes» y un cierre citado no cuelgan; un cierre literal completo autorizado solo se solicita una vez', async t => {
  const f = await fixture(t); await f.connect(true);
  await f.evaluate('No me cortes.');
  assert.equal((await f.tool('finalizar_por_peticion', { revision: 1, cita: 'No me cortes.' })).value.status, 'rejected');
  await f.evaluate('En la noticia alguien dijo: Termina la llamada.', 1, 'quote');
  assert.equal((await f.tool('finalizar_por_peticion', { revision: 2, cita: 'Termina la llamada.' })).value.status, 'rejected');
  await f.evaluate('Termina la llamada.', 2, 'goodbye');
  const ended = await f.tool('finalizar_por_peticion', { revision: 3, cita: 'Termina la llamada.' });
  assert.equal(ended.value.status, 'requested'); assert.equal(ended.value.confirmed, false);
  await f.tool('finalizar_por_peticion', { revision: 3, cita: 'Termina la llamada.' });
  assert.equal(f.cuts(), 1);
  await f.end();
  const d = await (await fetch(f.base + '/v1/phone/diagnostics', { headers: { 'X-Voice-Token': code } })).json();
  assert.equal(d.lastCall.hangup_status, 'confirmed');
  assert.equal(d.lastCall.hangup_reason, 'agent_ended');
  assert.equal((await f.tool('consultar_estado')).value.status, 'unavailable');
});

test('una despedida anterior no autoriza colgar después de una corrección', async t => {
  const f = await fixture(t); await f.connect(true);
  await f.evaluate('Chau.\nNo me cortes, quiero continuar.\n');
  const result = await f.tool('finalizar_por_peticion', { revision: 1, cita: 'Chau.' });
  assert.equal(result.value.status, 'rejected'); assert.equal(f.cuts(), 0);
});

test('riesgo conserva el permiso de la APK: sin consentimiento no corta ni acepta que el modelo lo ordene', async t => {
  const f = await fixture(t, { detect: async () => ({ alerta: true, probabilidad: .99 }) });
  await f.connect(false); await f.evaluate('Amenaza ficticia de la prueba.');
  const denied = await f.tool('solicitar_corte', { revision: 1 });
  assert.equal(denied.value.status, 'rejected'); assert.equal(f.cuts(), 0);
  assert.equal(f.events.some(e => e.type === 'call.hangup_requested'), false);
});

test('alerta y corte no esperan a la comprensión; una revisión antigua no autoriza más acciones', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { detect: async () => ({ alerta: true, probabilidad: .99 }), understand: async () => { await gate; return { rol: 'comprension', evidencias: [] }; } });
  await f.connect(true); const result = f.evaluate('Amenaza ficticia para el ensayo.');
  await until(() => f.cuts() === 1);
  const state = f.events.find(e => e.type === 'assessment.update'); assert.equal(state.assessment.estado, 'alertar');
  assert.equal(state.explanation_pending, true);
  release(); await result;
  await f.tool('solicitar_corte', { revision: 1 }); assert.equal(f.cuts(), 1);
});

test('revocar el monitor impide publicar respuestas tardías o reiniciar la llamada con MCP', async t => {
  let release, started = false; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { understand: async () => { started = true; await gate; return { rol: 'comprension', evidencias: [] }; } });
  const ws = await f.connect(); const work = f.evaluate('Ejemplo ficticio.'); await until(() => started);
  ws.close(); await once(ws, 'close'); await sleep(10); release(); await work;
  assert.equal(f.events.some(e => e.type === 'understanding.update'), false);
  assert.equal((await f.tool('consultar_estado')).value.status, 'unavailable');
});

test('una despedida hablada del agente Live no evita la validación MCP', async t => {
  const f = await fixture(t); await f.connect(true); await f.evaluate('No me cortes.');
  await fetch(f.base + '/v1/phone/vapi', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vapi-Secret': webhookSecret },
    body: JSON.stringify({ message: { type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'Voy a terminar la llamada.', timestamp: Date.now(), call: { id, assistantId } } }) });
  await sleep(15); assert.equal(f.cuts(), 0);
});
