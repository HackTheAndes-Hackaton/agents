import test from 'node:test';
import assert from 'node:assert/strict';
import { groundUnderstanding } from '../understanding.mjs';

const corrupt = 'Enrique mil soles ahora mismo o le haré daño a tu familia. No cortes la llamada.';
test('comprensión: una palabra mal transcrita nunca se convierte en identidad o hablante', () => {
  const result = groundUnderstanding({ rol: 'comprension', resumen: 'Enrique recibe la amenaza de Pedro.', participantes_mencionados: ['Enrique', 'Pedro'], datos_observados: ['Pedro llamó'], solicitudes: ['Pagar a Pedro'], incertidumbres: ['Enrique es real'], limitaciones: ['Identidad confirmada'], evidencias: [{ tipo: 'amenaza', cita: corrupt, observacion: 'Pedro amenaza a Enrique' }] }, corrupt);
  assert.equal(result.modo, 'extractivo_sin_identidades_v1');
  assert.deepEqual(result.participantes_mencionados, []);
  assert.deepEqual(result.solicitudes, []);
  assert.equal(result.evidencias[0].cita, corrupt);
  for (const text of [result.resumen, ...result.incertidumbres, ...result.limitaciones, result.evidencias[0].observacion]) assert.doesNotMatch(text, /Enrique|Pedro/);
});
test('comprensión: conserva negaciones y una presentación literal sin atribuir identidades', () => {
  const source = 'Hola, soy Ana. No necesito pagos ni datos personales.';
  const result = groundUnderstanding({ rol: 'comprension', resumen: 'Ana pide dinero', evidencias: [{ tipo: 'contexto', cita: 'Hola, soy Ana.' }, { tipo: 'negacion', cita: 'No necesito pagos ni datos personales.' }] }, source);
  assert.doesNotMatch(result.resumen, /Ana|pide dinero/);
  assert.deepEqual(result.participantes_mencionados, []);
  assert.equal(result.evidencias[1].cita, 'No necesito pagos ni datos personales.');
  assert.deepEqual(result.solicitudes, []);
});
test('comprensión: rechaza citas reconstruidas, tipos libres y respuestas sin evidencia estructurada', () => {
  for (const evidencias of [[{ tipo: 'amenaza', cita: 'Transfiere mil soles ahora mismo' }], [{ tipo: 'identidad_confirmada', cita: corrupt }], [null]]) {
    assert.throws(() => groundUnderstanding({ rol: 'comprension', evidencias }, corrupt));
  }
  assert.throws(() => groundUnderstanding({ rol: 'comprension', resumen: 'Inventado' }, corrupt));
  const result = groundUnderstanding({ rol: 'comprension', resumen: 'Pedro llamó', evidencias: [] }, corrupt);
  assert.equal(result.estado, 'informacion_insuficiente');
  assert.doesNotMatch(JSON.stringify(result), /Pedro/);
});

test('comprensión: rechaza extracción que elimina negación o contexto anterior', () => {
  for (const [source, quote] of [['No necesito pagos ni datos personales.', 'necesito pagos ni datos personales.'], ['La noticia cita una amenaza: Transfiere ahora.', 'Transfiere ahora.']]) {
    assert.throws(() => groundUnderstanding({ rol: 'comprension', evidencias: [{ tipo: 'solicitud', cita: quote }] }, source), /Evidencia sin respaldo/);
  }
});
