import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCaptions, liveSessionConfig, liveAnalysisContext } from '../live-voice.mjs';
const delta = (id, text, at, type = 'session.input_transcript.delta') => ({ type, event_id: id, delta: text, start_ms: at, end_ms: at + 10 });
test('Live: ordena deltas sin inventar espacios ni perder negaciones; excluye voz del agente', () => {
  const c = new LiveCaptions();
  c.append(delta('b', ' necesito pagos ni datos personales.', 30));
  c.append(delta('a', 'No', 0));
  c.append(delta('c', '¿Le pidieron dinero?', 40, 'session.output_transcript.delta'));
  assert.equal(c.append(delta('a', 'otro texto', 0)), null);
  assert.equal(c.text('caller'), 'No necesito pagos ni datos personales.');
  assert.equal(c.text('agent'), '¿Le pidieron dinero?');
  assert.equal(c.append(delta('bad', 'dato', -1)), null);
});
test('Live: limita texto completo sin cortar un prefijo negativo', () => {
  const c = new LiveCaptions();
  for (let i=0; i<3; i++) c.append(delta('a'+i, 'x'.repeat(4000), i));
  assert.throws(() => c.append(delta('overflow', '!', 4)), /caption_limit/);
  assert.equal(c.text('caller').length, 12000);
});
test('Live: contexto no confunde análisis pendiente o fallido con FALSE', () => {
  const room={revision:2};
  assert.equal(JSON.parse(liveAnalysisContext(room)).estado, 'analisis_pendiente');
  room.detectResult={revision:2,error:true};room.understandResult={revision:2,value:{resumen:'Descripción observada.'}};
  assert.equal(JSON.parse(liveAnalysisContext(room)).alerta, null);
  room.detectResult={revision:2,value:{alerta:false}};
  assert.equal(JSON.parse(liveAnalysisContext(room)).alerta, false);
  const config=liveSessionConfig();assert.equal(config.audio.output.voice,'marin');assert.equal(config.store,false);assert.equal(config.delegation.type,'client');
});

test('Live entrega orientación comprobable al agente, sin inferir voz sintética del texto', () => {
  const room = { revision: 3, assessmentText: 'Necesito dinero.', detectResult: { revision: 3, value: { alerta: false, probabilidad: .1 } }, understandResult: { revision: 3, value: { rol: 'comprension', evidencias: [{ tipo: 'peticion_pago', cita: 'Necesito dinero.' }] } } };
  const context = JSON.parse(liveAnalysisContext(room));
  assert.equal(context.orientacion.estado, 'verificar');
  assert.equal(context.orientacion.voz_sintetica.estado, 'no_evaluada');
  assert.deepEqual(context.orientacion.identidades_verificadas, []);
  assert.equal(context.orientacion.evidencia_textual, undefined);
});
