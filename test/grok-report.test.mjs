import test from 'node:test';
import assert from 'node:assert/strict';
import {generateGrokReport,validateReport,reportSegments} from '../grok-report.mjs';
import {createReportCoordinator,reportsApiClient,reportIncidentId} from '../reports.mjs';
import {resolveReportProvider} from '../report-provider.mjs';

const transcript='Solicita transferir S/ 1500.50 a la cuenta BCP 191-1234567-0-01.\nIndica el teléfono 999 888 777.';
function result() {return {summary:'Se describe una solicitud de transferencia que requiere revisión.',recommendation:'Verificar el pedido por un canal independiente.',modality:'Solicitud de transferencia',limitations:['Los identificadores mencionados no verifican una identidad.'],
  signals:[{type:'dinero',explanation:'Se solicita una transferencia.',segment_id:'s0'}],
  entities:[{kind:'cuenta',value:'191-1234567-0-01',segment_id:'s0',bank:'BCP',wallet:null,currency:null},
    {kind:'telefono',value:'999 888 777',segment_id:'s1',bank:null,wallet:null,currency:null}]};}
const response=raw=>Response.json({model:'grok-test',choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}],usage:{prompt_tokens:120,completion_tokens:80,total_tokens:200}});

test('Maritime: usa el proxy configurado y registra proveedor, modelo y consumo correctos',async()=>{
  let calls=0;
  const output=await generateGrokReport(transcript,{provider:'maritime',apiKey:'proxy-test-token',baseUrl:'https://proxy.test/v1/',model:'gpt-4.1-mini',fetch:async(url,options)=>{
    calls++;
    assert.equal(url,'https://proxy.test/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer proxy-test-token');
    assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);
    assert.equal(body.model,'gpt-4.1-mini');
    assert.equal(body.response_format.json_schema.strict,true);
    return Response.json({model:'gpt-4.1-mini',choices:[{finish_reason:'stop',message:{content:JSON.stringify(result())}}],usage:{prompt_tokens:120,completion_tokens:80,total_tokens:200}});
  }});
  assert.equal(calls,1);assert.equal(output.generation.provider,'maritime');assert.equal(output.generation.model_id,'gpt-4.1-mini');
  assert.equal(output.generation.usage.total_tokens,200);assert.equal(JSON.stringify(output).includes('proxy-test-token'),false);
});

test('Maritime: no envía su token a un proveedor por defecto si falta URL y rechaza URLs inseguras',async()=>{
  const emptyEnv={TISKZ_REPORT_PROVIDER:'maritime',OPENAI_API_KEY:'private-test-token'};
  assert.equal(resolveReportProvider({},emptyEnv).configured,false);
  assert.equal(resolveReportProvider({},emptyEnv).endpoint,undefined);
  for(const baseUrl of ['http://proxy.test/v1','https://user:password@proxy.test/v1','https://proxy.test/v1?token=secret','https://proxy.test/v1#token','invalid']) {
    assert.throws(()=>resolveReportProvider({provider:'maritime',baseUrl},{}),error=>error.code==='report_invalid_base_url'&&!error.message.includes('secret'));
  }
  assert.throws(()=>resolveReportProvider({provider:'unsupported'},{}),error=>error.code==='report_invalid_provider');
});

test('Maritime remoto: el backend llama al agente privado y vuelve a validar los identificadores antes de guardar',async()=>{
  const agentId='11111111-1111-4111-8111-111111111111';
  const config={provider:'maritime',transport:'agent',agentId,apiKey:'private-agent-test-token'};
  const remote={...validateReport(result(),reportSegments(transcript)),generation:{provider:'maritime',model_id:'gpt-4.1-mini',usage:{total_tokens:200}}};
  const output=await generateGrokReport(transcript,{...config,fetch:async(url,options)=>{
    assert.equal(url,`https://api.maritime.sh/api/agents/${agentId}/chat`);
    assert.equal(options.headers.Authorization,'Bearer private-agent-test-token');
    const input=JSON.parse(JSON.parse(options.body).message);
    assert.equal(input.consentimiento_analisis,true);assert.equal(input.consentimiento_reporte,true);assert.equal(input.transcripcion,transcript);
    return Response.json({response:JSON.stringify(remote)});
  }});
  assert.equal(output.generation.provider,'maritime');assert.equal(output.entities[0].value,'191-1234567-0-01');
  remote.entities[0].value='cuenta-inventada';
  await assert.rejects(generateGrokReport(transcript,{...config,fetch:async()=>Response.json({response:JSON.stringify(remote)})}),error=>error.code==='grok_ungrounded_output');
  assert.equal(resolveReportProvider({provider:'maritime',transport:'agent',agentId},{}).configured,false);
  assert.throws(()=>resolveReportProvider({...config,agentId:'../../other'},{}),error=>error.code==='report_invalid_agent_id');
});

