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
    requests.push(JSON.parse(Buffer.concat(chunks)));
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    res.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(options.result ?? { rol: 'comprension', resumen: 'Petición de transferencia', evidencias: [{ cita: 'Transfiere dinero ahora.', observacion: 'Petición explícita' }], limitaciones: ['Identidad no verificada'] }) } }] }));
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
  const f = await fixture(t, { result: { rol: 'comprension', evidencias: [{ cita: 'Inventada' }], limitaciones: [] } });
  assert.equal((await f.chat(incident)).status, 500);
});

test('detección exige un nivel de riesgo permitido', async t => {
  const f = await fixture(t, { role: 'deteccion', result: { rol: 'deteccion', riesgo_estimado: 'culpable', evidencias: [], limitaciones: [] } });
  assert.equal((await f.chat(incident)).status, 500);
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
