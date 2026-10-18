import { readFile } from 'node:fs/promises';

const question = JSON.parse(await readFile(new URL('./prompts/deteccion.json', import.meta.url), 'utf8'));
question.instructions += '\n\n' + await readFile(new URL('./prompts/es-PE.md', import.meta.url), 'utf8');

export function parseThreshold(value = 0.5) {
  const result = Number(value);
  if (value === '' || !Number.isFinite(result) || result < 0 || result > 1) {
    throw new Error('ALERT_THRESHOLD debe estar entre 0 y 1');
  }
  return result;
}

export async function detectAlert(incident, options) {
  const { baseUrl, apiKey, model = 'gpt-6-luna', timeoutMs = 24000 } = options;
  const threshold = parseThreshold(options.threshold);
  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: incident.transcripcion, questions: [question] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok) {
    const error = new Error(`Decisions devolvió HTTP ${upstream.status}`);
    error.statusCode = 502;
    throw error;
  }
  const result = await upstream.json();
  const answer = Array.isArray(result.answers) ? result.answers.find(item => item?.name === 'alerta') : undefined;
  if (answer?.type === 'refusal') {
    const error = new Error('El modelo no pudo evaluar este incidente');
    error.statusCode = 422;
    throw error;
  }
  const probability = answer?.probability;
  if (answer?.type !== 'predicate' || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    const error = new Error('Probabilidad de Decisions inválida');
    error.statusCode = 502;
    throw error;
  }
  return { alerta: probability >= threshold, probabilidad: probability, modelo: result.model ?? model };
}
