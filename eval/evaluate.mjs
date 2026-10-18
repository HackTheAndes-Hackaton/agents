// Cada invocación recibe solo el prefijo disponible, nunca etiquetas o turnos futuros.
export async function evaluate(cases, predict, concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error('Concurrencia inválida');
  let index = 0;
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (index < cases.length) {
      const sample = cases[index++];
      for (let turn = 1; turn <= sample.turns.length; turn++) {
        const started = performance.now();
        try {
          const result = await predict(sample.turns.slice(0, turn).join('\n'));
          const d = result.decision ?? result;
          if (typeof d.alerta !== 'boolean' || !Number.isFinite(d.probabilidad) || d.probabilidad < 0 || d.probabilidad > 1) throw Error('invalid_prediction');
          rows.push({ id: sample.id, turn, status: 'ok', alerta: d.alerta, probability: d.probabilidad, model: d.modelo,
            assessment: result.assessment, latency_ms: Math.round(performance.now() - started) });
        } catch {
          // No volcar mensajes upstream: pueden contener entradas o credenciales.
          rows.push({ id: sample.id, turn, status: 'error', alerta: null, latency_ms: Math.round(performance.now() - started) });
        }
      }
    }
  }));
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.turn - b.turn);
}

const ratio = (a, b) => b ? a / b : null;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function summarize(cases, rows) {
  const keyed = new Map();
  for (const row of rows) {
    const sample = cases.find(s => s.id === row.id);
    if (!sample || !Number.isInteger(row.turn) || row.turn < 1 || row.turn > sample.turns.length || keyed.has(`${row.id}:${row.turn}`)) throw Error('Resultado duplicado o ajeno al corpus');
    if (row.status !== 'error' && (row.status !== 'ok' || typeof row.alerta !== 'boolean' || !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1)) throw Error('Predicción inválida');
    keyed.set(`${row.id}:${row.turn}`, row);
  }
  const positives = cases.filter(c => c.label === true), negatives = cases.filter(c => c.label === false);
  let tp = 0, tn = 0, fp = 0, fn = 0, unanswered = 0;
  const brier = [], delays = [], missed = [], premature = [], falseAlerts = [], uncertainAlerts = [];
  for (const c of cases) {
    const turns = c.turns.map((_, i) => keyed.get(`${c.id}:${i + 1}`));
    const alerts = turns.filter(r => r?.status === 'ok' && r.alerta);
    const last = turns.at(-1);
    if (c.label !== null) {
      if (last?.status !== 'ok') unanswered++;
      else {
        if (c.label) { if (last.alerta) tp++; else fn++; }
        else { if (last.alerta) fp++; else tn++; }
        brier.push((last.probability - Number(c.label)) ** 2);
      }
    }
    if (c.label === false && alerts.length) falseAlerts.push(c.id);
    if (c.label === null && alerts.length) uncertainAlerts.push(c.id);
    if (c.label === true) {
      if (alerts.some(r => r.turn < c.alert_from_turn)) premature.push(c.id);
      const timely = alerts.find(r => r.turn >= c.alert_from_turn);
      if (timely) delays.push(timely.turn - c.alert_from_turn); else missed.push(c.id);
    }
  }
  const f1 = (a, b, c) => ratio(2 * a, 2 * a + b + c);
  const expected = cases.reduce((n, c) => n + c.turns.length, 0);
  return {
    calls: cases.length, expected_predictions: expected, successful_predictions: rows.filter(r => r.status === 'ok').length,
    failed_or_missing_predictions: expected - rows.filter(r => r.status === 'ok').length,
    final_confusion: { tp, tn, fp, fn, unanswered, unlabelled: cases.filter(c => c.label === null).length },
    final_answer_coverage: ratio(tp + tn + fp + fn, positives.length + negatives.length),
    balanced_accuracy_answered_only: tp + fn && tn + fp ? (tp / (tp + fn) + tn / (tn + fp)) / 2 : null,
    macro_f1_answered_only: tp + fn && tn + fp ? (f1(tp, fp, fn) + f1(tn, fn, fp)) / 2 : null,
    fraud_recall_including_failures: ratio(tp, positives.length), legitimate_recall_including_failures: ratio(tn, negatives.length),
    legitimate_calls_with_any_alert: falseAlerts, false_alert_call_rate: ratio(falseAlerts.length, negatives.length),
    premature_alert_calls: premature, missed_actionable_calls: missed, mean_delay_turns_detected_only: mean(delays),
    unlabelled_calls_with_alert: uncertainAlerts,
    brier_answered_final_only: mean(brier), mean_latency_ms: mean(rows.map(r => r.latency_ms).filter(Number.isFinite)),
    limitation: 'Corpus sintético de desarrollo; no estima rendimiento real ni calibra el porcentaje. Latencia de inferencia, no de telefonía. Cortes reales no evaluados.',
  };
}
