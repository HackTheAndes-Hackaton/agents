import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

if (!process.argv[2]) throw new Error('Uso: node scripts/analizar.mjs examples/riesgo.json');
const incident = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (incident.consentimiento_analisis !== true) throw new Error('Se requiere autorización explícita para analizar');
function chat(name, input) {
  const metadata = JSON.parse(execFileSync('maritime', ['status', name, '--json'], { encoding: 'utf8', timeout: 90000 }));
  const id = metadata.id ?? metadata.data?.id;
  if (!id) throw new Error(`No se pudo resolver el agente ${name}`);
  // El alias posicional chat de CLI 2.0.1 altera mensajes JSON; usa la opción tipada.
  const raw = execFileSync('maritime', ['agents', 'chat', id, '--message', JSON.stringify(input), '--json'], { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  const reply = JSON.parse(raw);
  const text = reply.response ?? reply.data?.response;
  if (typeof text !== 'string') throw new Error('El chat no devolvió texto');
  return JSON.parse(text);
}
const comprehensionName = process.env.AGENTE_COMPRENSION ?? 'andes-comprension';
const detectionName = process.env.AGENTE_DETECCION ?? 'andes-deteccion';
function sleepIfActive(name) {
  const result = JSON.parse(execFileSync('maritime', ['status', name, '--json'], { encoding: 'utf8', timeout: 90000 }));
  const status = result.status ?? result.data?.status;
  if (['active', 'running'].includes(status)) execFileSync('maritime', ['sleep', name, '--json'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 90000 });
}
sleepIfActive(detectionName);
const comprension = chat(comprehensionName, incident);
// El plan gratuito permite una máquina despierta a la vez.
execFileSync('maritime', ['sleep', comprehensionName, '--json'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 90000 });
const deteccion = chat(detectionName, { ...incident, comprension });
sleepIfActive(detectionName);
console.log(JSON.stringify({ comprension, deteccion }, null, 2));
