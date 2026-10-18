import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentServer } from '../server.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
const incident = { consentimiento_analisis: true, transcripcion: 'Transfiere dinero ahora.' };

async function fixture(t, options = {}) {
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, ...JSON.parse(Buffer.concat(chunks)) });
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    res.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' });
    const result = options.role === 'deteccion'
      ? options.result ?? { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'alerta', probability: options.probability ?? 0.9 }] }
      : { choices: [{ message: { content: JSON.stringify(options.result ?? { rol: 'comprension', resumen: 'Petición de transferencia', evidencias: [{ tipo: 'solicitud', cita: 'Transfiere dinero ahora.', observacion: 'Petición explícita' }], limitaciones: ['Identidad no verificada'] }) } }] };
    res.end(JSON.stringify(result));
  });
  const baseUrl = await listen(provider);
  const dataDir = await mkdtemp(join(tmpdir(), 'andes-test-'));
  const server = await createAgentServer({ apiKey: 'solo-prueba', baseUrl, dataDir, ...options });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(provider); await rm(dataDir, { recursive: true }); });
  const chat = (input, id = 'caso') => fetch(`${url}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: JSON.stringify(input), conversationId: id }) });
  return { url, chat, requests, dataDir, baseUrl };
}

test('salud y autorización: no se llama al modelo sin consentimiento', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
  const res = await f.chat({ ...incident, consentimiento_analisis: false });
  assert.equal(JSON.parse((await res.json()).response).estado, 'requiere_entrada');
  assert.equal(f.requests.length, 0);
});

test('analiza sin guardar transcripciones por defecto', async t => {
  const f = await fixture(t);
  assert.equal((await f.chat(incident)).status, 200);
  assert.equal(f.requests[0].messages.at(-1).content, JSON.stringify(incident));
  assert.deepEqual(await readdir(f.dataDir), []);
});

test('rechaza citas que no existen en la fuente', async t => {
  const f = await fixture(t, { result: { rol: 'comprension', evidencias: [{ tipo: 'contexto', cita: 'Inventada' }], limitaciones: [] } });
  assert.equal((await f.chat(incident)).status, 500);
});

test('detección rechaza probabilidades inválidas y no devuelve false', async t => {
  const f = await fixture(t, { role: 'deteccion', result: { answers: [{ type: 'predicate', name: 'alerta', probability: 1.1 }] } });
  const response = await f.chat(incident);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).response, undefined);
});

test('Decisions convierte probabilidades en booleanos sin generar texto', async t => {
  for (const [probability, expected] of [[0.1, false], [0.9, true], [0.5, true]]) {
    const f = await fixture(t, { role: 'deteccion', probability, persistHistory: true });
    const response = await f.chat({ ...incident, comprension: { resumen: 'No enviar al detector' } });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse((await response.json()).response), expected);
    assert.equal(f.requests[0].path, '/decisions');
    assert.equal(f.requests[0].model, 'gpt-6-luna');
    assert.equal(f.requests[0].input, incident.transcripcion);
    assert.equal(f.requests[0].questions[0].type, 'predicate');
    assert.equal(f.requests[0].messages, undefined);
    assert.deepEqual(await readdir(f.dataDir), []);
  }
});

test('una negativa del modelo y un fallo del proveedor no son ausencia de riesgo', async t => {
  const refused = await fixture(t, { role: 'deteccion', result: { answers: [{ type: 'refusal', name: 'alerta' }] } });
  assert.equal((await refused.chat(incident)).status, 422);
  const failed = await fixture(t, { role: 'deteccion', status: 401 });
  assert.equal((await failed.chat(incident)).status, 502);
});

test('rechaza un umbral mal configurado antes de iniciar', async () => {
  await assert.rejects(createAgentServer({ role: 'deteccion', alertThreshold: 'incorrecto' }), /ALERT_THRESHOLD/);
});

test('historial opcional persiste y separa conversaciones', async t => {
  const f = await fixture(t, { persistHistory: true });
  await f.chat(incident, 'uno');
  await f.chat(incident, 'uno');
  await f.chat(incident, 'dos');
  assert.equal(f.requests[1].messages.length, 4);
  assert.equal(f.requests[2].messages.length, 2);
  const restarted = await createAgentServer({ apiKey: 'solo-prueba', baseUrl: f.baseUrl, dataDir: f.dataDir, persistHistory: true });
  const restartedUrl = await listen(restarted);
  t.after(() => close(restarted));
  const res = await fetch(`${restartedUrl}/chat`, { method: 'POST', body: JSON.stringify({ message: JSON.stringify(incident), conversationId: 'uno' }) });
  assert.equal(res.status, 200);
  assert.equal(f.requests[3].messages.length, 6);
  assert.equal((await readdir(f.dataDir)).filter(name => name.endsWith('.json')).length, 2);
});

test('errores y latencia del proveedor se controlan', async t => {
  const denied = await fixture(t, { status: 401 });
  assert.equal((await denied.chat(incident)).status, 502);
  const slow = await fixture(t, { delay: 60, timeoutMs: 10 });
  assert.equal((await slow.chat(incident)).status, 504);
});


test('chat de comprensión tampoco publica nombres o narrativas inventadas del proveedor', async t => {
  const f = await fixture(t, { result: { rol: 'comprension', resumen: 'Enrique recibe dinero de Pedro', evidencias: [{ tipo: 'solicitud', cita: incident.transcripcion, observacion: 'Enrique se identifica' }], limitaciones: ['Identidad verificada'] } });
  const response = await f.chat(incident);
  assert.equal(response.status, 200);
  const analysis = JSON.parse((await response.json()).response);
  assert.equal(analysis.modo, 'extractivo_sin_identidades_v1');
  assert.doesNotMatch(JSON.stringify(analysis), /Enrique|Pedro|Identidad verificada/);
});
