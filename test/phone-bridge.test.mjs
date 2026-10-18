import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createPhoneBridge, endVapiCall, vapiControlUrl } from '../phone-bridge.mjs';
const secret = 'test-webhook-secret-1234567890';
const code = 'test-owner-private-code';
const assistantId = 'test-assistant';
const id = '11111111-2222-3333-4444-555555555555';
const delay = ms => new Promise(r => setTimeout(r, ms));

test('Scribe compara sin reemplazar la alerta principal ni autorizar un corte; confirma recepción APK', async t => {
  let comparison, closed = 0;
  const f = await fixture(t, { apiKey: 'fake', scribeEnabled: true,
    startComparison: options => { comparison = options; return { close: () => closed++, metadata: () => ({ status: 'test' }) }; },
    detect: async incident => ({ alerta: incident.transcripcion.includes('amenaza'), probabilidad: incident.transcripcion.includes('amenaza') ? .99 : .01 }) });
  const ws = await f.connect(true);
  await f.post(conversation('Reunión de prueba.'));
  await until(() => f.events.some(e => e.type === 'alert.updated'));
  comparison.onCaption({ id: 'scribe-0', sequence: 0, text: 'amenaza ficticia', final: false });
  await delay(15); assert.equal(f.events.some(e => e.type === 'comparison.alert'), false);
  comparison.onCaption({ id: 'scribe-0', sequence: 0, text: 'amenaza ficticia', final: true });
  await until(() => f.events.some(e => e.type === 'comparison.alert'));
  const e = f.events.find(e => e.type === 'comparison.alert');
  assert.equal(e.alerta, true); assert.equal(e.comparison_only, true);
  assert.equal(f.events.find(e => e.type === 'alert.updated').alerta, false);
  assert.equal(f.events.some(e => e.type === 'call.hangup_requested'), false);
  ws.send(JSON.stringify({ type: 'event.received', event_id: e.event_id, session_id: id }));
  await delay(20);
  const r = await fetch(f.base + '/v1/phone/diagnostics', { headers: { 'X-Voice-Token': code } });
  const d = await r.json(); assert.equal(d.currentCall.delivery[0].event_type, 'comparison.alert');
  await f.post({ type: 'status-update', status: 'ended', call: { id, assistantId } });
  assert.equal(closed, 1);
  comparison.onCaption({ id: 'scribe-1', sequence: 1, text: 'Tardío', final: true });
  assert.equal(f.events.some(e => e.text === 'Tardío'), false);
});
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
  async function connect(autoHangup = false) {
    const response = await fetch(base + '/v1/phone/monitor', { method: 'POST', headers: { 'X-Voice-Token': code, 'Content-Type': 'application/json' }, body: JSON.stringify({ consentimiento_analisis: true, consentimiento_corte_automatico: autoHangup }) });
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

test('orientación telefónica espera ambos agentes y entrega citas actuales sin ordenar corte', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { detect: async () => ({ alerta: false, probabilidad: .1 }),
    understand: async incident => { await gate; return { rol: 'comprension', evidencias: [{ tipo: 'peticion_pago', cita: incident.transcripcion }] }; } });
  await f.connect(true);
  await f.post(conversation('Necesito dinero.'));
  await until(() => f.events.some(e => e.type === 'alert.updated'));
  assert.equal(f.events.some(e => e.type === 'assessment.update'), false);
  release();
  await until(() => f.events.some(e => e.type === 'assessment.update'));
  const e = f.events.find(e => e.type === 'assessment.update');
  assert.equal(e.session_id, id);
  assert.equal(e.revision, 1);
  assert.equal(e.assessment.estado, 'verificar');
  assert.equal(e.assessment.evidencia_textual[0].cita, 'Necesito dinero.');
  const risk = f.events.filter(e => e.type === 'risk.update').at(-1);
  assert.match(risk.reasons[0], /petición de dinero/);
  assert.equal(risk.revision, e.revision);
  assert.equal(f.events.some(e => e.type === 'call.hangup_requested'), false);
});

test('el turno telefónico final se analiza sin los dos segundos de espera artificial', async t => {
  const f = await fixture(t, { analysisMs: undefined }); await f.connect();
  const started = performance.now();
  await f.post(conversation('Caso ficticio para revisar la entrega del turno.'));
  await until(() => f.inputs.length === 1);
  assert.ok(performance.now() - started < 1500, 'No debe añadir 2 segundos antes de llamar al modelo');
});

test('una comprensión lenta no retrasa el estado alertar ni el corte ya autorizado', async t => {
  let release;
  const gate = new Promise(r => { release = r; }); t.after(() => release());
  const f = await fixture(t, { understand: async () => { await gate; return { rol: 'comprension', evidencias: [] }; }, endCall: async () => 'requested' });
  await f.connect(true); await f.post(conversation('Amenaza ficticia para esta prueba.'));
  await until(() => f.events.some(e => e.type === 'call.hangup_result'));
  const state = f.events.find(e => e.type === 'assessment.update');
  assert.equal(state.assessment.estado, 'alertar');
  assert.equal(state.explanation_pending, true);
  assert.ok(f.events.indexOf(state) < f.events.findIndex(e => e.type === 'call.hangup_requested'));
  assert.equal(f.events.some(e => e.type === 'understanding.update'), false);
});

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


