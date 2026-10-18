import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createPhoneBridge } from '../phone-bridge.mjs';
import { VoiceCollector, voiceprintConfig, createVoiceprintEngine, cosine } from '../voiceprint.mjs';

const secret = 'test-webhook-secret-1234567890';
const code = 'test-owner-private-code';
const assistantId = 'test-assistant';
const id = '11111111-2222-3333-4444-555555555555';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(10); } assert.fail('No llegó el evento esperado'); }
const conversation = (text, timestamp = 1) => ({ type: 'conversation-update', timestamp, call: { id, assistantId }, messages: [{ role: 'user', message: text }] });

// Voz ficticia: un tono continuo cuenta como habla; ceros cuentan como silencio.
function tone(seconds, rate = 16000, amplitude = 0.3) {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * amplitude * 32767), i * 2);
  return pcm;
}

function fakeVoiceprint({ best = null, overrides = {} } = {}) {
  const searches = [], enrolls = [];
  return {
    searches, enrolls,
    value: {
      cfg: { ...voiceprintConfig({ VOICEPRINT_ENABLED: 'true' }), ...overrides },
      engine: { ready: Promise.resolve(true), model: { id: 'modelo-ficticio', version: 'v-test' }, embed: async () => Array(256).fill(0.5), close() {} },
      api: { configured: true,
        search: async body => { searches.push(body); return { best_similarity: best, cases: best ? 2 : 0, reviewed_cases: 0, last_seen_at: null, scam_type: 'Falso familiar', impersonating: null }; },
        enroll: async body => { enrolls.push(body); return { incident_id: 'inc_test', samples: body.embeddings.length }; } },
    },
  };
}

async function fixture(t, { voiceprint = null, probability = 0.95, alert = true } = {}) {
  const events = [], controls = [], hangups = [];
  let audio = null, comparisons = 0;
  const bridge = createPhoneBridge({ accessCode: code, secret, assistantId, ai: {}, analysisMs: 5, apiKey: 'fake',
    detect: async () => ({ alerta: alert, probabilidad: probability }),
    understand: async () => ({ resumen: 'Ejemplo ficticio', evidencias: [], participantes_mencionados: [] }),
    startComparison: options => { comparisons++; audio = options; return { close() {}, metadata: () => ({ status: 'test' }) }; },
    sendControl: async (_target, body) => { controls.push(body); },
    endCall: async () => { hangups.push(Date.now()); return 'requested'; },
    voiceprint });
  const server = http.createServer((req, res) => void bridge.http(req, res, new URL(req.url, 'http://localhost').pathname));
  server.on('upgrade', (req, socket, head) => bridge.upgrade(req, socket, head, new URL(req.url, 'http://localhost').pathname));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { bridge.close(); await new Promise(r => server.close(r)); });
  async function connect(extra = {}) {
    const response = await fetch(base + '/v1/phone/monitor', { method: 'POST', headers: { 'X-Voice-Token': code, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentimiento_analisis: true, consentimiento_corte_automatico: true, consentimiento_huella_voz: true, voice_block_protocol: 1, numero_llamante: '+51987654321', ...extra }) });
    const { ticket } = await response.json();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/calls?channel=phone&ticket=' + ticket);
    ws.on('message', raw => events.push(JSON.parse(raw)));
    await once(ws, 'open'); t.after(() => ws.terminate()); return ws;
  }
  const post = message => fetch(base + '/v1/phone/vapi', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vapi-Secret': secret }, body: JSON.stringify({ message }) });
  const diagnostics = async () => (await fetch(base+'/v1/phone/diagnostics', { headers: { 'X-Voice-Token': code } })).json();
  return { events, controls, hangups, connect, post, audio: () => audio, comparisons: () => comparisons, diagnostics };
}

test('Sin VOICEPRINT_ENABLED el flujo sigue igual: no escucha audio y corta al alertar', async t => {
  const f = await fixture(t, { voiceprint: null });
  await f.connect();
  await f.post(conversation('Transfiere ahora o le pasa algo a tu familia.'));
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  assert.equal(f.comparisons(), 0);
  assert.equal(f.events.some(e => e.type.startsWith('voice.')), false);
  assert.equal(f.controls.length, 0);
});

test('La voz se compara y avisa si se parece a un estafador guardado, sin guardar la huella', async t => {
  const vp = fakeVoiceprint({ best: 0.86 });
  const f = await fixture(t, { voiceprint: vp.value, alert: false, probability: 0.1 });
  await f.connect({ consentimiento_corte_automatico: false });
  await f.post(conversation('Hola, te llamo por un paquete.'));
  await until(() => f.audio());
  f.audio().onAudio(tone(7), 16000);
  await until(() => f.events.some(e => e.type === 'voice.match'));
  const match = f.events.find(e => e.type === 'voice.match');
  assert.equal(match.strong, true); assert.equal(match.cases, 2); assert.equal(match.identity_verified, false);
  assert.equal(vp.searches.length, 1); assert.equal(vp.searches[0].model_id, 'modelo-ficticio');
  assert.equal(vp.enrolls.length, 0);
  assert.equal(f.events.some(e => e.type === 'call.hangup_requested'), false);
});

