import { readFile } from 'node:fs/promises';
const instructions = await readFile(new URL('./prompts/comprension.md', import.meta.url), 'utf8');

export async function understandIncident(incident, options) {
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({ model: options.model ?? 'gpt-4.1-mini', messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(incident) }], max_tokens: 1200, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  if (!response.ok) throw new Error(`Comprensión: HTTP ${response.status}`);
  const body = await response.json();
  const analysis = JSON.parse(body.choices?.[0]?.message?.content ?? 'null');
  if (analysis?.rol !== 'comprension' || !Array.isArray(analysis.evidencias) || !Array.isArray(analysis.limitaciones)) throw new Error('Comprensión inválida');
  if (analysis.evidencias.some(e => typeof e.cita !== 'string' || !e.cita || !incident.transcripcion.includes(e.cita))) throw new Error('Evidencia sin respaldo');
  return analysis;
}
