// Sesión exclusivamente ficticia: no escribe en el panel ni utiliza telefonía.
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {WebSocket} from 'ws';
import {createVoiceServer} from '../voice.mjs';
import {createReportCoordinator} from '../reports.mjs';
import {generateGrokReport} from '../grok-report.mjs';
import {resolveReportProvider} from '../report-provider.mjs';

const mock=process.argv.includes('--mock');
if(process.argv.slice(2).some(arg=>arg!=='--mock')) {
  console.error('Uso: npm run test:report [-- --mock]');process.exitCode=1;
} else if(!mock&&!resolveReportProvider().configured) {
  console.error('Configura el proveedor de reportes en .env.local para la prueba real o usa --mock.');process.exitCode=1;
} else {
  const text='Caso ficticio del equipo. Solicita transferir S/ 1500.50 a la cuenta BCP 191-1234567-0-01.\nIndica el teléfono ficticio 999 888 777.';
  const mockResult={summary:'En el ejemplo ficticio se solicita una transferencia y se menciona un teléfono. Los datos requieren revisión.',
    recommendation:'Contrastar la solicitud mediante un canal independiente.',modality:'Solicitud de transferencia',limitations:['Prueba ficticia sin identidad verificada.'],
    signals:[{type:'dinero',explanation:'Se plantea una transferencia en el contexto de prueba.',segment_id:'s0'}],
    entities:[{kind:'cuenta',value:'191-1234567-0-01',segment_id:'s0',bank:'BCP',wallet:null,currency:null},
      {kind:'telefono',value:'999 888 777',segment_id:'s1',bank:null,wallet:null,currency:null}]};
  const accessCode=randomBytes(24).toString('base64url');
  let delivered,failed,server,socket;
  const started=Date.now();
  const reporter=createReportCoordinator({enabled:true,
    client:{open:async()=> 'local_fictional_incident',commit:async(_id,payload)=>{delivered=payload;},fail:async(_id,code)=>{failed=code;}},
    generate:context=>generateGrokReport(context,mock?{provider:'xai',apiKey:'mock-only',fetch:async()=>Response.json({model:'modelo-simulado',
      choices:[{finish_reason:'stop',message:{content:JSON.stringify(mockResult)}}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})}:{}),
  });
  try {
    server=await createVoiceServer({accessCode,apiKey:'unused-local-fixture',reporter,reportSimulated:true,
      detect:async()=>({alerta:true,probabilidad:0.8}),understand:async()=>({rol:'comprension',evidencias:[],limitaciones:[]})});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}`;
    const post=async(path,body,token=accessCode)=>{
      const response=await fetch(base+path,{method:'POST',signal:AbortSignal.timeout(5000),headers:{'X-Voice-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok) throw Error(`demo_http_${response.status}`);return response.json();
    };
    const room=await post('/v1/sessions',{consentimiento_analisis:true,consentimiento_reporte:true});
    socket=new WebSocket(base.replace('http','ws')+`/ws/calls?session=${room.session_id}&ticket=${room.producer_token}`);
    const received=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('demo_transcript_timeout')),5000);
      socket.on('message',data=>{const event=JSON.parse(data);if(event.type==='transcript.update'&&event.id==='fictional'){clearTimeout(timer);resolve();}});
      socket.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    await once(socket,'open');
    socket.send(JSON.stringify({type:'transcript.update',id:'fictional',text,speaker:'caller',final:true}));
    await received;
    await post(`/v1/sessions/${room.session_id}/end`,{},room.producer_token);
    await reporter.drain();
    if(failed||!delivered) throw Error(failed??'demo_report_not_delivered');
    console.log(JSON.stringify({status:'completed',simulated:true,provider:mock?'mock':delivered.analysis.generation.provider,persisted_to_panel:false,
      model:delivered.analysis.generation.model_id,usage:delivered.analysis.generation.usage,
      summary:delivered.analysis.summary,signals:delivered.signals.length,entities:delivered.entities.length,elapsed_ms:Date.now()-started},null,2));
  } catch(error) {
    const code=/^(grok_|report_|reports_|demo_)[a-zA-Z0-9_]+$/.test(error?.code??error?.message??'')?(error.code??error.message):'demo_failed';
    console.error(JSON.stringify({status:'failed',error_code:code,provider:mock?'mock':resolveReportProvider().provider}));process.exitCode=1;
  } finally {
    socket?.terminate();
    if(server) {await server.closeVoice();await new Promise(resolve=>server.close(resolve));}
  }
}
