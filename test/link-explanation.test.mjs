import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLinkExplanation} from '../link-explanation.mjs';
import {createReportServer} from '../report-server.mjs';

const context={case_a:{summary:'Se solicita transferir dinero con urgencia.'},
  case_b:{summary:'Se presiona para enviar dinero de inmediato.'},
  reasons:[{index:0,kind:'contenido',label:'Patrón de señales parecido'}]};
const answer={behavior_similarity:'similar',evidence_a:'transferir dinero con urgencia',
  evidence_b:'enviar dinero de inmediato',supporting_reason_indexes:[0],limitations:['La identidad no está verificada.']};
const proxy=output=>Response.json({model:'gpt-4.1-mini-2025-04-14',choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{total_tokens:120}});

test('Maritime compara resúmenes sintéticos y solo devuelve evidencia literal y razones existentes',async()=>{
  let sent;
  const result=await generateLinkExplanation(context,{provider:'maritime',apiKey:'test-only',baseUrl:'https://proxy.test/v1',fetch:async(url,init)=>{
    assert.equal(url,'https://proxy.test/v1/chat/completions');sent=JSON.parse(init.body);return proxy(answer);
  }});
  assert.equal(sent.response_format.json_schema.strict,true);
  assert.equal(JSON.parse(sent.messages[1].content).case_a.summary,context.case_a.summary);
  assert.equal(result.behavior_similarity,'similar');assert.equal(result.generation.provider,'maritime');
  assert.equal(result.generation.usage.total_tokens,120);
  for(const bad of [{...answer,evidence_b:'un dato inventado'},{...answer,supporting_reason_indexes:[7]}]) {
    await assert.rejects(generateLinkExplanation(context,{provider:'maritime',apiKey:'test-only',baseUrl:'https://proxy.test/v1',fetch:async()=>proxy(bad)}),
      error=>['link_ungrounded_output','link_invalid_output'].includes(error.code));
  }
});

test('el agente privado conserva su reporte y acepta el modo de vínculo con permisos explícitos',async()=>{
  let reports=0,links=0;
  const server=createReportServer({reportOptions:{provider:'maritime',apiKey:'test-only',baseUrl:'https://proxy.test/v1'},
    generateReport:async()=>{reports++;return {summary:'Reporte ficticio.'};},
    generateLinkExplanation:async()=>{links++;return {...answer,generation:{provider:'maritime'}};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/chat`;
    const post=input=>fetch(url,{method:'POST',body:JSON.stringify({message:JSON.stringify(input)})});
    const input={task:'explain_link',consentimiento_analisis:true,consentimiento_reporte:true,...context};
    assert.equal((await post({...input,consentimiento_reporte:false})).status,403);
    const response=await post(input);assert.equal(response.status,200);
    assert.equal(JSON.parse((await response.json()).response).behavior_similarity,'similar');
    assert.equal(links,1);assert.equal(reports,0);
    assert.equal((await post({consentimiento_analisis:true,consentimiento_reporte:true,transcripcion:'Prueba ficticia.'})).status,200);
    assert.equal(reports,1);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
