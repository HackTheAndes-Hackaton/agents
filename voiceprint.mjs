import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';

// Huella vocal del llamante: una pista revisable para reconocer la misma voz en
// llamadas desde otros números. No identifica a una persona ni prueba un delito.
export const VOICEPRINT_MODEL = {
  id: 'wespeaker/voxceleb-resnet34-LM',
  version: 'sherpa-onnx-1.13.8:wespeaker_en_voxceleb_resnet34_LM.onnx:pcm16-active-v1',
  file: 'wespeaker_en_voxceleb_resnet34_LM.onnx',
  sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
  dim: 256,
};

// El cálculo se hace en un hilo aparte: unos 300 ms por huella no deben frenar los eventos de la llamada.
const WORKER = `
// El hilo puede evaluarse como módulo ES: se usan solo módulos internos de Node.
const { parentPort, workerData } = process.getBuiltinModule('node:worker_threads');
const { createRequire } = process.getBuiltinModule('node:module');
const { createHash } = process.getBuiltinModule('node:crypto');
const fs = process.getBuiltinModule('node:fs');
const model = workerData.dir + '/models/' + workerData.file;
if (createHash('sha256').update(fs.readFileSync(model)).digest('hex') !== workerData.sha256) throw Error('model_checksum');
const sherpa = createRequire(workerData.dir + '/')('sherpa-onnx-node');
const extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 1, debug: false });
if (extractor.dim !== workerData.dim) throw Error('model_dim');
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, pcm, rate }) => {
  try {
    const view = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    const samples = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) samples[i] = view[i] / 32768;
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: rate, samples });
    parentPort.postMessage({ id, embedding: Array.from(extractor.compute(stream)) });
  } catch (error) { parentPort.postMessage({ id, error: String(error && error.message || error) }); }
});`;

/**
 * Carga el motor desde /data (instalado aparte). Si falta o falla, devuelve un motor
 * deshabilitado y el resto del servidor sigue igual.
 */
export function createVoiceprintEngine({ dir, model = VOICEPRINT_MODEL, WorkerClass = Worker, timeoutMs = 8000 } = {}) {
  if (!dir || !existsSync(`${dir}/models/${model.file}`) || !existsSync(`${dir}/node_modules/sherpa-onnx-node`)) {
    return { ready: Promise.resolve(false), embed: async () => { throw Error('voiceprint_unavailable'); }, close() {}, model };
  }
  const pending = new Map();
  let next = 0, alive = true;
  // Maritime usa NODE_OPTIONS para arrancar el servidor. El hilo del modelo no
  // debe heredar ese arranque ni volver a abrir el puerto HTTP.
  const worker = new WorkerClass(WORKER, { eval: true, execArgv: [], env: { ...process.env, NODE_OPTIONS: '' },
    workerData: { dir, file: model.file, sha256: model.sha256, dim: model.dim } });
  worker.unref?.();
  const fail = () => { alive = false; for (const { reject } of pending.values()) reject(Error('voiceprint_unavailable')); pending.clear(); };
  const ready = new Promise(resolve => {
    worker.once('message', m => resolve(m?.ready === true));
    worker.once('error', () => { fail(); resolve(false); });
    worker.once('exit', () => { fail(); resolve(false); });
  });
  worker.on('message', m => {
    const job = pending.get(m?.id); if (!job) return;
    pending.delete(m.id); clearTimeout(job.timer);
    if (Array.isArray(m.embedding) && m.embedding.length === model.dim && m.embedding.every(Number.isFinite)) job.resolve(m.embedding);
    else job.reject(Error('voiceprint_failed'));
  });
  return {
    ready, model,
    async embed(pcm, rate) {
      if (!alive || !(await ready)) throw Error('voiceprint_unavailable');
      const id = ++next, copy = Buffer.from(pcm);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('voiceprint_timeout')); }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, pcm: copy, rate });
        copy.fill(0);
      });
    },
    close() { alive = false; fail(); void worker.terminate?.(); },
  };
}

/**
 * Junta solo los tramos de 20 ms con voz del canal del llamante (sin silencios),
 * con tope. Se borra al terminar: la huella se guarda únicamente si la llamada
 * ya es una estafa confirmada.
 */
