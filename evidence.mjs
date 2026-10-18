import { randomUUID } from 'node:crypto';
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/** La clave MCP pertenece al servidor; nunca se transmite a la APK. */
export function evidenceClient(config = {}) {
  const url = config.url ?? process.env.TISKZ_MCP_URL;
  const key = config.key ?? process.env.TISKZ_API_KEY;
  const org = config.org ?? process.env.TISKZ_ORG_ID;
  const request = config.fetch ?? fetch;
  return async (name, args) => {
    if (!url || !key || !org) throw error('El almacenamiento MCP todavía no está configurado.', 503);
    const destination = new URL(url);
    if (destination.protocol !== 'https:' && !config.fetch) throw error('MCP requiere HTTPS.', 503);
    const id = randomUUID();
    let response;
    try {
      response = await request(destination, {method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
        headers:{Authorization:`Bearer ${key}`, 'X-Tiskz-Org':org, 'Content-Type':'application/json', Accept:'application/json, text/event-stream', 'MCP-Protocol-Version':'2025-03-26'},
        body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
    } catch { throw error('No se pudo conectar con el almacenamiento MCP.', 502); }
    if (!response.ok) throw error(`El almacenamiento MCP devolvió HTTP ${response.status}.`, 502);
    const text = await response.text();
    if (text.length > 750000) throw error('Respuesta MCP demasiado grande.',502);
    let message;
    try {
      message = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))).find(item=>item.id===id)
        : JSON.parse(text);
    } catch { throw error('Respuesta MCP inválida.',502); }
    if (message?.id !== id || message.error || message.result?.isError || !Array.isArray(message.result?.content)) throw error('El MCP no pudo guardar o recuperar el fragmento.',502);
    return message.result.content;
  };
}

export function evidenceRoutes({authorizeRoom, body, mcp}) {
  return async (req,res,path) => {
    const match=path.match(/^\/v1\/sessions\/([a-f0-9-]+)\/evidence(?:\/(clip_[a-f0-9]{48}))?$/);
    if (!match) return false;
    const room=authorizeRoom(req,match[1]);
    if (!room.evidenceConsent) throw error('Esta sesión no autoriza conservar audio.',403);
    const respond=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if (req.method==='POST' && !match[2]) {
      if (room.evidenceBusy) throw error('Ya se está guardando un fragmento.',429);
      room.evidenceBusy=true;
      try {
        const input=await body(req,650000);
        if (!input || typeof input.audio_base64!=='string' || !/^[a-f0-9-]{36}$/i.test(input.request_id ?? '') || Object.keys(input).some(k=>!['request_id','audio_base64'].includes(k))) throw error('Fragmento inválido.',400);
        const risk=room.lastDecision?.alerta === true ? Math.round(room.lastDecision.probabilidad*100) : null;
        const content=await mcp('guardar_fragmento',{session_id:room.id,request_id:input.request_id,consentimiento_conservacion:true,audio_base64:input.audio_base64,source:'webrtc_microphone',risk_percent:risk});
        const data=JSON.parse(content.find(c=>c.type==='text')?.text ?? 'null');
        if (!data?.id) throw error('MCP no confirmó el guardado.',502);
        respond(201,{data});
      } finally {room.evidenceBusy=false;}
    } else if (req.method==='GET' && match[2]) {
      const content=await mcp('escuchar_fragmento',{session_id:room.id,fragment_id:match[2]});
      const audio=content.find(c=>c.type==='audio' && c.mimeType==='audio/wav');
      if (!audio) throw error('Audio no disponible.',502);
      res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.from(audio.data,'base64'));
    } else if (req.method==='GET') {
      const content=await mcp('listar_fragmentos',{session_id:room.id});
      respond(200,{data:JSON.parse(content.find(c=>c.type==='text')?.text ?? '[]')});
    } else throw error('Método no permitido.',405);
    return true;
  };
}