test('Maritime: estado inicial y errores conservan el proveedor del reporte',async()=>{
  const writes=[];
  const client=reportsApiClient({provider:'maritime',model:'gpt-4.1-mini',url:'https://panel.test/api/v1',key:'service-test-key',org:'team',fetch:async(url,options)=>{
    if(options.method==='GET') return Response.json({data:{analysis_meta:{report_generation:{status:'running'}}}});
    writes.push(JSON.parse(options.body));return Response.json({data:{ok:true}});
  }});
  const id=await client.open({session_id:'maritime-session',simulated:true,channel:'webrtc',started_at:'2026-10-17T20:00:00Z'});
  await client.fail(id,'grok_http_401');
  assert.equal(writes[0].analysis_meta.report_generation.provider,'maritime');
  assert.equal(writes[0].analysis_meta.report_generation.model_id,'gpt-4.1-mini');
  assert.equal(writes[1].analysis_meta.report_generation.provider,'maritime');
});

test('Grok: esquema estricto, contexto como datos y salida con referencias sin conservar citas',async()=>{
  let body;
  const output=await generateGrokReport(transcript,{apiKey:'fake-test-key',fetch:async(url,options)=>{
    assert.equal(url,'https://api.x.ai/v1/chat/completions');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer fake-test-key');body=JSON.parse(options.body);return response(result());
  }});
  assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.tools,undefined);
  assert.equal(output.entities[0].value,'191-1234567-0-01');assert.equal(output.generation.usage.total_tokens,200);
  assert.equal(output.entities[0].analysis_meta.source_segment,'s0');assert.equal(output.entities[0].analysis_meta.source_sha256.length,64);
  assert.equal(JSON.stringify(output).includes(transcript.split('\n')[0]),false);
  assert.equal(JSON.stringify(output).includes('fake-test-key'),false);
});

test('Grok: rechaza cifras reconstruidas, bancos sin sustento, ids inventados y campos adicionales',()=>{
  const segments=reportSegments(transcript);
  for(const change of [{value:'1911234567001'},{bank:'Interbank'},{segment_id:'s20'},{extra:'inyección'}]) {
    const raw=result();raw.entities[0]={...raw.entities[0],...change};assert.throws(()=>validateReport(raw,segments));
  }
  const raw=result();raw.entities[0].currency='USD';assert.throws(()=>validateReport(raw,segments));
  const copied=result();copied.summary=segments[0].text;assert.throws(()=>validateReport(copied,segments),error=>error.code==='grok_literal_transcript_rejected');
});

test('Grok: reintenta solo fallos temporales y no publica el cuerpo de error del proveedor',async()=>{
  let calls=0;
  const output=await generateGrokReport(transcript,{apiKey:'test',wait:async()=>{},fetch:async()=>++calls===1?new Response('secreto-del-proveedor',{status:429}):response(result())});
  assert.equal(calls,2);assert.ok(output.summary);
  calls=0;
  await assert.rejects(generateGrokReport(transcript,{apiKey:'test',fetch:async()=>{calls++;return new Response('secreto-del-proveedor',{status:401});}}),error=>error.code==='grok_http_401'&&!error.message.includes('secreto'));
  assert.equal(calls,1);
  await assert.rejects(generateGrokReport(transcript,{apiKey:'test',fetch:async()=>Response.json({choices:[{finish_reason:'length',message:{content:JSON.stringify(result())}}]})}),error=>error.code==='grok_incomplete_output');
});

