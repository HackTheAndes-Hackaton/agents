import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCall } from '../call-policy.mjs';
const analyze = (text, types, alerta = false) => assessCall({ transcript: text,
  decision: { alerta, probabilidad: alerta ? .9 : .1 },
  understanding: { rol: 'comprension', evidencias: types.map(tipo => ({ tipo, cita: text })) } });

test('jerga o familiaridad no crean una modalidad delictiva ni activan alerta', () => {
  const r = analyze('Habla causa, mañana nos vemos pe.', ['solicitud_cotidiana']);
  assert.equal(r.alerta, false); assert.equal(r.estado, 'observar');
  assert.deepEqual(r.modalidades.map(m => m.categoria), ['solicitud_cotidiana']);
});
test('la modalidad no eleva una decisión FALSE y conserva la frase completa', () => {
  const text = 'Yapéame cuando puedas, puedo esperar y comprobarlo contigo.';
  const r = analyze(text, ['peticion_pago', 'verificacion_independiente']);
  assert.equal(r.alerta, false); assert.equal(r.estado, 'verificar');
  assert.equal(r.modalidades[0].categoria, 'peticion_economica_por_verificar');
  assert.equal(r.modalidades[0].evidencias[0].cita, text);
});
test('coacción y credenciales se segmentan sin atribuir identidades', () => {
  const a = analyze('Paga el cupo o le hacemos daño a tu familia.', ['amenaza', 'peticion_pago'], true);
  assert.equal(a.modalidades[0].categoria, 'posible_extorsion');
  const b = analyze('Soy del banco, dime el código de acceso que te llegó.', ['peticion_credenciales', 'autoridad_alegada'], true);
  assert.equal(b.modalidades[0].categoria, 'posible_fraude_credenciales');
  assert.deepEqual(b.identidades_verificadas, []); assert.equal(b.acciones_automaticas, false);
});
test('relatos y negaciones no se convierten por keywords en extorsión', () => {
  const r = analyze('Mi pata recibió una amenaza, no te estoy pidiendo dinero.', ['relato_amenaza', 'negacion']);
  assert.deepEqual(r.modalidades.map(m => m.categoria), ['relato_o_denuncia']);
  assert.equal(r.alerta, false);
});
test('una amenaza sin exigencia o condición no se etiqueta automáticamente como extorsión', () => {
  const r = analyze('Voy a hacerte daño.', ['amenaza'], true);
  assert.equal(r.alerta, true);
  assert.equal(r.modalidades[0].categoria, 'amenaza_por_verificar');
});
test('citas inventadas no producen categorías aunque el detector alerte', () => {
  const r = assessCall({ transcript: 'Hola causa.', decision: { alerta: true, probabilidad: .9 },
    understanding: { rol: 'comprension', evidencias: [{ tipo: 'amenaza', cita: 'Págame o te hago daño.' }] } });
  assert.equal(r.estado, 'alertar'); assert.deepEqual(r.modalidades, []);
});
