import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { detectAlert } from './decisions.mjs';
import { understandIncident } from './understanding.mjs';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// El control llega de Vapi autenticado; nunca seguir URLs arbitrarias ni redirecciones.
export function vapiControlUrl(value, id) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vapi\.ai$/.test(u.hostname) && u.pathname === `/${id}/control` ? u.href : null;
  } catch { return null; }
}

export async function endVapiCall(target, config = {}) {
  let url = vapiControlUrl(target.controlUrl, target.id);
  const request = config.fetch ?? fetch;
  if (!url && config.apiKey) {
    const response = await request(`https://api.vapi.ai/call/${encodeURIComponent(target.id)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('call_lookup_failed');
    const data = await response.json();
    if (data.id !== target.id || data.assistantId !== config.assistantId) throw Error('call_mismatch');
    if (data.status === 'ended') return 'already_ended';
    url = vapiControlUrl(data.monitor?.controlUrl, target.id);
  }
  if (!url) throw Error('control_unavailable');
  const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'end-call' }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('hangup_rejected');
  return 'requested'; // La confirmación definitiva llega con status-update: ended.
}
// Una línea de prueba, solo en memoria. Nunca recibe audio del teléfono Android.
export function createPhoneBridge(config) {
  const watchers = new Set(), ended = new Map(), tickets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const enabled = Boolean(config.secret?.length >= 24 && config.assistantId);
  let call = null;
  const diagnostics = { received: 0, callerFinals: 0, lastEvent: null };
  const send = (ws, event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
  const emit = event => { if (!call) return; const e = { ...event, session_id: call.id }; if (['risk.update', 'alert.updated', 'understanding.update', 'transcript.update', 'call.hangup_requested', 'call.hangup_result'].includes(e.type)) call.cache.set(e.type === 'transcript.update' ? `${e.type}:${e.id}` : e.type, e); for (const ws of watchers) send(ws, e); };
  function caption(speaker, at, text) {
    const id = `phone-${speaker}-${at}`;
    if (call.captions.has(id) || (speaker === 'agent' && [...call.captions.values()].filter(line => line.speaker === 'agent').length >= 200)) return;
    call.captions.set(id, { id, speaker, at, text, sequence: -1 });
    const ordered = [...call.captions.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    // Una frase por burbuja; un evento atrasado reordena las existentes sin duplicarlas.
    ordered.forEach((line, sequence) => {
      if (line.sequence === sequence) return;
      line.sequence = sequence;
      emit({ type: 'transcript.update', id: line.id, speaker: line.speaker, text: line.text, sequence,
        final: true, revision: call.revision, source: 'vapi_transcript_final' });
    });
  }
  async function stopForRisk(target, revision) {
    if (target.hangupRequested || !target.autoHangup) return;
    target.hangupRequested = true;
    const requestId = randomUUID();
    emit({ type: 'call.hangup_requested', request_id: requestId, call_id: target.id, revision, reason: 'risk_detected' });
    // La APK puede cerrar el monitor al desconectar Telecom. La orden ya autorizada sigue en curso.
    try {
      const status = await (config.endCall ?? endVapiCall)(target, { apiKey: config.apiKey, assistantId: config.assistantId });
      if (target === call && !target.closed) emit({ type: 'call.hangup_result', request_id: requestId, status, reason: 'risk_detected' });
    } catch {
      if (target === call && !target.closed) emit({ type: 'call.hangup_result', request_id: requestId, status: 'failed', message: 'Vapi no confirmó el corte. Cuelga desde el teléfono.' });
    }
  }
  function finish(reason) {
    if (!call) return;
    emit({ type: 'call.ended', reason });
    ended.set(call.id, Date.now()); clearTimeout(call.expiry); clearTimeout(call.timer);
    call.closed = true; call.text = ''; call.cache.clear(); call.turns.clear(); call.captions.clear(); call = null;
    for (const [id, at] of ended) if (Date.now() - at > 15 * 60000) ended.delete(id);
  }
  async function analyze(target, component) {
    if (target[component]) return;
    target[component] = true;
    try {
      while (!target.closed && watchers.size && target[component + 'Revision'] < target.revision) {
        const revision = target.revision, text = target.text;
        target[component + 'Revision'] = revision;
        try {
          const incident = { consentimiento_analisis: true, transcripcion: text };
          const result = component === 'detect'
            ? await (config.detect ?? detectAlert)(incident, config.ai)
            : await (config.understand ?? understandIncident)(incident, { ...config.ai, selectSegments: true });
          if (target.closed || target !== call || revision !== target.revision || !watchers.size) continue;
          if (component === 'detect') {
            emit({ type: 'alert.updated', alerta: result.alerta, probability: result.probabilidad, revision, provisional: true });
            emit({ type: 'risk.update', risk_percent: Math.round(result.probabilidad * 100), alerta: result.alerta, revision, reasons: ['Estimación provisional; no confirma una estafa.'], scam_type: null, impersonating: null, score_kind: 'probabilidad_de_alerta_no_calibrada' });
            if (result.alerta === true) void stopForRisk(target, revision);
          } else emit({ type: 'understanding.update', analysis: result, revision });
        } catch {
          if (target === call && !target.closed && revision === target.revision) emit({ type: 'error', component, message: 'Análisis telefónico no disponible. Este fallo no significa ausencia de riesgo.' });
        }
      }
    } finally { target[component] = false; }
  }
  function ingest(event) {
    diagnostics.received++;
    diagnostics.lastEvent = { type: event?.type ?? null, role: event?.role ?? null, final: event?.transcriptType === 'final',
      validCallId: /^[a-f0-9-]{36}$/i.test(event?.call?.id ?? ''), assistantMatches: (event?.call?.assistantId ?? event?.assistant?.id) === config.assistantId,
      hasTimestamp: Number.isFinite(event?.timestamp) };
    for (const [id, at] of ended) if (Date.now() - at > 15 * 60000) ended.delete(id);
    while (ended.size > 256) ended.delete(ended.keys().next().value);
    const id = event?.call?.id;
    if (!/^[a-f0-9-]{36}$/i.test(id ?? '') || (event.call.assistantId ?? event.assistant?.id) !== config.assistantId || ended.has(id)) return;
    const transcript = ['transcript', 'transcript[transcriptType="final"]'].includes(event.type);
    if (!['status-update', 'conversation-update', 'end-of-call-report'].includes(event.type) && !transcript) return;
    // Mostrar la voz de marin sin pasarla al detector como si la hubiera dicho quien llama.
    if (transcript && event.role === 'assistant') {
      if (call?.id === id && (event.transcriptType === 'final' || event.type !== 'transcript') &&
          typeof event.transcript === 'string' && event.transcript.length <= 4000 && Number.isFinite(event.timestamp)) {
        caption('agent', event.timestamp, event.transcript);
      }
      return;
    }
    // Los parciales pueden omitir todavía un «no». Solo analizar turnos completos.
    if (transcript && (event.role !== 'user' || (event.transcriptType !== 'final' && event.type !== 'transcript[transcriptType="final"]') || typeof event.transcript !== 'string' || !event.transcript.trim())) return;
    const complete = event.type === 'end-of-call-report' || (event.type === 'status-update' && event.status === 'ended');
    if (complete) { if (call?.id === id) finish('provider_ended'); else ended.set(id, Date.now()); return; }
    // Desconectar la pantalla revoca el análisis de nuevos fragmentos.
    if (!watchers.size) return;
    if (call && call.id !== id) return;
    if (!call) {
      call = { id, text: '', count: 0, at: -1, revision: 0, detectRevision: 0, understandRevision: 0, cache: new Map(), turns: new Map(), captions: new Map(), source: null, closed: false, autoHangup: [...watchers].some(ws => ws.autoHangup), controlUrl: null };
      call.expiry = setTimeout(() => finish('analysis_expired'), config.ttlMs ?? 4 * 60000).unref();
      emit({ type: 'phone.call', call_id: id });
      emit({ type: 'agent.status', status: 'screening' });
    }
    call.controlUrl = vapiControlUrl(event.call.monitor?.controlUrl, id) ?? call.controlUrl;
    if (!transcript && event.type !== 'conversation-update') return;
    const source = transcript ? 'vapi_transcript_final' : 'vapi_conversation';
    // No duplicar un turno si el proveedor emite ambos formatos.
    if (call.source && call.source !== source) return;
    let text;
    if (transcript) {
      diagnostics.callerFinals++;
      const at = event.timestamp;
      if (!Number.isFinite(at)) { emit({ type: 'error', message: 'Transcripción sin orden temporal verificable.' }); return; }
      if (call.turns.has(at)) return;
      if (call.turns.size >= 200 || event.transcript.length > 12000) { finish('text_limit'); return; }
      call.turns.set(at, event.transcript);
      text = [...call.turns].sort(([a], [b]) => a - b).map(([, value]) => value).join('\n');
    } else {
      const rows = event.messages;
      if (!Array.isArray(rows) || rows.length > 200) return;
      const caller = rows.filter(m => m?.role === 'user');
      if (caller.some(m => typeof (m.message ?? m.content) !== 'string')) return;
      text = caller.map(m => m.message ?? m.content).join('\n');
      const at = Number.isFinite(event.timestamp) ? event.timestamp : null;
      if (rows.length < call.count || (at !== null && at <= call.at) || (rows.length === call.count && at === null)) return;
      call.count = rows.length; if (at !== null) call.at = at;
    }
    if (text.length > 12000) { emit({ type: 'error', message: 'Límite de análisis alcanzado.' }); finish('text_limit'); return; }
    if (!text.trim() || text === call.text) return;
    call.source = source; call.text = text; call.revision++;
    if (transcript) caption('caller', event.timestamp, event.transcript);
    else emit({ type: 'transcript.update', id: 'phone-caller', speaker: 'caller', text, sequence: 0, final: false, revision: call.revision, source });
    if (!call.timer) call.timer = setTimeout(() => { const target = call; if (!target) return; target.timer = null; void analyze(target, 'detect'); void analyze(target, 'understand'); }, config.analysisMs ?? 2000).unref();
  }
  return {
    enabled,
    async http(req, res, pathname) {
      if (!['/v1/phone/vapi', '/v1/phone/monitor', '/v1/phone/diagnostics'].includes(pathname)) return false;
      const respond = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      if (pathname === '/v1/phone/diagnostics') {
        if (!equal(req.headers['x-voice-token'], config.accessCode)) respond(401, { error: 'No autorizado' });
        else if (req.method !== 'GET') respond(405, { error: 'GET requerido' });
        else respond(200, { ...diagnostics, connectedMonitors: watchers.size, callActive: Boolean(call), revision: call?.revision ?? null, hangupRequested: call?.hangupRequested === true });
        return true;
      }
      if (req.method !== 'POST') { respond(405, { error: 'POST requerido' }); return true; }
      if (pathname === '/v1/phone/monitor') {
        if (!enabled || !equal(req.headers['x-voice-token'], config.accessCode)) { respond(401, { error: 'No autorizado' }); return true; }
        try {
          let content = ''; for await (const c of req) { content += c.toString(); if (content.length > 1024) throw Error(); }
          const input = JSON.parse(content);
          if (input.consentimiento_analisis !== true) { respond(400, { error: 'Se requiere consentimiento' }); return true; }
          const autoHangup = input.consentimiento_corte_automatico === true;
          if (autoHangup && (call || [...watchers].some(ws => ws.autoHangup))) { respond(409, { error: 'Ya hay una llamada o monitor de corte activo' }); return true; }
          for (const [ticket, value] of tickets) if (value.expiry < Date.now()) tickets.delete(ticket);
          if (tickets.size >= 6) { respond(429, { error: 'Espera un minuto antes de volver a conectar' }); return true; }
          const ticket = randomBytes(24).toString('base64url'), expiry = Date.now() + 60000;
          tickets.set(ticket, { expiry, autoHangup }); respond(201, { ticket, expires_at: new Date(expiry).toISOString() });
        } catch { respond(400, { error: 'Solicitud inválida' }); }
        return true;
      }
      if (!enabled || !equal(req.headers['x-vapi-secret'], config.secret)) { respond(401, { error: 'No autorizado' }); return true; }
      try {
        let bytes = 0; const chunks = [];
        for await (const c of req) { bytes += c.length; if (bytes > 262144) throw new Error(); chunks.push(c); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        ingest(body.message); respond(200, { ok: true });
      } catch { respond(400, { error: 'Evento inválido' }); }
      return true;
    },
    upgrade(req, socket, head, pathname) {
      // El proxy público de Maritime admite la ruta WS existente.
      if (pathname !== '/ws/phone' && !(pathname === '/ws/calls' && new URL(req.url, 'http://localhost').searchParams.get('channel') === 'phone')) return false;
      // El proxy no reenvía las cabeceras privadas durante el upgrade.
      // Intercambiamos el código por HTTP por un ticket de un solo uso y 60 s.
      const ticket = new URL(req.url, 'http://localhost').searchParams.get('ticket');
      const authorization = tickets.get(ticket); tickets.delete(ticket);
      if (!enabled || !authorization || authorization.expiry < Date.now() || watchers.size >= 3 ||
          (authorization.autoHangup && (call || [...watchers].some(ws => ws.autoHangup)))) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.autoHangup = authorization.autoHangup;
        watchers.add(ws); send(ws, { type: 'phone.ready', number: config.number ?? null });
        if (call) { send(ws, { type: 'phone.call', call_id: call.id }); for (const e of call.cache.values()) send(ws, e); }
        ws.on('error', () => ws.close());
        ws.on('close', () => { watchers.delete(ws); if (!watchers.size) finish('monitor_stopped'); });
      });
      return true;
    },
    close() { finish('server_closing'); tickets.clear(); for (const ws of watchers) ws.close(); wss.close(); },
  };
}