test('Una voz que no se parece no genera aviso', async t => {
  const vp = fakeVoiceprint({ best: 0.42 });
  const f = await fixture(t, { voiceprint: vp.value, alert: false, probability: 0.1 });
  await f.connect();
  await f.post(conversation('Hola.'));
  await until(() => f.audio());
  f.audio().onAudio(tone(7), 16000);
  await until(() => vp.searches.length === 1);
  await delay(30);
  assert.equal(f.events.some(e => e.type === 'voice.match'), false);
});

test('Estafa confirmada: el agente alarga la llamada, se guarda la voz y recién entonces se corta', async t => {
  const vp = fakeVoiceprint({ best: null });
  const f = await fixture(t, { voiceprint: vp.value, probability: 0.95 });
  await f.connect();
  await f.post(conversation('Transfiere quinientos soles ahora o le pasa algo a tu familia.'));
  await until(() => f.events.some(e => e.type === 'voice.collecting' && e.status === 'started'));
  assert.equal(f.events.some(e => e.type === 'call.hangup_requested'), false);
  assert.equal(f.controls[0].type, 'add-message');
  assert.equal(f.controls[0].message.role, 'system');
  f.audio().onAudio(tone(21), 16000);
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  assert.equal(vp.enrolls.length, 1);
  assert.equal(vp.enrolls[0].embeddings.length, 3);
  assert.equal(vp.enrolls[0].caller_number, '+51987654321');
  assert.equal(vp.enrolls[0].risk_score, 95);
  assert.equal(f.events.find(e => e.type === 'voice.collecting' && e.status !== 'started').status, 'saved');
});

test('Alerta sin certeza alta: corta como siempre y no guarda voz', async t => {
  const vp = fakeVoiceprint({ best: null });
  const f = await fixture(t, { voiceprint: vp.value, probability: 0.7 });
  await f.connect();
  await f.post(conversation('Necesito el código que te llegó.'));
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  assert.equal(f.events.some(e => e.type === 'voice.collecting'), false);
  assert.equal(vp.enrolls.length, 0);
});

test('Una coincidencia fuerte solicita corte y bloqueo antes del primer texto sin declarar una estafa', async t => {
  const vp = fakeVoiceprint({ best: 0.9 });
  const f = await fixture(t, { voiceprint: vp.value, probability: 0.1, alert: false });
  await f.connect();
  // La llamada empieza y la voz se reconoce antes de que el detector alerte.
  await f.post({ type: 'status-update', status: 'in-progress', call: { id, assistantId } });
  await until(() => f.audio());
  f.audio().onAudio(tone(7), 16000);
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  const order = f.events.find(e => e.type === 'call.hangup_requested');
  assert.equal(order.reason, 'voice_match'); assert.equal(order.block_number, true);
  assert.equal(order.revision, 0); assert.equal(order.identity_verified, false);
  assert.ok(f.events.findIndex(e => e.type === 'voice.match') < f.events.indexOf(order));
  assert.equal(f.events.some(e => e.type === 'alert.updated' && e.alerta === true), false);
  assert.equal(vp.enrolls.length, 0); assert.equal(f.hangups.length, 1);
});

test('La voz fuerte bloquea aunque el contenido esté en observar, sin inflar su porcentaje', async t => {
  const vp = fakeVoiceprint({ best: .92 });
  const f = await fixture(t, { voiceprint: vp.value, probability: .1, alert: false });
  await f.connect(); await f.post(conversation('Quiero coordinar una reunión ficticia.'));
  await until(() => f.events.some(e => e.type === 'risk.update'));
  f.audio().onAudio(tone(7),16000);
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  assert.equal(f.events.find(e => e.type === 'risk.update').risk_percent,10);
  assert.equal(f.events.find(e => e.type === 'call.hangup_requested').reason,'voice_match');
  assert.equal(vp.enrolls.length,0);
});

test('Una APK anterior recibe la coincidencia pero no una orden de bloqueo que no puede ejecutar', async t => {
  const vp=fakeVoiceprint({best:.94});const f=await fixture(t,{voiceprint:vp.value,alert:false,probability:.1});
  await f.connect({voice_block_protocol:0});await f.post({type:'status-update',status:'in-progress',call:{id,assistantId}});
  await until(()=>f.audio());f.audio().onAudio(tone(7),16000);
  await until(()=>f.events.some(e=>e.type==='voice.match'));
  assert.equal(f.hangups.length,0);
});

test('Una similitud intermedia solo avisa; una respuesta sin casos no autoriza un bloqueo', async t => {
  const vp = fakeVoiceprint({ best: .75 });
  const f = await fixture(t, { voiceprint: vp.value, probability:.1, alert:false });
  await f.connect(); await f.post({type:'status-update',status:'in-progress',call:{id,assistantId}});
  await until(() => f.audio());f.audio().onAudio(tone(7),16000);
  await until(() => f.events.some(e => e.type==='voice.match'));
  assert.equal(f.events.find(e => e.type==='voice.match').strong,false);assert.equal(f.hangups.length,0);
  const empty = fakeVoiceprint({best:.95});empty.value.api.search=async()=>({best_similarity:.95,cases:0,reviewed_cases:0});
  const g=await fixture(t,{voiceprint:empty.value,probability:.1,alert:false});
  await g.connect();await g.post({type:'status-update',status:'in-progress',call:{id,assistantId}});
  await until(()=>g.audio());g.audio().onAudio(tone(7),16000);await delay(30);
  assert.equal(g.events.some(e=>e.type==='voice.match'),false);assert.equal(g.hangups.length,0);
});