export class VoiceCollector {
  frames = []; rate = null; tail = Buffer.alloc(0);
  constructor({ maxSeconds = 30, thresholdDb = -45 } = {}) { this.maxSeconds = maxSeconds; this.threshold = 10 ** (thresholdDb / 20); }
  get activeSeconds() { return this.rate ? this.frames.length * 0.02 : 0; }
  push(pcm, rate) {
    if (![8000, 16000, 24000, 48000].includes(rate) || pcm.length % 2) return;
    if (this.rate !== rate) { this.clear(); this.rate = rate; }
    const frameBytes = rate * 2 * 0.02;
    const input = Buffer.concat([this.tail, pcm]);
    let offset = 0;
    for (; offset + frameBytes <= input.length; offset += frameBytes) {
      if (this.activeSeconds >= this.maxSeconds) break;
      let sum = 0;
      for (let i = offset; i < offset + frameBytes; i += 2) { const s = input.readInt16LE(i) / 32768; sum += s * s; }
      if (Math.sqrt(sum / (frameBytes / 2)) > this.threshold) this.frames.push(Buffer.from(input.subarray(offset, offset + frameBytes)));
    }
    this.tail.fill(0);
    this.tail = Buffer.from(input.subarray(offset));
    input.fill(0);
  }
  /** Copia del audio con voz; el que llama a esta función debe borrarla después de usarla. */
  snapshot() { return this.rate && this.frames.length ? { pcm: Buffer.concat(this.frames), rate: this.rate, activeSeconds: this.activeSeconds } : null; }
  clear() { for (const f of this.frames) f.fill(0); this.tail.fill(0); this.frames = []; this.tail = Buffer.alloc(0); this.rate = null; }
}

/** Cliente del panel: buscar voces parecidas y guardar la huella de una estafa confirmada. */
export function voiceprintApiClient(config = {}) {
  const base = (config.url ?? process.env.TISKZ_API_URL ?? '').replace(/\/$/, '');
  const key = config.key ?? process.env.TISKZ_API_KEY;
  const org = config.org ?? process.env.TISKZ_ORG_ID;
  const request = config.fetch ?? fetch;
  const call = async (path, body) => {
    if (!base || !key || !org) throw Error('voiceprint_api_not_configured');
    if (new URL(base).protocol !== 'https:' && !config.fetch) throw Error('voiceprint_api_requires_https');
    const response = await request(`${base}/voice-matches/${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'X-API-Key': key, 'X-Tiskz-Org': org, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Error(`voiceprint_api_${response.status}`);
    const result = await response.json();
    if (!result || typeof result.data !== 'object' || result.data === null) throw Error('voiceprint_api_invalid');
    return result.data;
  };
  return { configured: Boolean(base && key && org), search: body => call('search', body), enroll: body => call('enroll', body) };
}

const number = (value, fallback, min, max) => { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; };

/** Configuración desde el entorno. Apagado salvo VOICEPRINT_ENABLED=true. */
export function voiceprintConfig(env = process.env) {
  return {
    enabled: env.VOICEPRINT_ENABLED === 'true',
    dir: env.VOICEPRINT_DIR || '/data/voiceprint',
    searchSeconds: number(env.VOICEPRINT_SEARCH_SECONDS, 6, 3, 15),
    notifySimilarity: number(env.VOICEPRINT_NOTIFY_SIMILARITY, 0.7, 0.5, 0.99),
    strongSimilarity: number(env.VOICEPRINT_STRONG_SIMILARITY, 0.8, 0.5, 0.99),
    confirmProbability: number(env.VOICEPRINT_CONFIRM_PROBABILITY, 0.9, 0.5, 1),
    collectSeconds: number(env.VOICEPRINT_COLLECT_SECONDS, 20, 6, 30),
    collectMaxMs: number(env.VOICEPRINT_COLLECT_MAX_MS, 60000, 10000, 120000),
    minEnrollSeconds: number(env.VOICEPRINT_MIN_ENROLL_SECONDS, 6, 3, 15),
    simulated: env.VOICEPRINT_SIMULATED === 'true',
  };
}

/** Instrucción interna para el agente cuando la estafa ya está confirmada. */
export const COLLECT_INSTRUCTION = 'Instrucción interna del sistema, no la menciones: el análisis activó una alerta y el usuario autorizó recopilar una muestra pendiente de revisión. Esto no confirma una estafa ni una identidad. ' +
  'Desde ahora tu objetivo es que la otra persona siga hablando con calma el mayor tiempo posible. Muestra interés y algo de duda; ' +
  'pide que te explique otra vez, más despacio, qué hay que hacer, a qué cuenta o número, a nombre de quién y desde dónde llama. ' +
  'Haz una pregunta abierta por turno. No aceptes pagos, no des datos, códigos ni claves, y no digas que la vas a denunciar. ' +
  'No termines la llamada ni digas «Voy a terminar la llamada»: el sistema la terminará cuando corresponda.';

export function cosine(a, b) {
  let dot = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}
