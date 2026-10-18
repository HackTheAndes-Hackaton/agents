import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { detectAlert } from '../decisions.mjs';
import { understandIncident } from '../understanding.mjs';
import { assessCall } from '../call-policy.mjs';
import { evaluate, summarize } from '../eval/evaluate.mjs';

const destination = process.argv[2];
if (!destination) throw Error('Indica un archivo nuevo de salida: node scripts/evaluar-fraude.mjs eval/results/mi-prueba.json [eval/contraejemplos-es-PE-v1.json]');
// Corpus opcional; por defecto, las parejas originales.
const corpusPath = process.argv[3] ?? new URL('../eval/casos-es-PE-v1.json', import.meta.url);
try { await access(destination); throw Error('El archivo de salida ya existe. Elige otro para preservar la evaluación.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) throw Error('Configura OPENAI_API_KEY y OPENAI_BASE_URL; esta evaluación consume créditos.');
const raw = await readFile(corpusPath);
const corpus = JSON.parse(raw);
const options = { apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, threshold: 0.5, timeoutMs: 20000 };
const rows = await evaluate(corpus.cases, async transcript => {
  const incident = { consentimiento_analisis: true, transcripcion: transcript };
  const [d, u] = await Promise.allSettled([detectAlert(incident, options), understandIncident(incident, { ...options, selectSegments: true })]);
  if (d.status === 'rejected') throw Error('detection_failed');
  return { decision: d.value, assessment: assessCall({ transcript, decision: d.value, understanding: u.status === 'fulfilled' ? u.value : null }) };
});
const report = { at: new Date().toISOString(), corpus: corpus.version, corpus_sha256: createHash('sha256').update(raw).digest('hex'), threshold: 0.5, rows, summary: summarize(corpus.cases, rows) };
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report.summary, null, 2));
