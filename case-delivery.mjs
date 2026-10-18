import {randomUUID} from 'node:crypto';

// Solo transporte servidor a servidor. El análisis y los permisos del reporte pertenecen a la web.
export function createCaseDelivery(options={}) {
  const url=options.url??process.env.TISKZ_API_URL;
  const key=options.key??process.env.TISKZ_API_KEY, org=options.org??process.env.TISKZ_ORG_ID;
  let endpoint;
  if(url) {
    const base=new URL(url);
    if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash) throw Error('case_delivery_invalid_url');
    endpoint=base.href.replace(/\/$/,'')+'/case-finalizations';
  }
  const enabled=options.enabled??(process.env.TISKZ_CASE_DELIVERY_ENABLED==='true'&&process.env.TISKZ_CASES_SIMULATED==='true'&&Boolean(endpoint&&key&&org));
  const request=options.fetch??fetch, wait=options.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const jobs=new Map(),pending=new Set();
  function finish(snapshot) {
    if(!enabled||snapshot.simulated!==true||!snapshot.text?.trim()) return Promise.resolve({status:'disabled'});
    if(jobs.has(snapshot.session_id)) return jobs.get(snapshot.session_id);
    if(pending.size>=8) return Promise.resolve({status:'failed',error_code:'case_delivery_busy'});
    const decision=snapshot.decision;
    let body=JSON.stringify({request_id:randomUUID(),session_id:snapshot.session_id,simulated:true,
      started_at:snapshot.started_at,ended_at:snapshot.ended_at,channel:snapshot.channel,time_source:snapshot.time_source??'session_started',text:snapshot.text,
      decision:typeof decision?.alerta==='boolean'&&Number.isFinite(decision?.probabilidad)&&decision.probabilidad>=0&&decision.probabilidad<=1
        ?{alerta:decision.alerta,probabilidad:decision.probabilidad}:null});
    const job=(async()=>{
      try {
        for(let attempt=0;attempt<3;attempt++) {
          try {
            if(!endpoint||!key||!org) return {status:'failed',error_code:'case_delivery_not_configured'};
            const response=await request(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??55000),
              headers:{'Content-Type':'application/json','X-API-Key':key,'X-Tiskz-Org':org},body});
            if(!response.ok) {
              if(attempt<2&&(response.status===429||response.status>=500)) {await wait(100*(attempt+1));continue;}
              return {status:'failed',error_code:`case_delivery_http_${response.status}`};
            }
            const data=await response.json();
            return data?.data?.status?{status:data.data.status,incident_id:data.data.incident_id}:{status:'failed',error_code:'case_delivery_invalid_response'};
          } catch {
            if(attempt===2) return {status:'failed',error_code:'case_delivery_network_error'};
            await wait(100*(attempt+1));
          }
        }
      } finally {body='';}
    })();
    jobs.set(snapshot.session_id,job);pending.add(job);
    void job.finally(()=>{pending.delete(job);while(jobs.size>32) jobs.delete(jobs.keys().next().value);});
    return job;
  }
  return {enabled,finish,async drain(){await Promise.allSettled([...pending]);}};
}
