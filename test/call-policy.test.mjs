import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCall, currentAssessment } from '../call-policy.mjs';

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