test('Una comparación tardía no bloquea cuando se revocó el permiso de voz', async t => {
  let release,started=false;const gate=new Promise(r=>{release=r});t.after(()=>release());
  const vp=fakeVoiceprint({best:.95});vp.value.api.search=async()=>{started=true;await gate;return{best_similarity:.95,cases:1}};
  const f=await fixture(t,{voiceprint:vp.value,probability:.1,alert:false});
  const owner=await f.connect();await f.connect({consentimiento_huella_voz:false,consentimiento_corte_automatico:false});
  await f.post({type:'status-update',status:'in-progress',call:{id,assistantId}});
  await until(()=>f.audio());f.audio().onAudio(tone(7),16000);await until(()=>started);
  owner.close();await once(owner,'close');
  await until(async () => (await f.diagnostics()).connectedMonitors === 1);
  release();await delay(30);
  assert.equal(f.events.some(e=>e.type==='voice.match'),false);assert.equal(f.hangups.length,0);
});

test('Si la alerta llega antes que la comparación, se corta como siempre', async t => {
  const vp = fakeVoiceprint({ best: 0.9 });
  const f = await fixture(t, { voiceprint: vp.value, probability: 0.7 });
  await f.connect();
  await f.post(conversation('Necesito el código que te llegó.'));
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  assert.equal(f.events.some(e => e.type === 'voice.collecting'), false);
});

test('Si cuelgan durante la recolección se guarda lo juntado, si alcanza el mínimo', async t => {
  const vp = fakeVoiceprint({ best: null });
  const f = await fixture(t, { voiceprint: vp.value, probability: 0.95 });
  await f.connect();
  await f.post(conversation('Transfiere ahora o le pasa algo a tu familia.'));
  await until(() => f.events.some(e => e.type === 'voice.collecting'));
  f.audio().onAudio(tone(8), 16000);
  await f.post({ type: 'status-update', status: 'ended', call: { id, assistantId } });
  await until(() => vp.enrolls.length === 1);
  assert.equal(vp.enrolls[0].embeddings.length, 1);
});

test('Sin permiso de huella vocal no se escucha ni se compara la voz', async t => {
  const vp = fakeVoiceprint({ best: 0.95 });
  const f = await fixture(t, { voiceprint: vp.value, probability: 0.95 });
  await f.connect({ consentimiento_huella_voz: false });
  await f.post(conversation('Transfiere ahora o le pasa algo a tu familia.'));
  await until(() => f.events.some(e => e.type === 'call.hangup_requested'));
  assert.equal(f.comparisons(), 0);
  assert.equal(f.events.some(e => e.type.startsWith('voice.')), false);
});

test('El recolector ignora silencios y respeta el tope', () => {
  const c = new VoiceCollector({ maxSeconds: 2 });
  c.push(Buffer.alloc(16000 * 2 * 3), 16000);
  assert.equal(c.activeSeconds, 0);
  c.push(tone(5), 16000);
  assert.ok(Math.abs(c.activeSeconds - 2) < 0.03);
  const snap = c.snapshot(); assert.equal(snap.rate, 16000); assert.equal(snap.pcm.length, 2 * 16000 * 2);
  c.clear(); assert.equal(c.snapshot(), null);
});

test('Sin motor instalado la huella queda deshabilitada sin error', async () => {
  const engine = createVoiceprintEngine({ dir: '/ruta/inexistente' });
  assert.equal(await engine.ready, false);
  await assert.rejects(engine.embed(Buffer.alloc(10), 16000));
  assert.equal(voiceprintConfig({}).enabled, false);
  assert.equal(voiceprintConfig({ VOICEPRINT_NOTIFY_SIMILARITY: '7' }).notifySimilarity, 0.7);
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
});

test('El hilo vocal no hereda el arranque HTTP de Maritime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tiskz-worker-'));
  let options;
  class FakeWorker extends EventEmitter {
    constructor(_source, config) { super(); options = config; queueMicrotask(() => this.emit('message', { ready: true })); }
    unref() {}
    terminate() {}
  }
  try {
    await mkdir(join(dir, 'models'));
    await mkdir(join(dir, 'node_modules', 'sherpa-onnx-node'), { recursive: true });
    await writeFile(join(dir, 'models', 'ficticio.onnx'), 'modelo-ficticio');
    const engine = createVoiceprintEngine({ dir, WorkerClass: FakeWorker,
      model: { id: 'ficticio', file: 'ficticio.onnx', sha256: 'ficticio', dim: 256 } });
    assert.equal(await engine.ready, true);
    assert.deepEqual(options.execArgv, []);
    assert.equal(options.env.NODE_OPTIONS, '');
    engine.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
