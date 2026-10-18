import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCall, assessmentEvents } from '../call-policy.mjs';
import { fraudSources, principalFraudType } from '../fraud-taxonomy.mjs';

const decide = alerta => ({ alerta, probabilidad: alerta ? .93 : .08 });
const target = (text, types, alerta = true) => ({ revision: 1,
  detectResult: { revision: 1, value: decide(alerta) },
  understandResult: { revision: 1, value: { rol: 'comprension', evidencias: types.map(tipo => ({ tipo, cita: text })) } },
});

test('modalidades publican tipo provisional, citas ancladas y referencias editoriales en español', () => {
  for (const [text, types, category] of [
    ['Paga el cupo o le haré daño a tu familia.', ['amenaza', 'peticion_pago'], 'posible_extorsion'],
    ['Soy del banco, necesito tu código de acceso.', ['autoridad_alegada', 'peticion_credenciales'], 'posible_fraude_credenciales'],
    ['Soy de soporte, permite que controle tu dispositivo.', ['autoridad_alegada', 'acceso_remoto'], 'posible_fraude_acceso_remoto'],
    ['Transfiere ahora y no lo consultes con nadie.', ['peticion_pago', 'presion', 'aislamiento'], 'posible_fraude_pago'],
  ]) {
    const [state, risk] = assessmentEvents(target(text, types), text);
    const m = state.assessment.modalidades[0];
    assert.equal(m.categoria, category);
    assert.equal(m.interpretacion, 'hipotesis_preventiva');
    assert.equal(risk.scam_type, m.etiqueta);
    assert.ok(m.fuentes.length > 0);
    assert.ok(m.fuentes.every(id => fraudSources[id]?.idioma === 'es'));
    assert.ok(m.evidencias.every(e => e.cita === text));
    assert.equal(risk.risk_percent, 93);
  }
});

test('la alerta no espera una modalidad y no inventa un tipo sin comprensión', () => {
  const t = { revision: 1, detectResult: { revision: 1, value: decide(true) } };
  const [state, risk] = assessmentEvents(t, 'Audio transcrito ficticio.');
  assert.equal(state.explanation_pending, true);
  assert.equal(state.assessment.alerta, true);
  assert.equal(risk.scam_type, null);
});

test('negaciones, jerga, relatos y préstamos legítimos no reciben automáticamente un tipo de estafa', () => {
  for (const [text, types] of [
    ['No me compartas tu clave ni códigos.', ['negacion']],
    ['Causa, mañana coordinamos una reunión.', ['solicitud_cotidiana']],
    ['Me amenazaron y necesito orientación para denunciar.', ['relato_amenaza']],
    ['Préstame si puedes, puedo esperar y verificar contigo.', ['peticion_pago', 'verificacion_independiente']],
  ]) {
    const [state, risk] = assessmentEvents(target(text, types, false), text);
    assert.equal(state.assessment.alerta, false);
    assert.equal(risk.scam_type, null);
  }
});

test('una corrección o un antecedente vocal no heredan una clasificación textual anterior', () => {
  const text = 'No necesito dinero ni códigos.';
  const t = target(text, ['negacion'], false);
  t.voiceMatch = { strong: true, scam_type: 'Extorsión en un reporte anterior' };
  const [state, risk] = assessmentEvents(t, text);
  assert.equal(principalFraudType(state.assessment), null);
  assert.equal(risk.scam_type, null);
  const invalid = assessCall({ transcript: text, decision: decide(true), understanding: {
    rol: 'comprension', evidencias: [{ tipo: 'amenaza', cita: 'Una amenaza inventada.' }],
  } });
  assert.deepEqual(invalid.modalidades, []);
});
