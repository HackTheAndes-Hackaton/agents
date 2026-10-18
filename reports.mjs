import {createHash,randomUUID} from 'node:crypto';
import {generateGrokReport} from './grok-report.mjs';
import {resolveReportProvider} from './report-provider.mjs';

const failure=(code,status)=>Object.assign(new Error(code),{code,status});
export const reportIncidentId=(org,session)=>`aud_${createHash('sha256').update(`${org}:${session}`).digest('hex').slice(0,48)}`;
export function reportsApiClient(options={}) {
  const reportProvider=resolveReportProvider(options);
  const configuredUrl=options.url??process.env.TISKZ_API_URL;
  const key=options.key??process.env.TISKZ_API_KEY, org=options.org??process.env.TISKZ_ORG_ID;
  let base;
  if(configuredUrl) {
    base=new URL(configuredUrl);
    if((base.protocol!=='https:'&&!options.fetch)||base.username||base.password||base.search||base.hash) throw failure('reports_invalid_url');
    base=base.href.replace(/\/$/,'');
  }
  const request=options.fetch??fetch, wait=options.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  async function api(path,method='GET',body) {
    if(!base||!key||!org) throw failure('reports_not_configured');
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const response=await request(`${base}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??8000),
          headers:{'X-API-Key':key,'X-Tiskz-Org':org,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        if(!response.ok) throw failure(`reports_http_${response.status}`,response.status);
        const text=await response.text();if(text.length>250000) throw failure('reports_invalid_response');
        const result=JSON.parse(text);if(!result||!Object.hasOwn(result,'data')) throw failure('reports_invalid_response');
        return result.data;
      } catch(error) {
        const code=error?.code?.startsWith?.('reports_')?error:failure('reports_network_error');
        if(attempt===2 || (code.status && code.status!==429 && code.status<500) || code.code==='reports_invalid_response') throw code;
        await wait(100*(attempt+1));
      }
    }
  }
  return {
    configured:Boolean(base&&key&&org),
    async open(info) {
      const id=reportIncidentId(org,info.session_id);
      const data={id,org_id:org,agent_session_id:info.session_id,started_at:info.started_at,simulated:info.simulated,
        title:'Reporte de prueba · resumen pendiente',channel:info.channel,analysis_status:'running',
        consent_snapshot:{report_storage:true,report_sharing:true},
        analysis_meta:{report_generation:{status:'running',provider:reportProvider.provider,model_id:reportProvider.model},
          report_time_source:info.time_source??'session_started'}};
      try {await api('/incidents','POST',data);}
      catch(error) {
        if(error.status!==409) throw error;
        const current=await api(`/incidents/${id}`);
        if(current.org_id!==org||current.agent_session_id!==info.session_id||current.simulated!==info.simulated||current.sharing_revoked_at) throw failure('reports_source_conflict');
        if(current.analysis_meta?.findings_batch) throw failure('reports_already_finalized');
        // Una carga de audio puede haber creado primero este mismo incidente.
        await api(`/incidents/${id}`,'PATCH',{started_at:info.started_at,analysis_status:'running',
          consent_snapshot:{...current.consent_snapshot,report_storage:true,report_sharing:true},analysis_meta:data.analysis_meta});
      }
      return id;
    },
    async commit(id,payload) {return api(`/incidents/${id}/findings`,'POST',payload);},
    async fail(id,code) {
      const current=await api(`/incidents/${id}`);
      if(current.analysis_meta?.report_generation?.status==='completed') return {already_completed:true};
      return api(`/incidents/${id}`,'PATCH',{analysis_status:'failed',analysis_meta:{report_generation:{status:'failed',provider:reportProvider.provider,error_code:code}}});
    },
  };
}

/** Trabajo acotado en el backend de voz existente; no bloquea el corte de llamadas. */
export function createReportCoordinator(options={}) {
  const client=options.client??reportsApiClient(options);
  const generate=options.generate??(text=>generateGrokReport(text,options));
  const enabled=options.enabled??(process.env.TISKZ_REPORTS_ENABLED==='true'&&client.configured&&resolveReportProvider(options).configured);
  const jobs=new Map(), pending=new Set();
  function finish(snapshot) {
    if(snapshot.reportConsent!==true || !enabled) return Promise.resolve({status:'disabled'});
    if(jobs.has(snapshot.session_id)) return jobs.get(snapshot.session_id);
    if(pending.size>=8) return Promise.resolve({status:'failed',error_code:'reports_busy'});
    // El objeto es separado de la sesión, que puede limpiar sus buffers inmediatamente.
    const input={...snapshot};
    const job=(async()=>{
      let id;
      try {
        id=await client.open(input);
        const report=await generate(input.text);
        const probability=input.decision?.probabilidad;
        const risk=Number.isFinite(probability)&&probability>=0&&probability<=1?Math.round(probability*100):null;
        const runId=randomUUID();
        const payload={schema_version:'pe-v1',run_id:runId,revision:1,session_id:input.session_id,simulated:input.simulated,ended_at:input.ended_at,
          analysis:{risk_score:risk,verdict:report.signals.length||input.decision?.alerta===true?'suspicious':'none',
            risk_reasons:report.signals.map(signal=>signal.explanation),summary:report.summary,recommendation:report.recommendation,
            scam_type:report.modality,impersonating:null,model_id:report.generation.model_id,
            generation:{...report.generation,status:'completed',generation_id:runId,limitations:report.limitations}},
          signals:report.signals,entities:report.entities};
        await client.commit(id,payload);
        return {status:'completed',incident_id:id};
      } catch(error) {
        const code=/^(grok_|report_|reports_)[a-zA-Z0-9_]+$/.test(error?.code??'')?error.code:'report_generation_failed';
        if(id) {try {if((await client.fail(id,code))?.already_completed) return {status:'completed',incident_id:id};} catch { /* No registrar cuerpos, claves ni conversación. */ }}
        return {status:'failed',incident_id:id??null,error_code:code};
      } finally {input.text='';}
    })();
    jobs.set(snapshot.session_id,job);pending.add(job);
    void job.finally(()=>{pending.delete(job);while(jobs.size>32) jobs.delete(jobs.keys().next().value);});
    return job;
  }
  return {enabled,finish,async drain(){await Promise.allSettled([...pending]);}};
}
