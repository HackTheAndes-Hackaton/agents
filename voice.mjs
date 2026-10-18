import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { detectAlert, parseThreshold } from './decisions.mjs';
import { understandIncident } from './understanding.mjs';
import { LiveCaptions, liveSessionConfig, liveAnalysisContext } from './live-voice.mjs';
import { assessmentEvents } from './call-policy.mjs';
import { createPhoneBridge } from './phone-bridge.mjs';
import { evidenceClient, evidenceApiClient, evidenceRoutes, captureControl } from './evidence.mjs';
import { createCaseDelivery } from './case-delivery.mjs';

const token = () => randomBytes(24).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const statusError = (message, statusCode) => Object.assign(new Error(message), { statusCode });
// El proxy público de Maritime reserva Authorization para su propia autenticación.
const appToken = req => req.headers['x-voice-token'] ?? req.headers.authorization?.replace(/^Bearer /, '');

export async function createVoiceServer(config = {}) {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (config.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const accessCode = config.accessCode ?? process.env.VOICE_ACCESS_CODE;
  if (!accessCode || accessCode.length < 12) throw new Error('Configura VOICE_ACCESS_CODE con al menos 12 caracteres');
  const threshold = parseThreshold(config.alertThreshold ?? process.env.ALERT_THRESHOLD);
  const sessionMs = config.sessionMs ?? 15 * 60 * 1000;
  const maxSessions = config.maxSessions ?? 2;
  const rooms = new Map();
  const attempts = new Map();
  const files = new Map(await Promise.all(['index.html', 'voice-client.js', 'style.css'].map(async name => [name, await readFile(new URL(`./web/${name}`, import.meta.url))])));
  const ai = { baseUrl, apiKey, timeoutMs: config.timeoutMs ?? 20000 };
  const caseDelivery = config.caseDelivery ?? createCaseDelivery();
  const caseSimulated = config.caseSimulated ?? process.env.TISKZ_CASES_SIMULATED === 'true';
  const store=config.evidenceStore ?? config.evidenceMcp ?? (process.env.TISKZ_AUDIO_API_URL ? evidenceApiClient() : evidenceClient());
  const phone = createPhoneBridge({ accessCode, ai: { ...ai, threshold }, secret: config.vapiSecret ?? process.env.VAPI_WEBHOOK_SECRET, assistantId: config.vapiAssistantId ?? process.env.VAPI_ASSISTANT_ID, apiKey: config.vapiApiKey ?? process.env.VAPI_API_KEY, number: process.env.VAPI_PHONE_NUMBER, detect: config.detect, understand: config.understand, analysisMs: config.phoneAnalysisMs,
    evidenceStore: store, evidenceEnabled: config.phoneEvidenceEnabled ?? process.env.VAPI_PHONE_EVIDENCE_ENABLED === 'true', evidenceSimulated: config.phoneEvidenceSimulated ?? process.env.VAPI_PHONE_EVIDENCE_SIMULATED === 'true',
    caseDelivery, caseSimulated, scribeEnabled: config.scribeEnabled ?? process.env.VAPI_SCRIBE_SHADOW_ENABLED === 'true' });
  const emit = (room, event) => {
    const payload = { ...event, session_id: room.id, timestamp: new Date().toISOString() };
    if (event.type === 'transcript.update' && event.id) room.transcripts.set(event.id, payload);
    if (event.type === 'risk.update') room.lastRisk = payload;
    if (event.type === 'assessment.update') room.lastAssessment = payload;
    for (const client of room.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
  };
  const emitProducer = (room,event) => {
    for(const client of room.clients) if(client.isProducer && client.readyState===WebSocket.OPEN) client.send(JSON.stringify({...event,session_id:room.id,timestamp:new Date().toISOString()}));
  };
  const capture=captureControl(emitProducer,config.captureTimeoutMs ?? 30000);
  async function hangup(callId, mode) {
    if (!callId) return;
    try {
      const r = await fetch(`${baseUrl}/${mode === 'assistant' ? 'live/sessions' : 'realtime/calls'}/${encodeURIComponent(callId)}/hangup`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      if (!r.ok && r.status !== 404) console.error(JSON.stringify({ event: 'hangup_failed', status: r.status }));
    } catch { console.error(JSON.stringify({ event: 'hangup_failed' })); }
  }
  async function endRoom(room, reason = 'stopped') {
    if (room.closed) return;
    const caseText = room.mode === 'assistant' ? room.captions.text('caller') : [...room.turns.values()].filter(turn=>turn.speaker!=='agent').sort((a,b)=>a.sequence-b.sequence).map(turn=>turn.text).join('\n');
    room.closed = true;
    if (caseDelivery.enabled) void caseDelivery.finish({session_id:room.id,simulated:caseSimulated,channel:'webrtc',
      started_at:new Date(room.started).toISOString(),ended_at:new Date().toISOString(),text:caseText,
      decision:room.detectResult?.revision===room.revision?room.detectResult.value:null});
    clearTimeout(room.expiry);
    clearTimeout(room.disconnectTimer);
    clearTimeout(room.analysisTimer);
    capture.close(room);
    room.captions?.clear();
    emit(room, { type: 'call.ended', reason });
    if (!room.providerClosed) await hangup(room.callId, room.mode);
    for (const client of room.clients) client.close(1000, 'Sesión terminada');
    room.transcripts.clear();
    room.turns.clear();
    rooms.delete(room.id);
  }
  async function analyze(room, component) {
    const running = `${component}Running`, processed = `${component}Revision`;
    if (room[running] || room.closed) return;
    room[running] = true;
    try {
      while (!room.closed && room[processed] !== room.revision) {
        const revision = room.revision;
        const transcripcion = room.mode === 'assistant' ? room.captions.text('caller') : [...room.turns.values()].sort((a, b) => a.sequence - b.sequence).map(t => t.text).join('\n').slice(-12000);
        room[processed] = revision;
        room.assessmentText = transcripcion;
        const incident = { consentimiento_analisis: true, transcripcion };
        if (component === 'detect') emit(room, { type: 'agent.status', status: 'analyzing' });
        try {
          if (component === 'detect') {
            const result = await (config.detect ?? detectAlert)(incident, { ...ai, model: process.env.OPENAI_DECISION_MODEL ?? 'gpt-6-luna', threshold });
            if (room.closed || revision !== room.revision) continue;
            room.lastDecision = result;
            room.detectResult = { revision, value: result };
            emit(room, { type: 'alert.updated', alerta: result.alerta, probability: result.probabilidad, threshold, revision, provisional: true });
            emit(room, { type: 'risk.update', risk_percent: Math.round(result.probabilidad * 100), reasons: ['Estimación provisional de necesidad de alerta; no confirma una estafa.'], scam_type: null, impersonating: null, score_kind: 'probabilidad_de_alerta_no_calibrada', alerta: result.alerta, revision });
            emit(room, { type: 'agent.status', status: result.alerta ? 'suspicious' : 'screening' });
            capture.request(room,revision,result);
          } else {
            const analysis = await (config.understand ?? understandIncident)(incident, { ...ai, selectSegments: room.mode === 'assistant' });
            if (!room.closed && revision === room.revision) { room.understandResult = { revision, value: analysis }; emit(room, { type: 'understanding.update', analysis, revision }); }
          }
        } catch {
          if (!room.closed && revision === room.revision) room[`${component}Result`] = { revision, error: true };
          if (!room.closed && revision === room.revision) emit(room, { type: 'error', message: component === 'detect' ? 'Detección no disponible. No interpretes este fallo como ausencia de riesgo.' : 'Comprensión no disponible; la detección se procesa de forma independiente.', component: component === 'detect' ? 'deteccion' : 'comprension' });
        }
        if (!room.closed && revision === room.revision) {
          for (const event of assessmentEvents(room, transcripcion)) emit(room, event);
        }
        if (room.mode === 'assistant' && !room.closed && revision === room.revision && room.detectResult?.revision === revision && room.understandResult?.revision === revision) deliverLiveContext(room);
      }
    } finally { room[running] = false; }
  }
  function ingestTranscript(room, event) {
    if (room.closed) return;
    if (typeof event.id !== 'string' || !event.id || event.id.length > 150 || typeof event.text !== 'string' || event.text.length > 4000) return;
    if (!event.text.trim()) return;
    if (!room.transcripts.has(event.id) && room.transcripts.size >= 100) {
      emit(room, { type: 'error', message: 'Se alcanzó el límite de 100 fragmentos. Inicia otra sesión.' });
      void endRoom(room, 'turn_limit');
      return;
    }
    const final = event.final === true;
    if (room.turns.has(event.id)) return; // Un final es inmutable: evita reenvíos y cobros repetidos.
    emit(room, { type: 'transcript.update', id: event.id, speaker: ['caller', 'user', 'agent'].includes(event.speaker) ? event.speaker : 'caller', text: event.text, sequence: Number.isSafeInteger(event.sequence) && event.sequence >= 0 && event.sequence <= 2147483647 ? event.sequence : undefined, flagged: false, final, source: 'webrtc_client_transcription' });
    if (final) {
      room.turns.set(event.id, { text: event.text, speaker:event.speaker, sequence: Number.isSafeInteger(event.sequence) && event.sequence >= 0 ? event.sequence : room.turns.size });
      room.revision++;
      void analyze(room, 'detect');
      void analyze(room, 'understand');
    }
  }
  function deliverLiveContext(room, delegationId = null) {
    emit(room, { type: 'live.command', command: { type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content: liveAnalysisContext(room) } });
  }
  function flushLive(room) {
    clearTimeout(room.analysisTimer); room.analysisTimer = null;
    const text = room.captions.text('caller');
    if (room.closed || !text.trim() || text === room.analyzedText) return;
    room.analyzedText = text; room.revision++;
    void analyze(room, 'detect'); void analyze(room, 'understand');
  }
  function ingestLive(room, event) {
    if (room.mode !== 'assistant' || !room.negotiated || room.closed) return;
    if (event.type === 'session.closed') {
      room.providerClosed = true;
      const seconds = event.usage?.seconds;
      emit(room, { type: 'live.closed', confirmed: true, seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : null });
      void endRoom(room, 'provider_closed'); return;
    }
    if (event.type === 'session.delegation.created') {
      const id = event.delegation?.id;
      if (event.delegation?.target !== 'client' || typeof id !== 'string' || !id || id.length > 150 || room.delegations.has(id)) return;
      if (room.delegations.size >= 64) { void endRoom(room, 'delegation_limit'); return; }
      room.delegations.add(id); flushLive(room); deliverLiveContext(room, id); return;
    }
    try {
      const caption = room.captions.append(event);
      if (!caption) return;
      emit(room, { type: 'transcript.update', id: `live-${caption.speaker}`, speaker: caption.speaker, text: caption.text, sequence: caption.speaker === 'caller' ? 0 : 1, final: false, source: 'live_client_captions' });
      if (caption.speaker === 'caller' && !room.analysisTimer) room.analysisTimer = setTimeout(() => flushLive(room), config.liveAnalysisMs ?? 2500).unref();
    } catch { emit(room, { type: 'error', message: 'Se alcanzó el límite de texto de la conversación. Inicia otra sesión.' }); void endRoom(room, 'caption_limit'); }
  }
  async function body(req, max = 131072) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw statusError('Solicitud demasiado grande', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw statusError('JSON inválido', 400); }
  }
  function authorizeRoom(req, id) {
    const room = rooms.get(id);
    if (room && Date.now() >= room.started + sessionMs) void endRoom(room, 'expired');
    if (!room || room.closed) throw statusError('Sesión inexistente o vencida', 404);
    if (!equal(appToken(req), room.producer)) throw statusError('Acceso no autorizado', 401);
    return room;
  }
  const evidence = evidenceRoutes({authorizeRoom, body, store, capture, simulated:config.evidenceSimulated ?? process.env.TISKZ_EVIDENCE_SIMULATED === 'true'});
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await evidence(req,res,url.pathname)) return;
      if (await phone.http(req, res, url.pathname)) return;
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, role: 'voz', webrtc: true, models: { transcription: 'gpt-live-transcribe', understanding: 'gpt-4.1-mini', detection: 'gpt-6-luna', assistant: 'gpt-live-1', voice: 'marin' }, configured: Boolean(apiKey) });
      const staticName = url.searchParams.get('asset') ?? (url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (req.method === 'GET' && files.has(staticName)) {
        res.writeHead(200, { 'Content-Type': staticName.endsWith('.js') ? 'text/javascript; charset=utf-8' : staticName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'" });
        return res.end(files.get(staticName));
      }
      if (req.method === 'POST' && url.pathname === '/chat') return send(200, { response: 'Servicio de voz Tiskz. Abre la página HTTPS para iniciar una sesión autorizada de WebRTC.' });
      if (req.method === 'POST' && url.pathname === '/v1/sessions') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const rate = attempts.get(ip) ?? { count: 0, until: now + 60000 };
        if (now > rate.until) { rate.count = 0; rate.until = now + 60000; }
        attempts.set(ip, rate);
        if (++rate.count > 10) throw statusError('Demasiados intentos; espera un minuto', 429);
        if (!equal(appToken(req), accessCode)) throw statusError('Código de acceso incorrecto', 401);
        const input = await body(req);
        if (input.consentimiento_analisis !== true) throw statusError('Se requiere consentimiento de análisis', 400);
        if (input.audio_capture_protocol !== undefined && input.audio_capture_protocol !== 1) throw statusError('Protocolo de captura no compatible',400);
        if (input.mode !== undefined && !['analysis', 'assistant'].includes(input.mode)) throw statusError('Modo de voz inválido', 400);
        if (input.mode === 'assistant' && input.consentimiento_voz_ia !== true) throw statusError('Se requiere autorización para conversar con voz de IA', 400);
        if (!apiKey) throw statusError('Falta acceso al modelo en el servidor', 503);
        if (rooms.size >= maxSessions) throw statusError('Hay sesiones activas; termina una antes de continuar', 429);
        const room = { captureProtocol:input.audio_capture_protocol, evidenceConsent:input.consentimiento_conservacion === true, mode: input.mode ?? 'analysis', captions: new LiveCaptions(), delegations: new Set(), id: randomUUID(), producer: token(), observer: token(), clients: new Set(), transcripts: new Map(), turns: new Map(), revision: 0, detectRevision: 0, understandRevision: 0, closed: false, started: Date.now(), callId: null };
        rooms.set(room.id, room);
        room.expiry = setTimeout(() => void endRoom(room, 'expired'), sessionMs).unref();
        return send(201, { session_id: room.id, producer_token: room.producer, observer_token: room.observer, expires_at: new Date(Date.now() + sessionMs).toISOString(), mode: room.mode, model: room.mode === 'assistant' ? 'gpt-live-1' : 'gpt-live-transcribe', voice: room.mode === 'assistant' ? 'marin' : null, events_path: `/ws/calls?session=${room.id}&ticket=${room.observer}` });
      }
      const match = url.pathname.match(/^\/v1\/sessions\/([a-f0-9-]+)\/(offer|end)$/);
      if (req.method === 'POST' && match) {
        const room = authorizeRoom(req, match[1]);
        if (match[2] === 'end') { await endRoom(room); return send(200, { ok: true }); }
        const input = await body(req);
        if (typeof input.sdp !== 'string' || input.sdp.length > 100000 || !input.sdp.includes('m=audio')) throw statusError('Se requiere una oferta SDP con audio', 400);
        if (room.offerInProgress || room.negotiated) throw statusError('La sesión ya negoció su canal de audio', 409);
        room.offerInProgress = true;
        try {
          if (room.mode === 'assistant') {
            const upstream = await fetch(`${baseUrl}/live/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: liveSessionConfig(), transport: { type: 'webrtc', sdp: input.sdp } }), signal: AbortSignal.timeout(20000) });
            if (!upstream.ok) { console.error(JSON.stringify({ event: 'live_offer_failed', status: upstream.status })); throw statusError('No se pudo conectar la voz del asistente', 502); }
            const data = await upstream.json();
            room.callId = data.session?.id;
            if (typeof room.callId !== 'string' || !room.callId || room.callId.length > 512 || typeof data.transport?.sdp !== 'string' || !data.transport.sdp.startsWith('v=')) throw statusError('Respuesta de voz incompleta', 502);
            room.negotiated = true;
            if (room.closed) { await hangup(room.callId, room.mode); throw statusError('Sesión terminada durante la negociación', 409); }
            return send(201, { sdp: data.transport.sdp, session_id: room.id, model: 'gpt-live-1', voice: 'marin' });
          }
          const form = new FormData();
          form.set('sdp', input.sdp);
          form.set('session', JSON.stringify({ type: 'transcription', audio: { input: { transcription: { model: 'gpt-live-transcribe', languages: ['es'], prompt: 'Conversación en español de Perú a través del micrófono de un celular.', delay: 'low' }, turn_detection: null } } }));
          const upstream = await fetch(`${baseUrl}/realtime/calls`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(20000) });
          if (!upstream.ok) { console.error(JSON.stringify({ event: 'webrtc_offer_failed', status: upstream.status })); throw statusError('No se pudo negociar el audio con el transcriptor', 502); }
          let sdp = await upstream.text();
          // Algunos proxies JSON serializan también las respuestas de texto/SDP.
          if (sdp.trim().startsWith('"')) { try { sdp = JSON.parse(sdp); } catch { /* Valida debajo. */ } }
          const location = upstream.headers.get('location');
          if (location) room.callId = new URL(location, 'https://api.openai.com').pathname.split('/').filter(Boolean).at(-1);
          if (typeof sdp !== 'string' || !sdp.startsWith('v=')) throw statusError('Respuesta SDP incompleta del proveedor', 502);
          room.negotiated = true;
          if (room.closed) { if (!room.providerClosed) await hangup(room.callId, room.mode); throw statusError('Sesión terminada durante la negociación', 409); }
          emit(room, { type: 'agent.status', status: 'screening' });
          return send(201, { sdp, session_id: room.id });
        } finally { room.offerInProgress = false; }
      }
      send(404, { error: 'Ruta no encontrada' });
    } catch (error) { if (!res.headersSent) send(error.statusCode ?? 500, { error: error.statusCode ? error.message : 'No se pudo completar la solicitud' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (phone.upgrade(req, socket, head, url.pathname)) return;
    const room = rooms.get(url.searchParams.get('session'));
    if (room && Date.now() >= room.started + sessionMs) void endRoom(room, 'expired');
    const ticket = url.searchParams.get('ticket');
    const producer = room && equal(ticket, room.producer);
    if (url.pathname !== '/ws/calls' || !room || room.closed || (!producer && !equal(ticket, room.observer)) || room.clients.size >= 5) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => {
      if (producer) clearTimeout(room.disconnectTimer);
      client.isProducer = producer;
      room.clients.add(client);
      client.send(JSON.stringify({ type: 'session.ready', session_id: room.id, producer, expires_at: new Date(room.started + sessionMs).toISOString() }));
      for (const event of room.transcripts.values()) client.send(JSON.stringify(event));
      if (room.lastRisk) client.send(JSON.stringify(room.lastRisk));
      if (room.lastAssessment?.revision === room.revision) client.send(JSON.stringify(room.lastAssessment));
      if (producer) capture.replay(room,client);
      client.on('message', async raw => {
        let event; try { event = JSON.parse(raw.toString()); } catch { return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        if (event.type === 'ping') { client.send(JSON.stringify({ type: 'pong' })); return; }
        if (event.type === 'session.start') { client.send(JSON.stringify({ type: 'agent.status', status: room.negotiated ? 'screening' : 'connecting' })); return; }
        if (producer && ['audio.capture_received','audio.capture_failed'].includes(event.type)) { capture.clientEvent(room,event);return; }
        if (event.type === 'transcript.update' && producer && room.mode === 'analysis') ingestTranscript(room, event);
        if (event.type === 'live.event' && producer && event.event && typeof event.event === 'object') ingestLive(room, event.event);
        if (event.type === 'user.decision') {
          if (!['answer', 'reject', 'hang_up', 'block', 'not_scam'].includes(event.action)) return;
          emit(room, { type: 'user.decision', action: event.action });
          if (event.action !== 'not_scam') await endRoom(room, event.action);
        }
      });
      client.on('close', () => {
        room.clients.delete(client);
        if (producer && !room.closed && ![...room.clients].some(c => c.isProducer)) room.disconnectTimer = setTimeout(() => void endRoom(room, 'producer_disconnected'), 5000).unref();
      });
      client.on('error', () => client.close());
    });
  });
  server.closeVoice = async () => { phone.close(); await Promise.all([...rooms.values()].map(room => endRoom(room, 'server_closing'))); await caseDelivery.drain(); wss.close(); };
  return server;
}