test('Reportes: consentimiento independiente, generación única y payload compatible sin transcripción',async()=>{
  const calls=[];let generated=0;
  const client={open:async()=>{calls.push('open');return 'incident';},commit:async(id,payload)=>calls.push({id,payload}),fail:async()=>calls.push('failed')};
  const reporter=createReportCoordinator({enabled:true,client,generate:async text=>{generated++;assert.equal(text,transcript);return {...validateReport(result(),reportSegments(text)),generation:{provider:'xai',model_id:'grok-test',prompt_version:'pe-report-v1',usage:{}}};}});
  const snapshot={session_id:'session',reportConsent:true,simulated:true,channel:'webrtc',started_at:'2026-10-17T20:00:00Z',ended_at:'2026-10-17T20:01:00Z',text:transcript,decision:{alerta:true,probabilidad:0.8}};
  assert.equal((await reporter.finish({...snapshot,reportConsent:false})).status,'disabled');assert.equal(generated,0);
  const [a,b]=await Promise.all([reporter.finish(snapshot),reporter.finish(snapshot)]);
  assert.equal(a.status,'completed');assert.deepEqual(a,b);assert.equal(generated,1);
  const sent=calls.find(item=>typeof item==='object').payload;
  assert.equal(sent.analysis.risk_score,80);assert.equal(sent.analysis.generation.status,'completed');
  assert.equal(sent.session_id,'session');assert.equal(sent.simulated,true);assert.equal(JSON.stringify(sent).includes(transcript),false);
  await reporter.drain();
});

test('Reportes: un fallo genera estado failed, nunca un resultado seguro ni una entrega ficticia',async()=>{
  let failed,committed=false;
  const reporter=createReportCoordinator({enabled:true,client:{open:async()=> 'incident',commit:async()=>{committed=true;},fail:async(id,code)=>{failed={id,code};}},
    generate:async()=>{throw Object.assign(new Error('private error'),{code:'grok_invalid_output'});}});
  const output=await reporter.finish({session_id:'failed',reportConsent:true,text:transcript});
  assert.equal(output.status,'failed');assert.equal(committed,false);assert.deepEqual(failed,{id:'incident',code:'grok_invalid_output'});
  assert.equal(JSON.stringify(output).includes('private error'),false);
});

test('Reportes HTTP: claves solo de servidor, reutiliza el incidente de audio y conserva sus permisos',async()=>{
  const calls=[];let creates=0;
  const client=reportsApiClient({url:'https://panel.test/api/v1',key:'service-test-key',org:'team',fetch:async(url,options)=>{
    calls.push({url,options,body:options.body?JSON.parse(options.body):null});
    if(url.endsWith('/incidents')&&options.method==='POST') {creates++;return new Response('{}',{status:409});}
    if(options.method==='GET') return Response.json({data:{org_id:'team',agent_session_id:'session',simulated:true,consent_snapshot:{voice_storage:true},analysis_meta:{}}});
    return Response.json({data:{ok:true}});
  }});
  const id=await client.open({session_id:'session',simulated:true,channel:'webrtc',started_at:'2026-10-17T20:00:00Z'});
  assert.equal(id,reportIncidentId('team','session'));assert.equal(creates,1);
  assert.ok(calls.every(call=>call.options.headers['X-API-Key']==='service-test-key'&&call.options.redirect==='error'));
  const patch=calls.find(call=>call.options.method==='PATCH');assert.equal(patch.body.consent_snapshot.voice_storage,true);assert.equal(patch.body.consent_snapshot.report_storage,true);
  assert.equal(JSON.stringify(patch.body).includes('service-test-key'),false);
});

test('Reportes HTTP: reintentos del cierre usan exactamente el mismo run_id y contenido',async()=>{
  const bodies=[];
  const client=reportsApiClient({url:'https://panel.test/api/v1',key:'key',org:'team',wait:async()=>{},fetch:async(url,options)=>{
    bodies.push(options.body);if(bodies.length===1) throw Error('network');return Response.json({data:{duplicate:true}});
  }});
  const payload={run_id:'run',revision:1};await client.commit('incident',payload);
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
});

test('Reportes HTTP: una confirmación perdida no reemplaza un resumen completado por un fallo',async()=>{
  let patches=0;
  const client=reportsApiClient({url:'https://panel.test/api/v1',key:'key',org:'team',fetch:async(url,options)=>{
    if(options.method==='PATCH') patches++;
    return Response.json({data:{analysis_meta:{report_generation:{status:'completed'}}}});
  }});
  assert.equal((await client.fail('incident','reports_network_error')).already_completed,true);assert.equal(patches,0);
});
