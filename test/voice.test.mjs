import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createVoiceServer } from '../voice.mjs';
import { groundUnderstanding } from '../understanding.mjs';
const code = 'test-access-code-only-for-tests';
async function fixture(t, config = {}) {
  const server = await createVoiceServer({ apiKey: 'test-key', accessCode: code, detect: async () => ({ alerta: true, probabilidad: .9 }), understand: async () => ({ rol: 'comprension', evidencias: [], limitaciones: [] }), ...config });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.closeVoice(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, key = code) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = async (input = {}) => { const r = await post('/v1/sessions', { consentimiento_analisis: true, ...input }); assert.equal(r.status, 201); return r.json(); };
  const connect = async (room, producer = true) => {
    const ws = new WebSocket(base.replace('http', 'ws') + `/ws/calls?session=${room.session_id}&ticket=${producer ? room.producer_token : room.observer_token}`);
    const events = []; ws.on('message', data => events.push(JSON.parse(data))); await once(ws, 'open'); return { ws, events };
  };
  return { server, base, post, create, connect };
}
async function until(check) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw Error('No llegó el evento esperado'); await new Promise(r => setTimeout(r, 10)); } }

test('Voz: exige acceso y consentimiento, y sirve la interfaz sin credenciales', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/v1/sessions', { consentimiento_analisis: true }, 'wrong')).status, 401);
  assert.equal((await f.post('/v1/sessions', {})).status, 400);
  const proxied = await fetch(f.base + '/v1/sessions', { method: 'POST', headers: { 'X-Voice-Token': code, 'Content-Type': 'application/json' }, body: JSON.stringify({ consentimiento_analisis: true }) });
  assert.equal(proxied.status, 201);
  const html = await (await fetch(f.base)).text(); assert.ok(html.includes('PhoneWard')); assert.ok(!html.includes(code));
});

test('Voz: observador no inyecta texto, sesiones aisladas y final duplicado no cobra de nuevo', async t => {
  let detections = 0;
  const f = await fixture(t, { detect: async () => { detections++; return { alerta: true, probabilidad: .9 }; } });
  const room = await f.create(), other = await f.create();
  const p = await f.connect(room), o = await f.connect(room, false), isolated = await f.connect(other, false);
  o.ws.send(JSON.stringify({ type: 'transcript.update', id: 'forged', text: 'injection', final: true }));
  p.ws.send('null');
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'a', text: 'Deposita o te haré daño', final: true }));
  await until(() => o.events.some(e => e.type === 'alert.updated'));
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'a', text: 'Deposita o te haré daño', final: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(detections, 1); assert.ok(!o.events.some(e => e.id === 'forged'));
  assert.ok(!isolated.events.some(e => e.type === 'transcript.update'));
  const result = o.events.find(e => e.type === 'alert.updated'); assert.equal(result.alerta, true); assert.equal(result.probability, .9);
});

test('Voz: descarta análisis obsoleto y un fallo del modelo no equivale a FALSE', async t => {
  let release, count = 0;
  const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { detect: async () => { if (++count === 1) await gate; throw Error('upstream unavailable'); }, understand: async () => { await gate; return { rol: 'comprension' }; } });
  const room = await f.create(), p = await f.connect(room);
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'a', text: 'primer contexto', final: true }));
  await until(() => count === 1);
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'b', text: 'nuevo contexto', final: true }));
  await until(() => p.events.filter(e => e.type === 'transcript.update').length === 2); release();
  await until(() => p.events.some(e => e.component === 'deteccion'));
  assert.ok(!p.events.some(e => e.type === 'alert.updated'));
  assert.ok(!p.events.some(e => e.type === 'understanding.update' && e.revision === 1));
  assert.equal(count, 2);
});

test('Voz: negocia SDP con credencial del servidor y cierra la llamada al terminar', async t => {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, data });
    if (req.url.endsWith('/hangup')) { res.writeHead(200); res.end('{}'); }
    else { res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/v1/realtime/calls/rtc_test' }); res.end('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => new Promise(r => provider.close(r)));
  const f = await fixture(t, { baseUrl: `http://127.0.0.1:${provider.address().port}/v1` });
  const room = await f.create();
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/offer`, { sdp: 'bad' }, room.observer_token)).status, 401);
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/offer`, { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }, room.producer_token)).status, 201);
  assert.equal(calls[0].authorization, 'Bearer test-key'); assert.ok(calls[0].data.includes('gpt-live-transcribe')); assert.ok(calls[0].data.includes('"turn_detection":null'));
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/end`, {}, room.producer_token)).status, 200);
  assert.equal(calls[1].path, '/v1/realtime/calls/rtc_test/hangup');
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/end`, {}, room.producer_token)).status, 404);
});

