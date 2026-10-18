import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportServer } from '../report-server.mjs';

async function fixture(run) {
  let calls = 0;
  const server = createReportServer({ reportOptions: { provider: 'maritime', apiKey: 'private-proxy-test', baseUrl: 'https://proxy.test/v1' },
    generateReport: async () => { calls++; return {summary:'Resumen ficticio.',generation:{provider:'maritime',model_id:'gpt-4.1-mini'}}; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = input => fetch(`${base}/chat`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:JSON.stringify(input)})});
  try { await run({base,chat,calls:()=>calls}); }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

test('Reportes privados: salud sin consumo; permisos separados y sin secretos en la respuesta',async()=>{
  await fixture(async({base,chat,calls})=>{
    const health=await (await fetch(`${base}/health`)).json();
    assert.equal(health.configured,true);assert.equal(health.provider,'maritime');assert.equal(calls(),0);
    assert.equal(JSON.stringify(health).includes('private-proxy-test'),false);
    assert.equal((await chat({consentimiento_analisis:true,transcripcion:'Ejemplo ficticio.'})).status,403);
    assert.equal(calls(),0);
    const response=await chat({consentimiento_analisis:true,consentimiento_reporte:true,transcripcion:'Ejemplo ficticio.'});
    assert.equal(response.status,200);assert.equal(calls(),1);
    assert.equal(JSON.parse((await response.json()).response).generation.provider,'maritime');
    assert.equal((await chat({consentimiento_analisis:true,consentimiento_reporte:true,transcripcion:'x'.repeat(12001)})).status,400);
    assert.equal(calls(),1);
  });
});

test('Reportes privados: rechaza cuerpos inválidos y no expone mensajes de error del proveedor',async()=>{
  const server=createReportServer({generateReport:async()=>{throw Error('secreto del proveedor');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/chat`,{method:'POST',body:'{'})).status,400);
    const response=await fetch(`${base}/chat`,{method:'POST',body:JSON.stringify({message:JSON.stringify({consentimiento_analisis:true,consentimiento_reporte:true,transcripcion:'Ejemplo ficticio.'})})});
    assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'report_generation_failed'});
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