test('TRUE ordena corte una vez; confirma solicitud sin fingir que el proveedor ya colgó', async t => {
  const endedCalls = [];
  const f = await fixture(t, { endCall: async target => { endedCalls.push(target.id); return 'requested'; } });
  await f.connect(true);
  await f.post(conversation('Transfiere dinero o te haré daño.', 1));
  await until(() => f.events.some(e => e.type === 'call.hangup_result'));
  const order = f.events.find(e => e.type === 'call.hangup_requested');
  assert.equal(order.call_id, id); assert.equal(order.session_id, id); assert.equal(order.revision, 1);
  assert.equal(order.reason, 'risk_detected'); assert.match(order.request_id, /^[a-f0-9-]{36}$/);
  assert.equal(f.events.some(e => e.type === 'call.ended'), false);
  await f.post({ ...conversation('Otra amenaza.', 2), messages: [{ role:'user', message:'Otra amenaza.' }, { role:'user', message:'Paga.' }] });
  await until(() => f.inputs.length === 2);
  assert.deepEqual(endedCalls, [id]);
  await f.post({type:'status-update',status:'ended',call:{id,assistantId}});
  await until(() => f.events.some(e => e.type === 'call.ended'));
});

test('FALSE y falta de autorización de corte no cuelgan', async t => {
  let cuts = 0;
  const f = await fixture(t, { detect: async () => ({ alerta:false, probabilidad:.1 }), endCall:async()=>{cuts++;} });
  await f.connect(true); await f.post(conversation('No necesito dinero.'));
  await until(() => f.events.some(e=>e.type==='alert.updated'));
  assert.equal(cuts,0); assert.equal(f.events.some(e=>e.type==='call.hangup_requested'),false);
  const g = await fixture(t, {endCall:async()=>{cuts++;}});
  await g.connect(false); await g.post(conversation('Paga ahora.'));
  await until(() => g.events.some(e=>e.type==='alert.updated'));
  assert.equal(cuts,0);
});

test('corte fallido se muestra como fallo y no como llamada terminada', async t => {
  const f = await fixture(t, {endCall:async()=>{throw Error('offline');}});
  await f.connect(true); await f.post(conversation('Amenaza ficticia.'));
  await until(() => f.events.some(e=>e.type==='call.hangup_result'));
  assert.equal(f.events.find(e=>e.type==='call.hangup_result').status,'failed');
  assert.equal(f.events.some(e=>e.type==='call.ended'),false);
});

test('una detección obsoleta no corta una revisión corregida', async t => {
  let resolveFirst; let count=0; let cuts=0;
  const f=await fixture(t,{detect:async()=> ++count===1 ? new Promise(r=>{resolveFirst=r;}) : {alerta:false,probabilidad:0},endCall:async()=>{cuts++;}});
  await f.connect(true); await f.post(conversation('Necesito dinero.',1));
  await until(()=>resolveFirst);
  await f.post(conversation('No necesito dinero.',2));
  resolveFirst({alerta:true,probabilidad:1});
  await until(()=>f.events.some(e=>e.type==='alert.updated'&&e.revision===2));
  assert.equal(cuts,0);
});

test('la voz del agente se muestra pero nunca entra al detector', async t => {
  const f=await fixture(t); await f.connect(); await f.post(conversation('No necesito pagos.',1));
  await until(()=>f.inputs.length===1);
  await f.post({type:'transcript',role:'assistant',transcriptType:'final',transcript:'¿Me estás pidiendo una transferencia?',timestamp:2,call:{id,assistantId}});
  await until(()=>f.events.some(e=>e.speaker==='agent'));
  assert.deepEqual(f.inputs,['No necesito pagos.']);
});

test('no permite vincular un segundo monitor automático ni una llamada preexistente', async t => {
  const f=await fixture(t); await f.connect(true);
  const response=await fetch(f.base+'/v1/phone/monitor',{method:'POST',headers:{'X-Voice-Token':code},body:JSON.stringify({consentimiento_analisis:true,consentimiento_corte_automatico:true})});
  assert.equal(response.status,409);
});

test('control Vapi: valida destino, identidad, evita redirecciones y nunca envía API key al control', async () => {
  const control=`https://phone-call-websocket.aws-us-west-2-backend-production3.vapi.ai/${id}/control`;
  for(const bad of ['http://localhost/control', `https://evil.test/${id}/control`, `https://vapi.ai.evil.test/${id}/control`, control.replace(id,'otro'), control.replace('https://','https://user@')]) assert.equal(vapiControlUrl(bad,id),null);
  const requests=[];
  const fetch=async(url,init)=>{ requests.push({url,init}); return new Response(JSON.stringify(url.startsWith('https://api.vapi.ai/') ? {id,assistantId,monitor:{controlUrl:control}} : {})); };
  assert.equal(await endVapiCall({id}, {apiKey:'private-test-key',assistantId,fetch}),'requested');
  assert.equal(requests[0].init.headers.Authorization,'Bearer private-test-key');
  assert.equal(requests[1].init.headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(requests[1].init.body),{type:'end-call'});
  assert.equal(requests[1].init.redirect,'error');
  await assert.rejects(endVapiCall({id},{apiKey:'test',assistantId,fetch:async()=>new Response(JSON.stringify({id,assistantId:'another',monitor:{controlUrl:control}}))}),/mismatch/);
});


