const failure = (code, retryable=false) => Object.assign(new Error(code), {code,retryable});

// The caller is the server-side report coordinator, after explicit report consent.
export async function requestMaritimeReport(transcript, config, options={}) {
  const request=options.fetch??fetch;
  let response;
  try {
    response=await request(config.endpoint,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??25000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`},
      body:JSON.stringify({message:JSON.stringify({consentimiento_analisis:true,consentimiento_reporte:true,transcripcion:transcript})}),
    });
  } catch { throw failure('report_agent_network_error'); }
  if(!response.ok) throw failure(`report_agent_http_${response.status}`);
  const body=await response.text();
  if(body.length>150000) throw failure('report_agent_invalid_response');
  let report;
  try { report=JSON.parse(JSON.parse(body).response); } catch { throw failure('report_agent_invalid_response'); }
  if(!report || report.generation?.provider!=='maritime' || typeof report.generation.model_id!=='string' ||
    !/^[a-zA-Z0-9_.:-]{1,100}$/.test(report.generation.model_id) || !Array.isArray(report.signals) ||
    report.signals.length>20 || !Array.isArray(report.entities) || report.entities.length>40) throw failure('report_agent_invalid_response');
  return report;
}
