import { groundUnderstanding } from './understanding.mjs';
import { segmentRisk } from './risk-segments.mjs';

const guidance = {
  observar: 'Escucha el siguiente turno. La ausencia de señales actuales no demuestra que la llamada sea segura.',
  verificar: 'Antes de cualquier pago, dato o acceso, propone verificar por un canal conocido de antemano. No uses un número o enlace proporcionado en esta llamada ni solicites claves o códigos.',
  alertar: 'Advierte del riesgo sin acusar ni atribuir identidad. Recomienda no transferir ni compartir claves y verificar por un canal independiente.',
  inconcluso: 'Pide repetir o aclarar la petición. No completes palabras dudosas ni interpretes un fallo de análisis como ausencia de riesgo.',
};
const requests = new Set(['peticion_pago', 'peticion_credenciales', 'acceso_remoto', 'presion', 'aislamiento', 'amenaza']);
const descriptions = {
  peticion_pago: 'una petición de dinero', peticion_credenciales: 'una petición de claves o códigos',
  acceso_remoto: 'una petición de acceso remoto', presion: 'presión para actuar de inmediato',
  aislamiento: 'restricciones para verificar por otro canal', amenaza: 'una posible amenaza',
  solicitud: 'una petición todavía sin clasificar', autoridad_alegada: 'una identidad declarada que aún no se ha comprobado',
};

// Política de orientación; no autoriza cortes, retención, SMS ni identifica voces.
// La cita prueba qué texto llegó, no que el audio sea fiel ni la etiqueta correcta.
export function assessCall({ transcript, decision, understanding }) {
  let grounded = null;
  try { grounded = groundUnderstanding(understanding, transcript); } catch { /* Abstención explícita. */ }
  const validDecision = typeof decision?.alerta === 'boolean' && Number.isFinite(decision?.probabilidad) && decision.probabilidad >= 0 && decision.probabilidad <= 1;
  const signals = grounded?.evidencias ?? [];
  // Solo marcadores explícitos; no fingir una confianza ASR que Vapi no entrega.
  const explicitGap = typeof transcript === 'string' && /\[(?:inaudible|ininteligible|audio no disponible)\]/iu.test(transcript);
  let state;
  if (validDecision && decision.alerta) state = 'alertar';
  else if (explicitGap || !validDecision || !grounded || !signals.length || signals.some(e => e.tipo === 'ambiguo') || signals.every(e => ['saludo', 'presentacion'].includes(e.tipo))) state = 'inconcluso';
  else if (signals.some(e => requests.has(e.tipo) || e.tipo === 'autoridad_alegada')) state = 'verificar';
  else if (signals.some(e => e.tipo === 'solicitud')) state = 'inconcluso';
  else state = 'observar';
  const topics = [...new Set(signals.map(e => descriptions[e.tipo]).filter(Boolean))].slice(0, 3);
  const reason = explicitGap ? 'Hay un fragmento marcado como inaudible; hace falta aclaración.'
    : topics.length ? `Señales seleccionadas en el texto: ${topics.join(', ')}. No verifican una identidad ni confirman una estafa.`
    : state === 'alertar' ? 'El detector pide revisar un posible riesgo; aún no hay una explicación textual disponible.'
    : state === 'inconcluso' ? 'Falta información suficiente para interpretar este fragmento.'
    : 'No se ha identificado una petición de riesgo en el texto disponible; esto no garantiza seguridad.';
  return {
    version: 'orientacion_v1', estado: state, motivo: reason, orientacion: guidance[state],
    alerta: validDecision ? decision.alerta : null,
    evidencia_textual: signals.map(({ tipo, cita }) => ({ tipo, cita })),
    modalidades: segmentRisk(signals, validDecision && decision.alerta),
    explicacion_disponible: Boolean(grounded?.evidencias.length),
    fragmento_inaudible_marcado: explicitGap,
    voz_sintetica: { estado: 'no_evaluada', motivo: 'No hay un detector acústico validado en este canal.' },
    identidades_verificadas: [], acciones_automaticas: false,
  };
}

// No mezclar resultados de turnos distintos, aunque el modelo lento termine después.
export function currentAssessment(target, transcript) {
  if (target.detectResult?.revision !== target.revision || target.understandResult?.revision !== target.revision) return null;
  return assessCall({ transcript, decision: target.detectResult.error ? null : target.detectResult.value,
    understanding: target.understandResult.error ? null : target.understandResult.value });
}

// Eventos ya entendidos por la APK. La APK decide cómo presentar su aviso local.
export function assessmentEvents(target, transcript) {
  const pendingAlert = target.detectResult?.revision === target.revision && !target.detectResult.error &&
    target.detectResult.value?.alerta === true && target.understandResult?.revision !== target.revision;
  const assessment = pendingAlert
    ? assessCall({ transcript, decision: target.detectResult.value, understanding: null })
    : currentAssessment(target, transcript);
  if (!assessment) return [];
  const events = [{ type: 'assessment.update', revision: target.revision, provisional: true, explanation_pending: pendingAlert, assessment }];
  if (assessment.alerta !== null) {
    events.push({ type: 'risk.update', revision: target.revision,
      risk_percent: Math.round(target.detectResult.value.probabilidad * 100), alerta: assessment.alerta,
      reasons: [assessment.motivo], scam_type: null, impersonating: null,
      score_kind: 'probabilidad_de_alerta_no_calibrada' });
  }
  // "Observar" solo permite incorporarse después de revisar el texto disponible; no verifica identidades.
  if (!pendingAlert && assessment.estado === 'observar' && assessment.alerta === false) {
    events.push({ type: 'call.ready_to_answer', revision: target.revision, identity_verified: false });
  }
  return events;
}
