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
