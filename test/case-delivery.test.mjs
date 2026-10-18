import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaseDelivery} from '../case-delivery.mjs';

const snapshot={session_id:'fictitious-session',simulated:true,text:'Contexto ficticio del equipo.',channel:'webrtc',
  started_at:'2026-10-17T20:00:00Z',ended_at:'2026-10-17T20:01:00Z',decision:{alerta:true,probabilidad:0.8}};
test('Entrega: solo datos, credenciales de integración y reintentos idénticos; nunca genera un reporte',async()=>{
  const calls=[];
  const delivery=createCaseDelivery({enabled:true,url:'https://panel.test/api/v1',key:'service-test-key',org:'team',wait:async()=>{},
    fetch:async(url,options)=>{calls.push({url,options});if(calls.length===1) throw Error('network');return Response.json({data:{status:'completed',incident_id:'case'}});}});
  const [a,b]=await Promise.all([delivery.finish(snapshot),delivery.finish(snapshot)]);
  assert.deepEqual(a,b);assert.equal(a.status,'completed');assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://panel.test/api/v1/case-finalizations');assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.body,calls[1].options.body);
  const sent=JSON.parse(calls[0].options.body);assert.equal(sent.text,snapshot.text);assert.equal(sent.summary,undefined);
  assert.equal(sent.consentimiento_reporte,undefined);assert.equal(sent.analysis,undefined);
  assert.equal(calls[0].options.headers['X-API-Key'],'service-test-key');
  await delivery.drain();
});
test('Entrega: desactivada por defecto, rechaza origen real y no vuelve a intentar permisos denegados',async()=>{
  let calls=0;
  const options={url:'https://panel.test/api/v1',key:'key',org:'team',fetch:async()=>{calls++;return new Response('{}',{status:403});}};
  assert.equal((await createCaseDelivery({...options,enabled:false}).finish(snapshot)).status,'disabled');
  const delivery=createCaseDelivery({...options,enabled:true});
  assert.equal((await delivery.finish({...snapshot,simulated:false})).status,'disabled');assert.equal(calls,0);
  assert.equal((await delivery.finish(snapshot)).error_code,'case_delivery_http_403');assert.equal(calls,1);
});
