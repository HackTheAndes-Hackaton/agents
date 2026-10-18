import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createVoiceServer } from '../voice.mjs';
import { evidenceClient } from '../evidence.mjs';

test('evidencia exige permiso separado y ticket productor; no acepta identidad o riesgo inventado desde la APK', async t=>{
  const calls=[];
  const id='clip_'+'a'.repeat(48);
  const server=await createVoiceServer({apiKey:'synthetic',accessCode:'synthetic-team-access',evidenceMcp:async(name,args)=>{
    calls.push({name,args});
    return name==='escuchar_fragmento' ? [{type:'audio',mimeType:'audio/wav',data:Buffer.from('wave').toString('base64')}] : [{type:'text',text:JSON.stringify({id})}];
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.closeVoice();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body,key)=>fetch(base+path,{method:'POST',headers:{'X-Voice-Token':key,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const create=async(consent)=> (await post('/v1/sessions',{consentimiento_analisis:true,consentimiento_conservacion:consent},'synthetic-team-access')).json();
  const denied=await create(false), allowed=await create(true);
  const payload={request_id:randomUUID(),audio_base64:'synthetic'};
  assert.equal((await post(`/v1/sessions/${denied.session_id}/evidence`,payload,denied.producer_token)).status,403);
  const path=`/v1/sessions/${allowed.session_id}/evidence`;
  assert.equal((await post(path,payload,allowed.observer_token)).status,401);
  assert.equal((await post(path,{...payload,caller_name:'Inventado'},allowed.producer_token)).status,400);
  assert.equal(calls.length,0);
  assert.equal((await post(path,payload,allowed.producer_token)).status,201);
  assert.equal(calls[0].args.risk_percent,null);
  assert.equal(calls[0].args.source,'webrtc_microphone');
  assert.equal(calls[0].args.session_id,allowed.session_id);
  const audio=await fetch(base+path+'/'+id,{headers:{'X-Voice-Token':allowed.producer_token}});
  assert.equal(audio.status,200);assert.equal(await audio.text(),'wave');
  await post(`/v1/sessions/${allowed.session_id}/end`,{},allowed.producer_token);
  assert.equal((await fetch(base+path+'/'+id,{headers:{'X-Voice-Token':allowed.producer_token}})).status,404);
});

test('cliente MCP protege credenciales en errores, no sigue redirecciones y procesa SSE',async()=>{
  const client=evidenceClient({url:'https://mcp.test',key:'private-synthetic',org:'org_vecinal',fetch:async(url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.headers['X-Tiskz-Org'],'org_vecinal');
    const request=JSON.parse(options.body);
    return new Response('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'[]'}]}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.equal((await client('listar_fragmentos',{}))[0].text,'[]');
  const failing=evidenceClient({url:'https://mcp.test',key:'private-synthetic',org:'org',fetch:async()=>{throw Error('private-synthetic');}});
  await assert.rejects(failing('listar_fragmentos',{}),e=>!e.message.includes('private-synthetic') && e.statusCode===502);
});

async function captureFixture(t,config={}) {
  const {WebSocket}=await import('ws');
  const code='synthetic-capture-team-access';
  const calls=[];
  const fragment='clip_'+'b'.repeat(48);
  const server=await createVoiceServer({apiKey:'synthetic',accessCode:code,maxSessions:5,
    detect:async()=>({alerta:true,probabilidad:.91}),understand:async()=>({evidencias:[]}),
    evidenceStore:async(name,args)=>{calls.push({name,args});return [{type:'text',text:JSON.stringify({id:fragment})}];},...config});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.closeVoice();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,data,key=code)=>fetch(base+path,{method:'POST',headers:{'X-Voice-Token':key,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const create=async(input={})=>(await post('/v1/sessions',{consentimiento_analisis:true,consentimiento_conservacion:true,audio_capture_protocol:1,...input})).json();
  const connect=async(room,producer=true)=>{
    const ws=new WebSocket(base.replace('http','ws')+`/ws/calls?session=${room.session_id}&ticket=${producer?room.producer_token:room.observer_token}`);
    const events=[];ws.on('message',raw=>events.push(JSON.parse(raw)));await once(ws,'open');return {ws,events};
  };
  return {calls,fragment,post,create,connect};
}
const waitFor=async(check)=>{const until=Date.now()+2000;while(!check()){if(Date.now()>until)throw Error('No llegó la orden o confirmación');await new Promise(r=>setTimeout(r,5));}};
const transcript=(ws,id,text='Caso ficticio: envía dinero bajo amenaza')=>ws.send(JSON.stringify({type:'transcript.update',id,text,final:true}));

test('detección solicita captura solo al productor y confirma después de guardar con el mismo request_id',async t=>{
  const f=await captureFixture(t);const room=await f.create();const producer=await f.connect(room),observer=await f.connect(room,false);
  transcript(producer.ws,'first');
  await waitFor(()=>producer.events.some(e=>e.type==='audio.capture_requested'));
  const command=producer.events.find(e=>e.type==='audio.capture_requested');
  assert.equal(command.session_id,room.session_id);assert.equal(command.window_ms,10000);assert.equal(command.revision,1);
  assert.ok(!observer.events.some(e=>e.type==='audio.capture_requested'));
  assert.ok(!producer.events.some(e=>e.type==='audio.capture_result' && e.status==='saved'));
  observer.ws.send(JSON.stringify({type:'audio.capture_failed',request_id:command.request_id,session_id:room.session_id,reason:'busy'}));
  producer.ws.send(JSON.stringify({type:'audio.capture_received',request_id:command.request_id,session_id:room.session_id}));
  const upload=await f.post(`/v1/sessions/${room.session_id}/evidence`,{request_id:command.request_id,audio_base64:'synthetic'},room.producer_token);
  assert.equal(upload.status,201);
  await waitFor(()=>producer.events.some(e=>e.type==='audio.capture_result' && e.status==='saved'));
  const saved=producer.events.find(e=>e.type==='audio.capture_result' && e.status==='saved');
  assert.equal(saved.request_id,command.request_id);assert.equal(saved.fragment_id,f.fragment);
  assert.equal(f.calls[0].args.request_id,command.request_id);assert.equal(f.calls[0].args.risk_percent,91);
  transcript(producer.ws,'second');await new Promise(r=>setTimeout(r,30));
  assert.equal(producer.events.filter(e=>e.type==='audio.capture_requested').length,1);
});

test('no ordena captura sin consentimiento, con cliente anterior o con detección FALSE',async t=>{
  const f=await captureFixture(t,{detect:async({transcripcion})=>({alerta:!transcripcion.includes('seguro'),probabilidad:transcripcion.includes('seguro')?.1:.9})});
  for(const input of [{consentimiento_conservacion:false},{audio_capture_protocol:undefined},{}]) {
    const room=await f.create(input),peer=await f.connect(room);
    transcript(peer.ws,'one',Object.keys(input).length?'Caso ficticio de amenaza':'Caso seguro ficticio');
    await waitFor(()=>peer.events.some(e=>e.type==='alert.updated'));
    assert.ok(!peer.events.some(e=>e.type==='audio.capture_requested'));
  }
});

test('solicitudes vencidas no conservan audio y el fallo de almacenamiento no se confirma como guardado',async t=>{
  const f=await captureFixture(t,{captureTimeoutMs:250,evidenceStore:async()=>{throw Error('unavailable');}});
  const room=await f.create(),peer=await f.connect(room);transcript(peer.ws,'one');
  await waitFor(()=>peer.events.some(e=>e.type==='audio.capture_result' && e.reason==='expired'));
  const first=peer.events.find(e=>e.type==='audio.capture_requested');
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/evidence`,{request_id:first.request_id,audio_base64:'synthetic'},room.producer_token)).status,410);
  transcript(peer.ws,'two');
  await waitFor(()=>peer.events.filter(e=>e.type==='audio.capture_requested').length===2);
  const second=peer.events.filter(e=>e.type==='audio.capture_requested')[1];
  assert.equal((await f.post(`/v1/sessions/${room.session_id}/evidence`,{request_id:second.request_id,audio_base64:'synthetic'},room.producer_token)).status,500);
  await waitFor(()=>peer.events.some(e=>e.reason==='storage_failed'));
  assert.ok(!peer.events.some(e=>e.type==='audio.capture_result' && e.status==='saved'));
});

test('cliente HTTP de evidencia usa la API sin MCP y conserva la clave en el servidor',async()=>{
 const {evidenceApiClient}=await import('../evidence.mjs');
 const seen=[];
 const client=evidenceApiClient({url:'https://panel.test/api/v1/audio-fragments',key:'synthetic-private',org:'org_vecinal',fetch:async(url,options)=>{
  seen.push({url:String(url),options});assert.equal(options.redirect,'error');
  return options.method==='POST'?Response.json({data:{id:'clip'}}):new Response('wave',{headers:{'Content-Type':'audio/wav'}});
 }});
 assert.equal(JSON.parse((await client('guardar_fragmento',{session_id:'s'}))[0].text).id,'clip');
 const audio=await client('escuchar_fragmento',{session_id:'s',fragment_id:'clip'});
 assert.equal(Buffer.from(audio[0].data,'base64').toString(),'wave');
 assert.equal(seen[0].options.headers['X-API-Key'],'synthetic-private');
 assert.ok(!seen[1].url.includes('synthetic-private'));
 assert.ok(!seen[0].options.body.includes('tools/call'));
});

test('una detección obsoleta no solicita capturar audio de otra revisión',async t=>{
  let release,started;
  const beginning=new Promise(resolve=>{started=resolve;});let calls=0;
  const f=await captureFixture(t,{detect:async()=>{
    if(++calls===1){started();return new Promise(resolve=>{release=resolve;});}
    return {alerta:false,probabilidad:.1};
  }});
  const room=await f.create(),peer=await f.connect(room);
  transcript(peer.ws,'first');await beginning;
  transcript(peer.ws,'second','Caso ficticio: no estoy amenazando ni pidiendo dinero');
  await waitFor(()=>peer.events.some(e=>e.id==='second' && e.final));
  release({alerta:true,probabilidad:.99});
  await waitFor(()=>peer.events.some(e=>e.type==='alert.updated' && e.revision===2));
  assert.ok(!peer.events.some(e=>e.type==='audio.capture_requested'));
});
