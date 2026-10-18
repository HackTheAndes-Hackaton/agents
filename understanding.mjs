import { readFile } from 'node:fs/promises';
const localContext = await readFile(new URL('./prompts/es-PE.md', import.meta.url), 'utf8');
const instructions = await readFile(new URL('./prompts/comprension.md', import.meta.url), 'utf8') + '\n\n' + localContext;
const segmentInstructions = await readFile(new URL('./prompts/comprension-segmentos.md', import.meta.url), 'utf8') + '\n\n' + localContext;

export async function understandIncident(incident, options) {
  const segments = options.selectSegments ? understandingSegments(incident.transcripcion) : null;
  if (segments && !segments.length) return groundUnderstanding({ rol: 'comprension', evidencias: [] }, incident.transcripcion);

  const source = segments ? { consentimiento_analisis: true, segmentos_permitidos: segments } : incident;
  const format = segments ? { type: 'json_schema', json_schema: { name: 'seleccion_fragmentos', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['rol', 'evidencias'], properties: {
      rol: { type: 'string', enum: ['comprension'] }, evidencias: { type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['tipo', 'segmento'], properties: {
          tipo: { type: 'string', enum: Object.keys(kinds) }, segmento: { type: 'string', enum: segments.map(s => s.id) },
        },
      } },
    },
  } } } : { type: 'json_object' };
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: options.model ?? 'gpt-4.1-mini', messages: [{ role: 'system', content: segments ? segmentInstructions : instructions }, { role: 'user', content: JSON.stringify(source) }], max_tokens: 1200, response_format: format }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  if (!response.ok) throw new Error(`Comprensión: HTTP ${response.status}`);
  const body = await response.json();
  const raw = JSON.parse(body.choices?.[0]?.message?.content ?? 'null');
  return segments ? groundSegmentSelection(raw, segments, incident.transcripcion) : groundUnderstanding(raw, incident.transcripcion);
}

// Solo se publica texto literal o redactado por el servidor; nunca prosa libre del modelo.
const kinds = {
  saludo: ['saludos', 'Saludo o reconocimiento breve; todavía no aporta el motivo de la llamada.'],
  presentacion: ['presentaciones declaradas', 'Presentación literal; no verifica identidad ni aporta por sí sola el motivo de la llamada.'],
  solicitud_cotidiana: ['solicitudes cotidianas', 'Petición cotidiana seleccionada, sin acción sensible en este fragmento; no garantiza seguridad futura.'],
  relato_amenaza: ['relatos de amenazas recibidas', 'Se relata una amenaza recibida o citada; no se atribuye esa amenaza a quien habla.'],
  peticion_pago: ['peticiones de pago', 'Petición económica seleccionada; por sí sola no demuestra fraude.'],
  peticion_credenciales: ['peticiones de claves o códigos', 'Petición de credenciales seleccionada; revisar su contexto sin reproducir secretos adicionales.'],
  acceso_remoto: ['peticiones de acceso remoto', 'Petición de acceso seleccionada; no prueba que se haya concedido acceso.'],
  autoridad_alegada: ['autoridad alegada', 'Una entidad o cargo mencionado no verifica una identidad.'],
  presion: ['presión temporal', 'Expresión de urgencia seleccionada; por sí sola no demuestra fraude.'],
  aislamiento: ['restricciones a verificar', 'Expresión seleccionada sobre secreto o impedimento de verificación independiente.'],
  verificacion_independiente: ['posibilidad de verificar', 'Se menciona verificación independiente; no confirma que se haya realizado.'],
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
    solicitudes: evidencias.filter(e => ['solicitud', 'solicitud_cotidiana', 'peticion_pago', 'peticion_credenciales', 'acceso_remoto'].includes(e.tipo)).map(e => ({ cita: e.cita, destinatario: 'no determinado' })),
    datos_observados: evidencias.map(e => e.cita), evidencias,
    incertidumbres: ['No se determina quién habla ni quién recibe una petición o amenaza.', 'Las palabras dudosas deben contrastarse con el audio; no se reconstruyen a partir de suposiciones.'],
    limitaciones: ['Identidades no verificadas ni atribuidas.', 'Posibles errores de transcripción; una cita literal no confirma que el audio diga lo mismo.'],
  };
}


// Selección por id: la puntuación del modelo nunca reemplaza los subtítulos originales.
export function understandingSegments(transcript) {
  return [...transcript.matchAll(/[^.!?\n]+(?:[.!?]+|$)/g)]
    .map(m => m[0].trim()).filter(text => text && text.length <= 600)
    .slice(-128).map((text, i) => ({ id: `s${i}`, texto: text }));
}
export function groundSegmentSelection(raw, segments, transcript) {
  if (raw?.rol !== 'comprension' || !Array.isArray(raw.evidencias) || raw.evidencias.length > 8) throw Error('Selección inválida');
  const selected = new Map(segments.map(s => [s.id, s.texto]));
  const evidencias = raw.evidencias.map(e => {
    if (!e || typeof e.segmento !== 'string' || !selected.has(e.segmento)) throw Error('Segmento sin respaldo');
    return { tipo: e.tipo, cita: selected.get(e.segmento) };
  });
  return groundUnderstanding({ rol: 'comprension', evidencias }, transcript);
}
