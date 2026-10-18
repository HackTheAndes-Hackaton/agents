import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCall, currentAssessment, assessmentEvents } from '../call-policy.mjs';

const decision = (alerta = false) => ({ alerta, probabilidad: alerta ? 0.9 : 0.1 });
function assess(text, tipo, d = decision()) {
  return assessCall({ transcript: text, decision: d, understanding: { rol: 'comprension', evidencias: [{ tipo, cita: text }] } });
}
test('dinero sin alerta provoca verificación, no una acusación ni una orden de corte', () => {
  const result = assess('Necesito que me prestes dinero.', 'peticion_pago');
  assert.equal(result.estado, 'verificar');
  assert.equal(result.alerta, false);
  assert.equal(result.acciones_automaticas, false);
  assert.deepEqual(result.identidades_verificadas, []);
  assert.match(result.orientacion, /canal conocido/);
});
test('negaciones y advertencias citadas no se convierten en peticiones por palabras clave', () => {
  assert.equal(assess('No necesito claves ni pagos.', 'negacion').estado, 'observar');
  assert.equal(assess('La noticia dice que el estafador exigió dinero.', 'contexto').estado, 'observar');
});
test('un fallo o cita reconstruida obliga a abstenerse, sin ocultar una alerta independiente', () => {
  assert.equal(assess('No se entiende la petición.', 'ambiguo').estado, 'inconcluso');
  assert.equal(assess('Hola.', 'contexto', null).estado, 'inconcluso');
  const input = { transcript: 'No quiero dinero.', decision: decision(), understanding: { rol: 'comprension', evidencias: [{ tipo: 'peticion_pago', cita: 'quiero dinero.' }] } };
  assert.equal(assessCall(input).estado, 'inconcluso');
  const result = assessCall({ ...input, decision: decision(true) });
  assert.equal(result.estado, 'alertar');
  assert.equal(result.explicacion_disponible, false);
  assert.deepEqual(result.evidencia_textual, []);
});
test('texto o voz alegada no verifican identidad ni determinan si hay síntesis', () => {
  for (const d of [decision(), decision(true)]) {
    const result = assess('Soy tu familiar, reconoce mi voz.', 'autoridad_alegada', d);
    assert.equal(result.voz_sintetica.estado, 'no_evaluada');
    assert.deepEqual(result.identidades_verificadas, []);
    if (!d.alerta) assert.equal(result.estado, 'verificar');
  }
});
test('un marcador de audio faltante exige aclaración aunque comprensión lo clasifique como petición', () => {
  const text = 'Necesito que gane el [inaudible] en comisiones.';
  const result = assess(text, 'solicitud');
  assert.equal(result.estado, 'inconcluso');
  assert.equal(result.fragmento_inaudible_marcado, true);
  // La ausencia del marcador no certifica que ASR haya transcrito correctamente.
  assert.equal(assess('Necesito dinero.', 'peticion_pago').fragmento_inaudible_marcado, false);
  assert.equal(assess(text, 'solicitud', decision(true)).estado, 'alertar');
});
test('descarta resultados atrasados; solo orienta con la misma revisión', () => {
  const room = { revision: 2, detectResult: { revision: 1, value: decision(true) }, understandResult: { revision: 2, value: { rol: 'comprension', evidencias: [{ tipo: 'negacion', cita: 'No pido dinero.' }] } } };
  assert.equal(currentAssessment(room, 'No pido dinero.'), null);
  room.detectResult = { revision: 2, value: decision() };
  assert.equal(currentAssessment(room, 'No pido dinero.').estado, 'observar');
});

test('el aviso de la APK recibe motivo, porcentaje y estado de la misma revisión sin filtrar citas', () => {
  const text = 'Soy Ana, necesito dinero.';
  const target = { revision: 4, detectResult: { revision: 4, value: decision() }, understandResult: { revision: 4, value: { rol: 'comprension', evidencias: [{ tipo: 'peticion_pago', cita: text }] } } };
  const [state, risk] = assessmentEvents(target, text);
  assert.equal(state.assessment.estado, 'verificar');
  assert.equal(state.revision, risk.revision);
  assert.equal(risk.risk_percent, 10);
  assert.equal(risk.alerta, false);
  assert.match(risk.reasons[0], /petición de dinero/);
  assert.doesNotMatch(risk.reasons[0], /Ana/);
  assert.equal(risk.reasons[0], state.assessment.motivo);
  target.detectResult = { revision: 4, error: true };
  assert.deepEqual(assessmentEvents(target, text).map(e => e.type), ['assessment.update']);
  target.revision = 5;
  assert.deepEqual(assessmentEvents(target, text), []);
});

test('TRUE publica alertar sin esperar comprensión; no inventa citas ni oculta que falta explicación', () => {
  const target = { revision: 2, detectResult: { revision: 2, value: decision(true) } };
  const [state, risk] = assessmentEvents(target, 'Texto de ejemplo.');
  assert.equal(state.assessment.estado, 'alertar');
  assert.equal(state.explanation_pending, true);
  assert.equal(state.assessment.explicacion_disponible, false);
  assert.deepEqual(state.assessment.evidencia_textual, []);
  assert.equal(risk.risk_percent, 90);
  target.detectResult.value = decision(false);
  assert.deepEqual(assessmentEvents(target, 'Texto de ejemplo.'), []);
});

test('call.ready_to_answer solo se emite al terminar una revisión observar y no valida identidades', () => {
  const text = 'No necesito pagos ni datos personales.';
  const target = { revision: 6, detectResult: { revision: 6, value: decision() },
    understandResult: { revision: 6, value: { rol: 'comprension', evidencias: [{ tipo: 'negacion', cita: text }] } } };
  const events = assessmentEvents(target, text);
  assert.deepEqual(events.map(e => e.type), ['assessment.update', 'risk.update', 'call.ready_to_answer']);
  assert.equal(events.at(-1).revision, 6);
  assert.equal(events.at(-1).identity_verified, false);

  target.understandResult.value.evidencias = [{ tipo: 'autoridad_alegada', cita: 'Soy tu familiar.' }];
  const claim = assessmentEvents(target, 'Soy tu familiar.');
  assert.equal(claim[0].assessment.estado, 'verificar');
  assert.equal(claim.some(e => e.type === 'call.ready_to_answer'), false);
  target.detectResult.value = decision(true);
  assert.equal(assessmentEvents(target, 'Soy tu familiar.').some(e => e.type === 'call.ready_to_answer'), false);
});
