import { WebSocket } from 'ws';

export function vapiSocketUrl(value, id, kind = 'transport') {
  try {
    const u = new URL(value);
    return u.protocol === 'wss:' && !u.username && !u.password && !u.port && !u.search && !u.hash &&
      ['transport', 'listen'].includes(kind) && /^(?:[a-z0-9-]+\.)*vapi\.ai$/.test(u.hostname) && u.pathname === `/${id}/${kind}` ? u.href : null;
  } catch { return null; }
}

// El protocolo start de Vapi identifica canal 0=customer y canal 1=assistant.
// Conserva muestras partidas entre frames; nunca mezcla ambas voces.
export class CallerPcm {
  tail = Buffer.alloc(0);
  read(bytes) {
    const input = Buffer.concat([this.tail, bytes]), length = input.length - input.length % 4;
    const mono = Buffer.alloc(length / 2);
    for (let i = 0; i < length; i += 4) input.copy(mono, i / 2, i, i + 2);
    this.tail = Buffer.from(input.subarray(length));
    return mono;
  }
}

export function scribeAssistant() {
  return {
    name: 'Tiskz Scribe comparativo',
    model: { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 50,
      messages: [{ role: 'system', content: 'Esta es una prueba de escucha en español. Responde únicamente «Entendido» al terminar cada intervención. No hagas preguntas ni uses herramientas.' }], tools: [] },
    // El audio de esta sesión se descarta; solo marin en la llamada original es audible.
    voice: { provider: 'openai', voiceId: 'alloy' },
    transcriber: { provider: '11labs', model: 'scribe_v2_realtime', language: 'es', silenceThresholdSeconds: 0.3, minSilenceDurationMs: 300 },
    firstMessageMode: 'assistant-waits-for-user', maxDurationSeconds: 240, silenceTimeoutSeconds: 120,
    clientMessages: ['transcript'], serverMessages: [],
    artifactPlan: { recordingEnabled: false, loggingEnabled: false, pcapEnabled: false, fullMessageHistoryEnabled: false, transcriptPlan: { enabled: false } },
  };
}

