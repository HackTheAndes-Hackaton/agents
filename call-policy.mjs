import { groundUnderstanding } from './understanding.mjs';

const guidance = {
  observar: 'Escucha el siguiente turno. La ausencia de señales actuales no demuestra que la llamada sea segura.',
  verificar: 'Antes de cualquier pago, dato o acceso, propone verificar por un canal conocido de antemano. No uses un número o enlace proporcionado en esta llamada ni solicites claves o códigos.',
  alertar: 'Advierte del riesgo sin acusar ni atribuir identidad. Recomienda no transferir ni compartir claves y verificar por un canal independiente.',
  inconcluso: 'Pide repetir o aclarar la petición. No completes palabras dudosas ni interpretes un fallo de análisis como ausencia de riesgo.',
};
const requests = new Set(['solicitud', 'peticion_pago', 'peticion_credenciales', 'acceso_remoto', 'presion', 'aislamiento', 'amenaza']);

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
  else if (explicitGap || !validDecision || !grounded || !signals.length || signals.some(e => e.tipo === 'ambiguo')) state = 'inconcluso';
  else if (signals.some(e => requests.has(e.tipo))) state = 'verificar';
  else state = 'observar';
  return {
    version: 'orientacion_v1', estado: state, orientacion: guidance[state],
    alerta: validDecision ? decision.alerta : null,
    evidencia_textual: signals.map(({ tipo, cita }) => ({ tipo, cita })),
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