test('diagnóstico autenticado no devuelve texto ni URLs privadas', async t => {
 const f=await fixture(t); await f.connect();
 const text='Texto sintético reservado para esta prueba.';
 await f.post(conversation(text));
 assert.equal((await fetch(f.base+'/v1/phone/diagnostics')).status,401);
 const r=await fetch(f.base+'/v1/phone/diagnostics',{headers:{'X-Voice-Token':code}});
 assert.equal(r.status,200);const d=await r.json();
 assert.equal(d.received,1);assert.equal(d.lastEvent.assistantMatches,true);
 assert.equal(JSON.stringify(d).includes(text),false);
 assert.equal(JSON.stringify(d).includes(secret),false);
});

test('diagnóstico conserva solo metadatos de estado y corte para revisar la última llamada', async t => {
 const text = 'Transfiere dinero o te haré daño.';
 const f = await fixture(t, { endCall: async () => 'requested', understand: async () => ({ rol: 'comprension', evidencias: [{ tipo: 'amenaza', cita: text }] }) });
 await f.connect(true); await f.post(conversation(text));
 await until(() => f.events.some(e => e.type === 'assessment.update') && f.events.some(e => e.type === 'call.hangup_result'));
 await f.post({ type: 'status-update', status: 'ended', call: { id, assistantId } });
 const d = await (await fetch(f.base + '/v1/phone/diagnostics', { headers: { 'X-Voice-Token': code } })).json();
 assert.equal(d.currentCall, null);
 assert.equal(d.lastCall.call_id, id);
 assert.equal(d.lastCall.assessment_state, 'alertar');
 assert.equal(d.lastCall.hangup_requested, true);
 assert.equal(d.lastCall.hangup_revision, 1);
 assert.equal(d.lastCall.hangup_status, 'requested');
 assert.equal(d.lastCall.end_reason, 'provider_ended');
 assert.equal(d.lastCall.alerta, true);
 assert.equal(typeof d.lastCall.detection_ms, 'number');
 assert.doesNotMatch(JSON.stringify(d), /Transfiere|haré daño|controlUrl|cita|transcripcion/);
});

test('cada turno ocupa su lugar entre ambas voces y se conserva al reconectar', async t => {
  const f = await fixture(t); await f.connect();
  await f.post({ type: 'status-update', status: 'in-progress', call: { id, assistantId } });
  const turn = (role, transcript, timestamp) => f.post({ type: 'transcript', transcriptType: 'final', role, transcript, timestamp, call: { id, assistantId } });
  await turn('assistant', 'Hola.', 10);
  await turn('user', 'Necesito ayuda.', 20);
  await turn('assistant', '¿Qué necesitas?', 30);
  await turn('user', 'Quiero verificar un pago.', 40);
  await turn('user', 'Puedo esperar.', 25); // Entrega fuera de orden.
  await until(() => f.inputs.at(-1) === 'Necesito ayuda.\nPuedo esperar.\nQuiero verificar un pago.');
  const latest = () => [...new Map(f.events.filter(e => e.type === 'transcript.update').map(e => [e.id, e])).values()].sort((a,b) => a.sequence-b.sequence);
  assert.deepEqual(latest().map(e => [e.speaker,e.text]), [
    ['agent','Hola.'], ['caller','Necesito ayuda.'], ['caller','Puedo esperar.'], ['agent','¿Qué necesitas?'], ['caller','Quiero verificar un pago.'],
  ]);
  assert.ok(latest().every(e => e.final && !e.text.includes('\n')));
  const before = f.events.length;
  await turn('user', 'Quiero verificar un pago.', 40);
  await delay(20);
  assert.equal(f.events.slice(before).filter(e=>e.type==='transcript.update').length,0);
  const replayStart=f.events.length; await f.connect();
  await until(()=>f.events.slice(replayStart).filter(e=>e.type==='transcript.update').length===5);
});

test('el porcentaje conserva una probabilidad intermedia sin forzar alerta ni corte', async t => {
  const f=await fixture(t,{detect:async()=>({alerta:false,probabilidad:.37})}); await f.connect(true);
  await f.post(conversation('Petición ficticia por verificar.'));
  await until(()=>f.events.some(e=>e.type==='risk.update'));
  assert.equal(f.events.find(e=>e.type==='risk.update').risk_percent,37);
  assert.equal(f.events.find(e=>e.type==='alert.updated').probability,.37);
  assert.equal(f.events.some(e=>e.type==='call.hangup_requested'),false);
});
