// Repite solo la política determinista; conserva el resultado original de los modelos.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assessCall } from '../call-policy.mjs';
import { summarize } from '../eval/evaluate.mjs';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw Error('Uso: node scripts/reevaluar-politica.mjs resultado.json nuevo-resultado.json');
const raw = await readFile(new URL('../eval/casos-es-PE-v1.json', import.meta.url));
const corpus = JSON.parse(raw), report = JSON.parse(await readFile(source));
if (report.corpus_sha256 !== createHash('sha256').update(raw).digest('hex')) throw Error('El resultado no corresponde a este corpus');
summarize(corpus.cases, report.rows); // Verifica IDs, duplicados y tipos antes de repetir.
const changes = [];
const rows = report.rows.map(row => {
  if (row.status !== 'ok') return row;
  const sample = corpus.cases.find(c => c.id === row.id);
  const assessment = assessCall({ transcript: sample.turns.slice(0, row.turn).join('\n'),
    decision: { alerta: row.alerta, probabilidad: row.probability },
    understanding: row.assessment?.explicacion_disponible ? { rol: 'comprension', evidencias: row.assessment.evidencia_textual } : null });
  if (assessment.estado !== row.assessment?.estado) changes.push({ id: row.id, turn: row.turn, before: row.assessment?.estado, after: assessment.estado });
  return { ...row, assessment };
});
const result = { at: new Date().toISOString(), source, source_sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
  policy_sha256: createHash('sha256').update(await readFile(new URL('../call-policy.mjs', import.meta.url))).digest('hex'),
  method: 'Reejecución local con las mismas decisiones y citas sintéticas; sin inferencias nuevas. La latencia corresponde a la ejecución original.',
  changes, summary: summarize(corpus.cases, rows) };
await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(changes));
