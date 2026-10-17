// SDK mínimo: acepta cualquier MediaStream autorizado, incluido el de otro WebRTC.
export async function connectVoice({ stream, accessCode, consentimiento, baseUrl = location.origin + location.pathname.replace(/\/$/, ''), onEvent = () => {} }) {
  baseUrl = baseUrl.replace(/\/$/, '');
  if (consentimiento !== true) throw new Error('Confirma la autorización de análisis.');
  const request = async (path, body, secret = accessCode) => {
    const r = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data;
  };
  const room = await request('/v1/sessions', { consentimiento_analisis: true });
  const eventUrl = new URL(`${baseUrl}/ws/calls`); eventUrl.protocol = eventUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  eventUrl.searchParams.set('session', room.session_id); eventUrl.searchParams.set('ticket', room.producer_token);
  const ws = new WebSocket(eventUrl);
  const pc = new RTCPeerConnection();
  let dc, context, timer, heartbeat, stopped = false, turnStart = 0, lastSpeech = 0, pendingAudio = false;
  const texts = new Map();
  const order = new Map();
  const send = event => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
  const stop = async () => {
    if (stopped) return; stopped = true; clearInterval(timer); clearInterval(heartbeat);
    try { await request(`/v1/sessions/${room.session_id}/end`, {}, room.producer_token); } catch { /* La sesión puede haber terminado desde Tiskz. */ }
    dc?.close(); pc.close(); ws.close(); stream.getTracks().forEach(t => t.stop());
    await context?.close(); onEvent({ type: 'client.stopped' });
  };
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('No se pudo abrir el canal de eventos.')); });
    ws.onmessage = ({ data }) => { const event = JSON.parse(data); onEvent(event); if (event.type === 'call.ended') void stop(); };
    ws.onclose = () => { if (!stopped) { onEvent({ type: 'error', message: 'Se desconectó el canal de eventos.' }); void stop(); } };
    heartbeat = setInterval(() => send({ type: 'ping' }), 20000);
    stream.getAudioTracks().forEach(track => pc.addTrack(track, stream));
    dc = pc.createDataChannel('oai-events');
    dc.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === 'input_audio_buffer.committed') order.set(event.item_id, order.size);
      if (event.type === 'error') onEvent({ type: 'error', message: event.error?.message ?? 'Error en la transcripción.' });
      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        const text = (texts.get(event.item_id) ?? '') + event.delta; texts.set(event.item_id, text);
        send({ type: 'transcript.update', id: event.item_id, text, final: false });
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        texts.delete(event.item_id); send({ type: 'transcript.update', id: event.item_id, text: event.transcript, final: true, sequence: order.get(event.item_id) });
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed') onEvent({ type: 'error', message: 'No se pudo transcribir un fragmento de audio.' });
    };
    dc.onclose = () => { if (!stopped) { onEvent({ type: 'error', message: 'Se cerró la conexión de transcripción.' }); void stop(); } };
    const opened = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('La conexión de audio tardó demasiado. Comprueba la red.')), 30000);
      dc.onopen = () => { clearTimeout(timeout); resolve(); };
    });
    // Evita un rechazo no atendido si falla antes la negociación HTTP.
    opened.catch(() => {});
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const timeout = setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } });
    });
    const answer = await request(`/v1/sessions/${room.session_id}/offer`, { sdp: pc.localDescription.sdp }, room.producer_token);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await opened;
    context = new AudioContext(); await context.resume();
    const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    // gpt-live-transcribe requiere commits del cliente; no ofrece VAD de servidor.
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
      onEvent({ type: 'audio.level', level: Math.min(1, rms * 12) });
      const now = performance.now();
      if (rms > 0.012) { if (!pendingAudio) turnStart = now; pendingAudio = true; lastSpeech = now; }
      if (pendingAudio && now - turnStart > 400 && (now - lastSpeech > 600 || now - turnStart > 6000) && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); pendingAudio = false;
      }
    }, 100);
    const observerUrl = new URL(baseUrl + room.events_path); observerUrl.protocol = eventUrl.protocol;
    onEvent({ type: 'client.connected', observer_url: observerUrl.href, expires_at: room.expires_at });
    return { stop, peerConnection: pc, sessionId: room.session_id };
  } catch (error) { await stop(); throw error; }
}

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const transcripts = new Map(); let active, fileContext;
  const notice = message => { $('notice').textContent = message; };
  const onEvent = event => {
    if (event.type === 'client.connected') { $('connection').textContent = 'Audio conectado'; $('observer').value = event.observer_url; notice('Escuchando. La detección se actualiza al cerrar cada fragmento de voz.'); }
    if (event.type === 'client.stopped') { active = null; $('start').disabled = false; $('play').disabled = false; $('stop').disabled = true; $('connection').textContent = 'Sesión terminada'; fileContext?.close(); fileContext = null; }
    if (event.type === 'error') notice(event.message);
    if (event.type === 'audio.level') $('level').style.width = `${Math.round(event.level * 100)}%`;
    if (event.type === 'transcript.update') {
      transcripts.set(event.id, event); $('transcripts').replaceChildren(...[...transcripts.values()].map(e => { const p = document.createElement('p'); p.textContent = e.text; p.className = e.final ? '' : 'partial'; return p; }));
    }
    if (event.type === 'alert.updated') { $('alert').textContent = event.alerta ? 'TRUE · Revisar posible riesgo' : 'FALSE · Sin alerta en este fragmento'; $('alert').className = event.alerta ? 'warning' : 'clear'; $('reason').textContent = `Decisión provisional · umbral ${event.threshold}. No confirma una estafa ni garantiza seguridad.`; }
    if (event.type === 'understanding.update') $('understanding').textContent = JSON.stringify(event.analysis, null, 2);
  };
  async function start(file) {
    if (!$('consent').checked || !$('code').value) return notice('Introduce el código y confirma la autorización de análisis.');
    $('start').disabled = true; $('play').disabled = true; $('connection').textContent = 'Conectando…'; transcripts.clear(); $('transcripts').replaceChildren(); $('understanding').textContent = 'Esperando análisis…'; $('alert').textContent = 'Esperando audio';
    let stream, source;
    try {
      if (file) {
        fileContext = new AudioContext(); await fileContext.resume();
        const decoded = await fileContext.decodeAudioData(await file.arrayBuffer());
        source = fileContext.createBufferSource(); source.buffer = decoded;
        const destination = fileContext.createMediaStreamDestination(); source.connect(destination); stream = destination.stream;
      } else stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      active = await connectVoice({ stream, accessCode: $('code').value, consentimiento: true, onEvent });
      $('stop').disabled = false; source?.start();
      if (source) source.onended = () => notice('Archivo enviado. Espera el análisis y pulsa Terminar para cerrar la sesión.');
    } catch (error) { stream?.getTracks().forEach(t => t.stop()); fileContext?.close(); fileContext = null; $('connection').textContent = 'Error de conexión'; $('start').disabled = false; $('play').disabled = false; notice(error.message); }
  }
  $('start')?.addEventListener('click', () => void start());
  $('play')?.addEventListener('click', () => { const file = $('audio').files[0]; if (file) void start(file); else notice('Selecciona un archivo de audio.'); });
  $('stop')?.addEventListener('click', () => void active?.stop());
  window.addEventListener('pagehide', () => void active?.stop());
}
