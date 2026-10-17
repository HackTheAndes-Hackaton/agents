import { readFile } from 'node:fs/promises';
const instructions = await readFile(new URL('./prompts/comprension.md', import.meta.url), 'utf8');

export async function understandIncident(incident, options) {
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: options.model ?? 'gpt-4.1-mini', messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(incident) }], max_tokens: 1200, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  if (!response.ok) throw new Error(`Comprensión: HTTP ${response.status}`);
  const body = await response.json();
  return groundUnderstanding(JSON.parse(body.choices?.[0]?.message?.content ?? 'null'), incident.transcripcion);
}

// Solo se publica texto literal o redactado por el servidor; nunca prosa libre del modelo.
const kinds = {
  solicitud: ['peticiones', 'Fragmento seleccionado sobre una petición; no identifica a su autor ni destinatario.'],
  condicion: ['condiciones', 'Fragmento seleccionado sobre una condición; debe revisarse en su contexto.'],
  amenaza: ['posibles amenazas', 'Expresión seleccionada para revisar una posible amenaza; no confirma un delito.'],
  negacion: ['negaciones', 'Negación seleccionada; se conserva su formulación literal.'],
  contexto: ['contexto', 'Contexto literal; las menciones personales no verifican identidades.'],
  ambiguo: ['ambigüedades', 'Fragmento ambiguo; contrástalo con el audio, sin reconstruir nombres ni intenciones.'],
};
function wholeSentence(transcript, quote) {
  for (let index = transcript.indexOf(quote); index >= 0; index = transcript.indexOf(quote, index + 1)) {
    const before = transcript.slice(0, index), after = transcript.slice(index + quote.length);
    if (/(?:^|[.!?\n])\s*$/.test(before) && (/^\s*(?:[.!?\n]|$)/.test(after) || /[.!?\n]\s*$/.test(quote))) return true;
  }
  return false;
}
export function groundUnderstanding(raw, transcript) {
  if (raw?.rol !== 'comprension' || !Array.isArray(raw.evidencias) || raw.evidencias.length > 8) throw new Error('Comprensión inválida');
  const seen = new Set();
  const evidencias = raw.evidencias.map(e => {
    if (!e || !Object.hasOwn(kinds, e.tipo) || typeof e.cita !== 'string' || !e.cita.trim() || e.cita.length > 600 || !wholeSentence(transcript, e.cita)) throw new Error('Evidencia sin respaldo');
    return { tipo: e.tipo, cita: e.cita, observacion: kinds[e.tipo][1] };
  }).filter(e => { const key = JSON.stringify([e.tipo, e.cita]); if (seen.has(key)) return false; seen.add(key); return true; });
  const topics = [...new Set(evidencias.map(e => kinds[e.tipo][0]))];
  return {
    rol: 'comprension', modo: 'extractivo_sin_identidades_v1',
    estado: evidencias.length ? 'analizado' : 'informacion_insuficiente',
    resumen: topics.length ? `Fragmentos seleccionados para revisar: ${topics.join(', ')}. Las citas conservan el texto recibido; no se atribuyen identidades ni hablantes.` : 'No hay citas suficientes para organizar el texto; no se atribuyen identidades ni hablantes.',
    participantes_mencionados: [],
    solicitudes: evidencias.filter(e => e.tipo === 'solicitud').map(e => ({ cita: e.cita, destinatario: 'no determinado' })),
    datos_observados: evidencias.map(e => e.cita), evidencias,
    incertidumbres: ['No se determina quién habla ni quién recibe una petición o amenaza.', 'Las palabras dudosas deben contrastarse con el audio; no se reconstruyen a partir de suposiciones.'],
    limitaciones: ['Identidades no verificadas ni atribuidas.', 'Posibles errores de transcripción; una cita literal no confirma que el audio diga lo mismo.'],
  };
}