// Sesión temporal por llamada. Consume el saldo Vapi existente, no requiere otra key.
export function startScribeComparison(options) {
  const request = options.fetch ?? fetch, Socket = options.WebSocket ?? WebSocket;
  const abort = new AbortController(), sockets = new Set();
  let closed = false, shadowId = null, shadow = null, opened = false, started = false, sequence = 0;
  let rate = null, queue = [], queued = 0, audioBytes = 0;
  const metadata = { status: 'starting', caller_audio_ms: 0, finals: 0, partials: 0, connected_at_ms: null, shadow_call_id: null };
  const status = value => { metadata.status = value; if (!closed) options.onStatus?.({ status: value }); };
  const alive = () => !closed && !abort.signal.aborted;
  const connect = url => {
    const ws = new Socket(url, { handshakeTimeout: 6000, maxPayload: 262144, followRedirects: false });
    sockets.add(ws); ws.on('error', () => fail('connection_failed'));
    return ws;
  };
  async function api(path, init = {}) {
    const r = await request('https://api.vapi.ai' + path, { ...init,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'vapi-cli/0.2.1' },
      redirect: 'error', signal: init.method === 'POST' ? AbortSignal.timeout(6000) : AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]) });
    if (!r.ok) throw Error('provider_request_failed');
    return r.json();
  }
  function close() {
    if (closed) return;
    if (['starting', 'streaming'].includes(metadata.status)) metadata.status = 'stopped';
    closed = true; abort.abort(); clearTimeout(expiry);
    queue = []; queued = 0;
    for (const ws of sockets) {
      if (ws === shadow && ws.readyState === 1) ws.send(JSON.stringify({ type: 'end-call' }));
      if (ws.readyState === 0) ws.terminate(); else ws.close(1000, 'comparison stopped');
    }
    // No borrar el registro: el transporte end-call cierra la llamada y preserva metadatos.
  }
  function fail(reason) { if (!closed) { status(reason); close(); } }
  const expiry = setTimeout(() => fail('expired'), 245000).unref();
  function sendAudio(bytes) {
    if (!bytes.length || !alive()) return;
    audioBytes += bytes.length; metadata.caller_audio_ms = Math.round(audioBytes / (rate * 2) * 1000);
    options.onAudio?.(bytes, rate);
    if (options.transcribe === false) return;
    if (!opened) {
      queued += bytes.length;
      if (queued > rate * 2 * 8) { fail('startup_audio_overflow'); return; }
      queue.push(bytes); return;
    }
    if (shadow.bufferedAmount > rate * 2 * 4) { fail('audio_backpressure'); return; }
    shadow.send(bytes);
  }
  async function startShadow() {
    const call = await api('/call', { method: 'POST', body: JSON.stringify({ assistant: scribeAssistant(),
      transport: { provider: 'vapi.websocket', audioFormat: { format: 'pcm_s16le', container: 'raw', sampleRate: rate } } }) });
    shadowId = call.id;
    // La respuesta pudo llegar después de revocar el análisis. No abrir un socket huérfano.
    const url = vapiSocketUrl(call.transport?.websocketCallUrl, shadowId);
    if (!url) throw Error('invalid_shadow_transport');
    shadow = connect(url); metadata.shadow_call_id = shadowId;
    shadow.on('open', () => {
      if (!alive()) { shadow.send(JSON.stringify({ type: 'end-call' })); shadow.close(); return; }
      opened = true; metadata.connected_at_ms = Date.now(); status('streaming');
      for (const bytes of queue) shadow.send(bytes);
      queue = []; queued = 0;
    });
    shadow.on('message', (raw, binary) => {
      if (binary || !alive()) return; // Nunca reproducir la voz de la sesión comparativa.
      let e; try { e = JSON.parse(raw); } catch { return; }
      if (e.type !== 'transcript' || e.role !== 'user' || !['partial', 'final'].includes(e.transcriptType) ||
          typeof e.transcript !== 'string' || !e.transcript.trim() || e.transcript.length > 4000) return;
      const final = e.transcriptType === 'final'; metadata[final ? 'finals' : 'partials']++;
      options.onCaption?.({ id: `scribe-${sequence}`, sequence, text: e.transcript, final,
        received_at_ms: Date.now(), audio_received_ms: metadata.caller_audio_ms });
      if (final) sequence++;
    });
    shadow.on('close', () => { if (alive()) fail('transcriber_disconnected'); });
  }
  (async () => {
    const original = await api('/call/' + encodeURIComponent(options.callId));
    if (!alive()) return;
    if (original.id !== options.callId || original.assistantId !== options.assistantId || original.status === 'ended') throw Error('call_mismatch');
    const url = vapiSocketUrl(original.monitor?.listenUrl, options.callId, 'listen');
    if (!url) throw Error('listen_unavailable');
    const listen = connect(url), pcm = new CallerPcm();
    listen.on('message', (raw, binary) => {
      if (!alive()) return;
      if (binary) { if (started) sendAudio(pcm.read(raw)); return; }
      let e; try { e = JSON.parse(raw); } catch { return; }
      if (e.type !== 'start' || started) return;
      if (e.encoding !== 'linear16' || e.container !== 'raw' || e.channels !== 2 || ![8000, 16000, 24000, 48000].includes(e.sampleRate)) { fail('unsupported_audio_format'); return; }
      started = true; rate = e.sampleRate;
      if (options.transcribe === false) status('streaming');
      else void startShadow().catch(() => { if (alive()) fail('transcriber_unavailable'); });
    });
    listen.on('close', () => { if (alive()) fail('listen_disconnected'); });
  })().catch(() => { if (alive()) fail('listen_unavailable'); });
  return { close, metadata: () => ({ ...metadata }) };
}
