import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate, summarize } from '../eval/evaluate.mjs';

test('evaluador no revela etiquetas ni turnos futuros al modelo y conserva fallos', async () => {
  const inputs = [];
  const cases = [{ id: 'a', label: true, alert_from_turn: 2, turns: ['Hola.', 'Amenaza.'] }];
  const rows = await evaluate(cases, async text => { inputs.push(text); if (text === 'Hola.') throw Error('caída'); return { alerta: true, probabilidad: .8 }; });
  assert.deepEqual(inputs, ['Hola.', 'Hola.\nAmenaza.']);
  assert.equal(rows[0].status, 'error');
  const summary = summarize(cases, rows);
  assert.equal(summary.failed_or_missing_predictions, 1);
  assert.equal(summary.mean_delay_turns_detected_only, 0);
});
test('métricas penalizan falsas alertas tempranas aunque el último resultado sea correcto', () => {
  const cases = [{ id: 'a', label: false, turns: ['a', 'b'] }, { id: 'b', label: true, alert_from_turn: 2, turns: ['a', 'c'] }, { id: 'c', label: true, alert_from_turn: 1, turns: ['d'] }];
  const rows = [
    { id: 'a', turn: 1, status: 'ok', alerta: true, probability: .9 },
    { id: 'a', turn: 2, status: 'ok', alerta: false, probability: .1 },
    { id: 'b', turn: 1, status: 'ok', alerta: true, probability: .9 },
    { id: 'b', turn: 2, status: 'ok', alerta: true, probability: .9 },
    { id: 'c', turn: 1, status: 'error', alerta: null },
  ];
  const s = summarize(cases, rows);
  assert.equal(s.balanced_accuracy_answered_only, 1);
  assert.equal(s.fraud_recall_including_failures, .5);
  assert.equal(s.final_answer_coverage, 2 / 3);
  assert.equal(s.false_alert_call_rate, 1);
  assert.deepEqual(s.premature_alert_calls, ['b']);
  assert.deepEqual(s.missed_actionable_calls, ['c']);
  assert.throws(() => summarize(cases, [...rows, rows[0]]), /duplicado/);
});
test('corpus empareja aperturas sin adelantar la conducta decisiva y contiene incertidumbre', async () => {
  const { cases } = JSON.parse(await readFile(new URL('../eval/casos-es-PE-v1.json', import.meta.url)));
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const id of new Set(cases.map(c => c.pair_id).filter(Boolean))) {
    const pair = cases.filter(c => c.pair_id === id);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].turns[0], pair[1].turns[0]);
    assert.notEqual(pair[0].label, pair[1].label);
    assert.equal(pair.find(c => c.label).alert_from_turn, 2);
  }
  assert.ok(cases.some(c => c.label === null));
});
test('contraejemplos son legítimos, únicos y se relacionan con estafas del corpus', async () => {
  const base = JSON.parse(await readFile(new URL('../eval/casos-es-PE-v1.json', import.meta.url))).cases;
  const { cases } = JSON.parse(await readFile(new URL('../eval/contraejemplos-es-PE-v1.json', import.meta.url)));
  const ids = new Set([...base, ...cases].map(c => c.id));
  assert.equal(ids.size, base.length + cases.length);
  for (const c of cases) {
    assert.equal(c.label, false);
    assert.equal(c.alert_from_turn, null);
    assert.ok(c.turns.length >= 2 && c.turns.every(t => typeof t === 'string' && t.trim()));
    assert.ok(c.note && c.parece);
    if (c.relacionado_con) assert.equal(base.find(b => b.id === c.relacionado_con)?.label, true);
  }
  const rows = cases.flatMap(c => c.turns.map((_, i) => ({ id: c.id, turn: i + 1, status: 'ok', alerta: false, probability: .1 })));
  assert.equal(summarize(cases, rows).false_alert_call_rate, 0);
});
