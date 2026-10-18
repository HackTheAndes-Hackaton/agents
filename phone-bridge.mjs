import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { detectAlert } from './decisions.mjs';
import { understandIncident } from './understanding.mjs';
import { assessmentEvents } from './call-policy.mjs';
import { startScribeComparison } from './scribe-sidecar.mjs';
import { PhoneAudioWindow } from './phone-evidence.mjs';

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
      headers: { Authorization: `Bearer ${config.apiKey}`, 'User-Agent': 'vapi-cli/0.2.1' }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('call_lookup_failed');
    const data = await response.json();
    if (data.id !== target.id || data.assistantId !== config.assistantId) throw Error('call_mismatch');
    if (data.status === 'ended') return 'already_ended';
    url = vapiControlUrl(data.monitor?.controlUrl, target.id);
  }
  if (!url) throw Error('control_unavailable');
  const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'vapi-cli/0.2.1' },
    body: JSON.stringify({ type: 'end-call' }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('hangup_rejected');
  return 'requested'; // La confirmación definitiva llega con status-update: ended.
}
// Una línea de prueba, solo en memoria. Nunca recibe audio del teléfono Android.
export function createPhoneBridge(config) {
  const watchers = new Set(), ended = new Map(), tickets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const enabled = Boolean(config.secret?.length >= 24 && config.assistantId);
  let call = null, lastCall = null;
  const diagnostics = { received: 0, callerFinals: 0, lastEvent: null };
  const callMetadata = target => ({ call_id: target.id, revision: target.revision,
    caller_turns: target.turns.size, assessment_state: target.assessmentRevision === target.revision ? target.assessmentState : null,
    alerta: target.detectResult?.revision === target.revision && !target.detectResult.error ? target.detectResult.value.alerta : null,
    detection_ms: target.detectResult?.revision === target.revision && !target.detectResult.error ? target.detectDurationMs ?? null : null,
    understanding_ms: target.understandResult?.revision === target.revision && !target.understandResult.error ? target.understandDurationMs ?? null : null,
    hangup_requested: target.hangupRequested === true, hangup_revision: target.hangupRevision ?? null,
    hangup_status: target.hangupStatus ?? null,
    hangup_reason: target.hangupReason ?? null,
    evidence_status: target.evidenceStatus ?? null,
    evidence_fragment_id: target.evidenceFragmentId ?? null,
    evidence_incident_id: target.evidenceIncidentId ?? null,
    comparison: target.comparison?.metadata() ?? null,
    delivery: target.delivery ?? [] });
  const send = (ws, event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
  const emit = event => {
    if (!call) return;
    const e = { ...event, session_id: call.id, server_sent_at_ms: Date.now() };
    if (['alert.updated', 'comparison.alert'].includes(e.type)) {
      e.event_id = randomUUID(); call.pendingAcks.set(e.event_id, { type: e.type, sent: performance.now() });
      while (call.pendingAcks.size > 64) call.pendingAcks.delete(call.pendingAcks.keys().next().value);
    }
    if (['assessment.update', 'risk.update', 'alert.updated', 'understanding.update', 'transcript.update', 'call.ready_to_answer', 'call.hangup_requested', 'call.hangup_result', 'comparison.status', 'comparison.alert', 'transcript.comparison', 'audio.capture_result'].includes(e.type)) {
      const key = ['transcript.update', 'transcript.comparison'].includes(e.type) ? `${e.type}:${e.id}` : e.type;
      call.cache.set(key, e);
    }
    for (const ws of watchers) send(ws, e);
  };
  async function analyzeComparison(target) {
    if (target.comparisonRunning) return;
    target.comparisonRunning = true;
    try {
      while (!target.closed && watchers.size && target.comparisonProcessed < target.comparisonRevision) {
        const revision = target.comparisonRevision, text = target.comparisonText, received = target.comparisonReceived;
        target.comparisonProcessed = revision;
        const started = performance.now();
        try {
          const result = await (config.detect ?? detectAlert)({ consentimiento_analisis: true, transcripcion: text }, config.ai);
          if (target !== call || target.closed || revision !== target.comparisonRevision || !watchers.size) continue;
          emit({ type: 'comparison.alert', source: 'scribe_v2_realtime', comparison_only: true, revision,
            alerta: result.alerta, probability: result.probabilidad, analysis_ms: Math.round(performance.now() - started),
            caption_to_alert_ms: Date.now() - received });
        } catch {
          if (target === call && !target.closed) emit({ type: 'comparison.status', status: 'analysis_unavailable', comparison_only: true });
        }
      }
    } finally { target.comparisonRunning = false; }
  }
  function compare(target) {
    if ((!config.scribeEnabled && !target.evidenceConsent) || !config.apiKey) return;
    target.comparisonRevision = 0; target.comparisonProcessed = 0; target.comparisonText = '';
    target.comparison = (config.startComparison ?? startScribeComparison)({ apiKey: config.apiKey,
      callId: target.id, assistantId: config.assistantId,
      transcribe: config.scribeEnabled === true,
      onAudio: (bytes, rate) => { if (target === call && !target.closed && target.evidenceConsent) target.audio.push(bytes, rate); },
      onStatus: e => { if (config.scribeEnabled && target === call && !target.closed) emit({ type: 'comparison.status', comparison_only: true, ...e }); },
      onCaption: e => {
        if (target !== call || target.closed || !watchers.size) return;
        if (e.sequence >= 100 || target.comparisonText.length + e.text.length > 12000) { target.comparison.close(); emit({ type: 'comparison.status', status: 'text_limit', comparison_only: true }); return; }
        emit({ ...e, type: 'transcript.comparison', source: 'scribe_v2_realtime', comparison_only: true });
        if (!e.final) return;
        target.comparisonText += (target.comparisonText ? '\n' : '') + e.text;
        target.comparisonRevision++; target.comparisonReceived = Date.now();
        if (!target.comparisonTimer) target.comparisonTimer = setTimeout(() => { target.comparisonTimer = null; void analyzeComparison(target); }, config.analysisMs ?? 250).unref();
      } });
    if (config.scribeEnabled) emit({ type: 'comparison.status', status: 'starting', comparison_only: true });
  }
  function saveEvidence(target, revision) {
    if (!target.evidenceConsent || target.evidenceStatus || !config.evidenceStore) return;
    const wav = target.audio.wav();
    const requestId = randomUUID();
    const report = (status, extra = {}) => {
      target.evidenceStatus = status;
      if (extra.fragment_id) { target.evidenceFragmentId = extra.fragment_id; target.evidenceIncidentId = extra.incident_id; }
      if (target === call && !target.closed) emit({ type: 'audio.capture_result', request_id: requestId, revision, status, ...extra });
      else if (lastCall?.call_id === target.id) Object.assign(lastCall, { evidence_status: status,
        evidence_fragment_id: target.evidenceFragmentId ?? null, evidence_incident_id: target.evidenceIncidentId ?? null });
    };
    if (!wav) { report('failed', { reason: 'no_audio' }); return; }
    report('saving');
    // La instantánea ya autorizada termina de guardarse aunque el corte cierre el monitor.
    void (async () => {
      try {
        const content = await config.evidenceStore('guardar_fragmento', { session_id: target.id, request_id: requestId,
          consentimiento_conservacion: true, audio_base64: wav.toString('base64'), source: 'provider_mixed',
          risk_percent: Math.round(target.detectResult.value.probabilidad * 100), simulated: config.evidenceSimulated === true });
        const data = JSON.parse(content.find(c => c.type === 'text')?.text ?? 'null');
        if (!/^clip_[a-f0-9]{48}$/.test(data?.id ?? '')) throw Error('storage_not_confirmed');
        report('saved', { fragment_id: data.id, incident_id: data.incident_id, speaker: 'unknown', review_status: 'pendiente' });
      } catch { report('failed', { reason: 'storage_failed' }); }
      finally { wav.fill(0); }
    })();
  }
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
  async function stopForRisk(target, revision, reason = 'risk_detected') {
    if (target.hangupRequested || !target.autoHangup) return;
    target.hangupRequested = true;
    target.hangupRevision = revision;
    target.hangupReason = reason;
    const requestId = randomUUID();
    emit({ type: 'call.hangup_requested', request_id: requestId, call_id: target.id, revision, reason });
    // La APK puede cerrar el monitor al desconectar Telecom. La orden ya autorizada sigue en curso.
    try {
      const status = await (config.endCall ?? endVapiCall)(target, { apiKey: config.apiKey, assistantId: config.assistantId });
      target.hangupStatus = status;
      if (target === call && !target.closed) emit({ type: 'call.hangup_result', request_id: requestId, status, reason });
      else if (lastCall?.call_id === target.id && lastCall.hangup_status !== 'confirmed') lastCall.hangup_status = status;
    } catch {
      target.hangupStatus = 'failed';
      if (target === call && !target.closed) emit({ type: 'call.hangup_result', request_id: requestId, status: 'failed', message: 'Vapi no confirmó el corte. Cuelga desde el teléfono.' });
      else if (lastCall?.call_id === target.id && lastCall.hangup_status !== 'confirmed') lastCall.hangup_status = 'failed';
    }
  }
  function finish(reason) {
    if (!call) return;
    call.comparison?.close();
    call.audio.clear();
    if (config.scribeEnabled && call.comparison) emit({ type: 'comparison.status', status: call.comparison.metadata().status, comparison_only: true });
    if (reason === 'provider_ended' && call.hangupRequested) call.hangupStatus = 'confirmed';
    lastCall = { ...callMetadata(call), end_reason: reason, ended_at: new Date().toISOString() };
    if(config.caseDelivery?.enabled) void config.caseDelivery.finish({session_id:call.id,simulated:config.caseSimulated===true,
      channel:'telefono_vapi',started_at:new Date(call.started).toISOString(),ended_at:new Date().toISOString(),
      time_source:'monitor_first_event',text:call.text,decision:call.detectResult?.revision===call.revision?call.detectResult.value:null});
    emit({ type: 'call.ended', reason });
    ended.set(call.id, Date.now()); clearTimeout(call.expiry); clearTimeout(call.timer); clearTimeout(call.comparisonTimer);
    call.comparisonText = ''; call.pendingAcks.clear();
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
        const started = performance.now();
        try {
          const incident = { consentimiento_analisis: true, transcripcion: text };
          const result = component === 'detect'
            ? await (config.detect ?? detectAlert)(incident, config.ai)
            : await (config.understand ?? understandIncident)(incident, { ...config.ai, selectSegments: true });
          if (target.closed || target !== call || revision !== target.revision || !watchers.size) continue;
          target[`${component}Result`] = { revision, value: result };
          target[`${component}DurationMs`] = Math.round(performance.now() - started);
          if (component === 'detect') {
            emit({ type: 'alert.updated', alerta: result.alerta, probability: result.probabilidad, revision, provisional: true,
              source: 'vapi_realtime', caption_to_alert_ms: Date.now() - target.captionReceivedAt });
            emit({ type: 'risk.update', risk_percent: Math.round(result.probabilidad * 100), alerta: result.alerta, revision, reasons: ['Estimación provisional; no confirma una estafa.'], scam_type: null, impersonating: null, score_kind: 'probabilidad_de_alerta_no_calibrada' });
          } else emit({ type: 'understanding.update', analysis: result, revision });
        } catch {
          if (target === call && !target.closed && revision === target.revision) target[`${component}Result`] = { revision, error: true };
          if (target === call && !target.closed && revision === target.revision) emit({ type: 'error', component, message: 'Análisis telefónico no disponible. Este fallo no significa ausencia de riesgo.' });
        }
        if (target === call && !target.closed && revision === target.revision && watchers.size) {
          for (const event of assessmentEvents(target, text)) {
            if (event.type === 'assessment.update') { target.assessmentState = event.assessment.estado; target.assessmentRevision = revision; }
            emit(event);
          }
          if (component === 'detect' && target.detectResult?.value?.alerta === true) { saveEvidence(target, revision); void stopForRisk(target, revision); }
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
    if (!/^[a-f0-9-]{36}$/i.test(id ?? '') || (event.call.assistantId ?? event.assistant?.id) !== config.assistantId) return;
    if (ended.has(id)) {
      if ((event.type === 'end-of-call-report' || (event.type === 'status-update' && event.status === 'ended')) &&
          lastCall?.call_id === id && lastCall.hangup_requested) lastCall.hangup_status = 'confirmed';
      return;
    }
    const transcript = ['transcript', 'transcript[transcriptType="final"]'].includes(event.type);
    if (!['status-update', 'conversation-update', 'end-of-call-report'].includes(event.type) && !transcript) return;
    // Mostrar la voz de marin sin pasarla al detector como si la hubiera dicho quien llama.
    if (transcript && event.role === 'assistant') {
      if (call?.id === id && (event.transcriptType === 'final' || event.type !== 'transcript') &&
          typeof event.transcript === 'string' && event.transcript.length <= 4000 && Number.isFinite(event.timestamp)) {
        caption('agent', event.timestamp, event.transcript);
        // Respaldo determinista si el modelo pronuncia el cierre sin ejecutar endCall.
        // Solo una despedida explícita completa del asistente; no frases del llamante ni negaciones.
        if (/^(?:voy a (?:terminar|colgar) la llamada|te voy a cortar)[.!…\s]*$/iu.test(event.transcript.trim())) void stopForRisk(call, call.revision, 'agent_ended');
      }
      return;
    }
    // Los parciales pueden omitir todavía un «no». Solo analizar turnos completos.
    if (transcript && (event.role !== 'user' || (event.transcriptType !== 'final' && event.type !== 'transcript[transcriptType="final"]') || typeof event.transcript !== 'string' || !event.transcript.trim())) return;
    const complete = event.type === 'end-of-call-report' || (event.type === 'status-update' && event.status === 'ended');
    if (complete) {
      if (call?.id === id) {
        if (['assistant-ended-call', 'assistant-ended-call-after-message-spoken', 'assistant-said-end-call-phrase'].includes(event.endedReason ?? event.call.endedReason)) void stopForRisk(call, call.revision, 'agent_ended');
        finish('provider_ended');
      } else {
        ended.set(id, Date.now());
        if (lastCall?.call_id === id && lastCall.hangup_requested) lastCall.hangup_status = 'confirmed';
      }
      return;
    }
    // Desconectar la pantalla revoca el análisis de nuevos fragmentos.
    if (!watchers.size) return;
    if (call && call.id !== id) return;
    if (!call) {
      call = { id, started:Date.now(), text: '', count: 0, at: -1, revision: 0, detectRevision: 0, understandRevision: 0, cache: new Map(), turns: new Map(), captions: new Map(), pendingAcks: new Map(), delivery: [], source: null, closed: false, autoHangup: [...watchers].some(ws => ws.autoHangup), controlUrl: null,
        evidenceConsent: config.evidenceEnabled === true && [...watchers].some(ws => ws.evidenceConsent), audio: new PhoneAudioWindow() };
      call.expiry = setTimeout(() => finish('analysis_expired'), config.ttlMs ?? 4 * 60000).unref();
      emit({ type: 'phone.call', call_id: id });
      emit({ type: 'agent.status', status: 'screening' });
      compare(call);
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
    call.source = source; call.text = text; call.revision++; call.captionReceivedAt = Date.now(); call.cache.delete('call.ready_to_answer');
    if (transcript) caption('caller', event.timestamp, event.transcript);
    else emit({ type: 'transcript.update', id: 'phone-caller', speaker: 'caller', text, sequence: 0, final: false, revision: call.revision, source });
    if (!call.timer) call.timer = setTimeout(() => { const target = call; if (!target) return; target.timer = null; void analyze(target, 'detect'); void analyze(target, 'understand'); }, config.analysisMs ?? 250).unref();
  }
  return {
    enabled,
    async http(req, res, pathname) {
      if (!['/v1/phone/vapi', '/v1/phone/monitor', '/v1/phone/diagnostics'].includes(pathname)) return false;
      const respond = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      if (pathname === '/v1/phone/diagnostics') {
        if (!equal(req.headers['x-voice-token'], config.accessCode)) respond(401, { error: 'No autorizado' });
        else if (req.method !== 'GET') respond(405, { error: 'GET requerido' });
        else respond(200, { ...diagnostics, connectedMonitors: watchers.size, callActive: Boolean(call), revision: call?.revision ?? null, hangupRequested: call?.hangupRequested === true,
          currentCall: call ? callMetadata(call) : null,
          lastCall: lastCall && Date.now() - Date.parse(lastCall.ended_at) < 600000 ? lastCall : null });
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
          tickets.set(ticket, { expiry, autoHangup, evidenceConsent: autoHangup && input.consentimiento_conservacion === true }); respond(201, { ticket, expires_at: new Date(expiry).toISOString() });
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
          (authorization.autoHangup && (call || [...watchers].some(ws => ws.autoHangup)))) {
        // Un cliente rechazado puede reiniciar TCP antes de recibir el cierre.
        socket.on('error',()=>socket.destroy());
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.autoHangup = authorization.autoHangup;
        ws.evidenceConsent = authorization.evidenceConsent;
        watchers.add(ws); send(ws, { type: 'phone.ready', number: config.number ?? null });
        if (call) { send(ws, { type: 'phone.call', call_id: call.id }); for (const e of call.cache.values()) if (!['assessment.update', 'call.ready_to_answer'].includes(e.type) || e.revision === call.revision) send(ws, e); }
        ws.on('message', (raw, binary) => {
          if (binary || raw.length > 512 || !call) return;
          let e; try { e = JSON.parse(raw); } catch { return; }
          if (e.type !== 'event.received' || e.session_id !== call.id) return;
          const pending = call.pendingAcks.get(e.event_id); if (!pending) return;
          call.pendingAcks.delete(e.event_id);
          call.delivery.push({ event_type: pending.type, server_round_trip_ms: Math.round(performance.now() - pending.sent) });
          if (call.delivery.length > 16) call.delivery.shift();
        });
        ws.on('error', () => ws.close());
        ws.on('close', () => {
          watchers.delete(ws);
          if (ws.evidenceConsent && call) { call.evidenceConsent = false; call.audio.clear(); }
          if (!watchers.size) finish('monitor_stopped');
        });
      });
      return true;
    },
    close() { finish('server_closing'); tickets.clear(); for (const ws of watchers) ws.close(); wss.close(); },
  };
}