test('Voz: tickets vencen con la sesión', async t => {
  const f = await fixture(t, { sessionMs: 80 }); const room = await f.create(); const p = await f.connect(room);
  await until(() => p.events.some(e => e.type === 'call.ended'));
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/offer`, {}, room.producer_token)).status, 404);
});

test('Voz: la comprensión lenta no bloquea nuevas detecciones', async t => {
  let release, detections = 0;
  const gate = new Promise(r => { release = r; });
  const f = await fixture(t, { detect: async () => { detections++; return { alerta: false, probabilidad: .1 }; }, understand: async () => { await gate; return { rol: 'comprension' }; } });
  t.after(() => release());
  const room = await f.create(), p = await f.connect(room);
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'a', text: 'Primer fragmento autorizado', final: true }));
  await until(() => p.events.some(e => e.type === 'alert.updated'));
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'b', text: 'Segundo fragmento autorizado', final: true }));
  await until(() => p.events.some(e => e.type === 'alert.updated' && e.revision === 2));
  assert.equal(detections, 2); assert.ok(!p.events.some(e => e.type === 'understanding.update')); release();
});

test('Voz: acepta SDP serializado por un proxy y evita renegociar sin Location', async t => {
  const provider = http.createServer((req, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => new Promise(r => provider.close(r)));
  const f = await fixture(t, { baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }); const room = await f.create();
  const path = `/v1/sessions/${room.session_id}/offer`, input = { sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  const r = await f.post(path, input, room.producer_token); assert.equal(r.status, 201); assert.ok((await r.json()).sdp.startsWith('v='));
  assert.equal((await f.post(path, input, room.producer_token)).status, 409);
});

test('Voz: retransmite la secuencia de turnos aunque lleguen finales invertidos', async t => {
  const f = await fixture(t); const room = await f.create(), p = await f.connect(room);
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'second', text: 'Ni datos personales.', sequence: 1, final: true }));
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'first', text: 'No necesito pagos.', sequence: 0, final: true }));
  await until(() => p.events.filter(e => e.type === 'transcript.update').length === 2);
  const lines = p.events.filter(e => e.type === 'transcript.update');
  assert.deepEqual(lines.map(e => [e.id, e.sequence]), [['second', 1], ['first', 0]]);
});

test('Voz: conserva límites entre turnos sin puntuación para validar citas completas', async t => {
  const f = await fixture(t, { understand: async incident => groundUnderstanding({ rol: 'comprension', evidencias: [{ tipo: 'negacion', cita: 'No necesito pagos ni datos personales.' }] }, incident.transcripcion) });
  const room = await f.create(), p = await f.connect(room);
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'a', text: 'Confirmamos la reunión a las diez', sequence: 0, final: true }));
  p.ws.send(JSON.stringify({ type: 'transcript.update', id: 'b', text: 'No necesito pagos ni datos personales.', sequence: 1, final: true }));
  await until(() => p.events.some(e => e.type === 'understanding.update' && e.revision === 2));
  assert.equal(p.events.find(e => e.type === 'understanding.update' && e.revision === 2).analysis.evidencias[0].cita, 'No necesito pagos ni datos personales.');
});


test('Live: exige consentimiento específico, negocia Marin y analiza solo a quien llama', async t => {
  const calls = [], transcripts = [];
  const provider = http.createServer(async (req, res) => {
    let raw=''; for await (const c of req) raw+=c;
    calls.push({path:req.url,body:JSON.parse(raw),authorization:req.headers.authorization});
    res.writeHead(req.url.endsWith('/hangup')?200:201, {'Content-Type':'application/json'});
    res.end(JSON.stringify(req.url.endsWith('/hangup')?{}:{session:{id:'live_opaque_ID'},transport:{type:'webrtc',sdp:'v=0\r\nm=audio 9 RTP/AVP 0\r\n'}}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>new Promise(r=>provider.close(r)));
  const f=await fixture(t,{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,liveAnalysisMs:15,detect:async incident=>{transcripts.push(incident.transcripcion);return{alerta:false,probabilidad:.1}}});
  assert.equal((await f.post('/v1/sessions',{consentimiento_analisis:true,mode:'assistant'})).status,400);
  const room=await f.create({mode:'assistant',consentimiento_voz_ia:true});
  const p=await f.connect(room),o=await f.connect(room,false);
  const r=await f.post(`/v1/sessions/${room.session_id}/offer`,{sdp:'v=0\r\nm=audio 9 RTP/AVP 0\r\n'},room.producer_token);
  assert.equal(r.status,201);assert.equal((await r.json()).voice,'marin');
  assert.equal(calls[0].body.session.model,'gpt-live-1');assert.equal(calls[0].body.session.audio.output.voice,'marin');assert.equal(calls[0].authorization,'Bearer test-key');
  const send=(ws,e)=>ws.send(JSON.stringify({type:'live.event',event:e}));
  send(o.ws,{type:'session.input_transcript.delta',event_id:'forged',delta:'Deposita dinero',start_ms:0,end_ms:5});
  send(p.ws,{type:'session.output_transcript.delta',event_id:'agent',delta:'Transfiere dinero',start_ms:0,end_ms:5});
  send(p.ws,{type:'session.input_transcript.delta',event_id:'b',delta:' necesito pagos.',start_ms:30,end_ms:40});
  send(p.ws,{type:'session.input_transcript.delta',event_id:'a',delta:'No',start_ms:10,end_ms:20});
  await until(()=>p.events.some(e=>e.type==='alert.updated'));
  assert.deepEqual(transcripts,['No necesito pagos.']);
  assert.ok(p.events.some(e=>e.type==='live.command'&&e.command.type==='session.thinking.append'));
  p.ws.send(JSON.stringify({type:'transcript.update',id:'legacy',text:'Amenaza',final:true}));
  await new Promise(r=>setTimeout(r,30));assert.equal(transcripts.length,1);
  await f.post(`/v1/sessions/${room.session_id}/end`,{},room.producer_token);
  assert.equal(calls.at(-1).path,'/v1/live/sessions/live_opaque_ID/hangup');
});

test('Entrega WebRTC: datos al cerrar sin decisiones de reporte en el cliente ni voz del agente',async t=>{
  const snapshots=[];
  const caseDelivery={enabled:true,finish:async snapshot=>{snapshots.push(snapshot);return {status:'completed'};},drain:async()=>{}};
  const f=await fixture(t,{caseDelivery,caseSimulated:true});
  const room=await f.create();const p=await f.connect(room);
  p.ws.send(JSON.stringify({type:'transcript.update',id:'caller',text:'Solicitud ficticia de 100 soles.',speaker:'caller',final:true}));
  p.ws.send(JSON.stringify({type:'transcript.update',id:'agent',text:'Respuesta del agente que no se debe exportar.',speaker:'agent',final:true}));
  await until(()=>p.events.filter(e=>e.type==='transcript.update').length===2);
  await f.post(`/v1/sessions/${room.session_id}/end`,{},room.producer_token);
  assert.equal(snapshots.length,1);assert.equal(snapshots[0].text,'Solicitud ficticia de 100 soles.');
  assert.equal(snapshots[0].session_id,room.session_id);assert.equal(snapshots[0].simulated,true);
  const other=await f.create({consentimiento_conservacion:true});
  await f.post(`/v1/sessions/${other.session_id}/end`,{},other.producer_token);
  assert.equal(snapshots.length,2);
});

test('Reportes WebRTC: una revisión de detección anterior no se exporta como estimación final',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const snapshots=[];
  const f=await fixture(t,{caseDelivery:{enabled:true,finish:async snapshot=>snapshots.push(snapshot),drain:async()=>{}},detect:async()=>{await gate;return {alerta:true,probabilidad:.9};}});
  const room=await f.create();const p=await f.connect(room);
  p.ws.send(JSON.stringify({type:'transcript.update',id:'waiting',text:'Contexto ficticio pendiente.',final:true}));
  await until(()=>p.events.some(e=>e.type==='transcript.update'));
  await f.post(`/v1/sessions/${room.session_id}/end`,{},room.producer_token);release();
  assert.equal(snapshots[0].decision,null);
});
