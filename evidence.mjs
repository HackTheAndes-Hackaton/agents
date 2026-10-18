import { randomUUID } from 'node:crypto';
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/** Ruta HTTP para la subida determinista; MCP sigue usando el mismo servicio. */
export function evidenceApiClient(config = {}) {
  const url = config.url ?? process.env.TISKZ_AUDIO_API_URL;
  const key = config.key ?? process.env.TISKZ_API_KEY;
  const org = config.org ?? process.env.TISKZ_ORG_ID;
  const request = config.fetch ?? fetch;
  return async (operation, args) => {
    if (!url || !key || !org) throw error('El almacenamiento de audio no está configurado.',503);
    const destination = new URL(url);
    if (destination.protocol !== 'https:' && !config.fetch) throw error('El almacenamiento requiere HTTPS.',503);
    const save = operation === 'guardar_fragmento';
    if (!save) {
      if (operation === 'escuchar_fragmento') destination.pathname += '/' + encodeURIComponent(args.fragment_id);
      else if (operation !== 'listar_fragmentos') throw error('Operación de audio inválida.',400);
      destination.searchParams.set('session_id',args.session_id);
    }
    let response;
    try { response = await request(destination,{method:save?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'X-API-Key':key,'X-Tiskz-Org':org,...(save?{'Content-Type':'application/json'}:{})},...(save?{body:JSON.stringify(args)}:{})}); }
    catch { throw error('No se pudo conectar con el almacenamiento de audio.',502); }
    if (!response.ok) throw error(`Almacenamiento de audio: HTTP ${response.status}.`,502);
    if (operation === 'escuchar_fragmento') {
      if (!response.headers.get('content-type')?.startsWith('audio/wav')) throw error('Respuesta de audio inválida.',502);
      const audio=Buffer.from(await response.arrayBuffer());
      if (audio.length>480044) throw error('Respuesta de audio demasiado grande.',502);
      return [{type:'audio',mimeType:'audio/wav',data:audio.toString('base64')}];
    }
    const result=await response.json();
    if (!result || !('data' in result)) throw error('Respuesta de almacenamiento inválida.',502);
    return [{type:'text',text:JSON.stringify(result.data)}];
  };
}

export function captureControl(emit, timeoutMs = 30000) {
  const result = (room, item, status, extra={}) => emit(room,{type:'audio.capture_result',request_id:item.id,revision:item.revision,status,...extra});
  const fail = (room,item,reason) => { clearTimeout(item.timer);item.state='failed';item.reason=reason;result(room,item,'failed',{reason}); };
  const command = item => ({type:'audio.capture_requested',request_id:item.id,revision:item.revision,window_ms:10000,expires_at:new Date(item.expires).toISOString()});
  return {
    request(room, revision, decision) {
      if (room.closed || !room.evidenceConsent || room.captureProtocol!==1 || decision.alerta!==true) return;
      room.captureRequests ??= new Map();
      const previous=room.captureCurrent;
      if (previous && ['requested','saving','saved'].includes(previous.state)) return;
      if (room.captureRequests.size>=3 || previous?.revision>=revision) return;
      const item={id:randomUUID(),revision,riskPercent:Math.round(decision.probabilidad*100),state:'requested',expires:Date.now()+timeoutMs};
      room.captureRequests.set(item.id,item);room.captureCurrent=item;
      item.timer=setTimeout(()=>{if (!room.closed && item.state==='requested') fail(room,item,'expired');},timeoutMs).unref();
      emit(room,command(item));
    },
    replay(room,client) {
      const item=room.captureCurrent;
      if (!item || room.closed) return;
      if (item.state==='requested' && item.expires>Date.now()) client.send(JSON.stringify({...command(item),session_id:room.id}));
    },
    clientEvent(room,event) {
      const item=room.captureRequests?.get(event.request_id);
      if (!item || item.state!=='requested' || event.session_id!==room.id) return;
      if (event.type==='audio.capture_received') item.received=true;
      if (event.type==='audio.capture_failed' && ['no_audio','busy','expired','capture_unavailable'].includes(event.reason)) fail(room,item,event.reason);
    },
    beforeUpload(room,id) {
      const item=room.captureRequests?.get(id);
      if (!item) return null; // Carga manual autorizada: no se atribuye a una orden.
      if (item.state==='requested' && item.expires<=Date.now()) fail(room,item,'expired');
      if (item.reason==='expired') throw error('La solicitud de captura venció.',410);
      if (item.state!=='saved') item.state='saving';
      clearTimeout(item.timer);
      return item;
    },
    saved(room,item,data) {
      if (!item) return;
      item.state='saved';item.fragmentId=data.id;
      if (!room.closed) result(room,item,'saved',{fragment_id:data.id});
    },
    storageFailed(room,item) { if(item && item.state!=='saved' && !room.closed) fail(room,item,'storage_failed'); },
    close(room) { for(const item of room.captureRequests?.values() ?? []) clearTimeout(item.timer); room.captureRequests?.clear(); },
  };
}

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

export function evidenceRoutes({authorizeRoom, body, store, capture, simulated = false}) {
  return async (req,res,path) => {
    const match=path.match(/^\/v1\/sessions\/([a-f0-9-]+)\/evidence(?:\/(clip_[a-f0-9]{48}))?$/);
    if (!match) return false;
    const room=authorizeRoom(req,match[1]);
    if (!room.evidenceConsent) throw error('Esta sesión no autoriza conservar audio.',403);
    const respond=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if (req.method==='POST' && !match[2]) {
      if (room.evidenceBusy) throw error('Ya se está guardando un fragmento.',429);
      room.evidenceBusy=true;
      let command;
      try {
        const input=await body(req,650000);
        if (!input || typeof input.audio_base64!=='string' || !/^[a-f0-9-]{36}$/i.test(input.request_id ?? '') || Object.keys(input).some(k=>!['request_id','audio_base64'].includes(k))) throw error('Fragmento inválido.',400);
        command=capture?.beforeUpload(room,input.request_id);
        const risk=command?.riskPercent ?? (room.lastDecision?.alerta === true ? Math.round(room.lastDecision.probabilidad*100) : null);
        const content=await store('guardar_fragmento',{session_id:room.id,request_id:input.request_id,consentimiento_conservacion:true,audio_base64:input.audio_base64,source:'webrtc_microphone',risk_percent:risk,simulated});
        const data=JSON.parse(content.find(c=>c.type==='text')?.text ?? 'null');
        if (!/^clip_[a-f0-9]{48}$/.test(data?.id ?? '')) throw error('El almacenamiento no confirmó el guardado.',502);
        capture?.saved(room,command,data);
        respond(201,{data});
      } catch(err) { capture?.storageFailed(room,command);throw err; }
      finally {room.evidenceBusy=false;}
    } else if (req.method==='GET' && match[2]) {
      const content=await store('escuchar_fragmento',{session_id:room.id,fragment_id:match[2]});
      const audio=content.find(c=>c.type==='audio' && c.mimeType==='audio/wav');
      if (!audio) throw error('Audio no disponible.',502);
      res.writeHead(200,{'Content-Type':'audio/wav','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.from(audio.data,'base64'));
    } else if (req.method==='GET') {
      const content=await store('listar_fragmentos',{session_id:room.id});
      respond(200,{data:JSON.parse(content.find(c=>c.type==='text')?.text ?? '[]')});
    } else throw error('Método no permitido.',405);
    return true;
  };
}
