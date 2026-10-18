import { createHash, timingSafeEqual } from 'node:crypto';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = ['nombre', 'entidad', 'motivo', 'peticion'];
const empty = { type: 'object', properties: {}, additionalProperties: false };
export const livePhoneTools = [
  { name: 'evaluar_conversacion', description: 'Evalúa el texto del interlocutor y devuelve orientación vigente. Copia literalmente sus palabras y negaciones; no incluyas voz del agente ni un resumen. Usa consultar_estado para conocer revision_previa. Reutiliza request_id solo al reintentar exactamente la misma petición. La ficha contiene citas literales o cadenas vacías, nunca identidad verificada.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['request_id', 'revision_previa', 'transcripcion_interlocutor', 'ficha'], properties: {
      request_id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_-]+$' },
      revision_previa: { type: 'integer', minimum: 0 },
      transcripcion_interlocutor: { type: 'string', minLength: 1, maxLength: 12000 },
      ficha: { type: 'object', additionalProperties: false, required: fields,
        properties: Object.fromEntries(fields.map(key => [key, { type: 'string', maxLength: 300 }])) },
    },
  } },
  { name: 'consultar_estado', description: 'Lee el estado actual y la revisión de esta llamada sin repetir la inferencia. Un estado pendiente o inconcluso no significa seguridad. Las acciones pendientes no están confirmadas.', inputSchema: empty },
  { name: 'solicitar_corte', description: 'Solicita un corte preventivo únicamente si el detector de esta revisión pidió alerta y la APK autorizó el corte automático. Un resultado requested no confirma desconexión. No sustituye una despedida voluntaria del interlocutor.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['revision'], properties: { revision: { type: 'integer', minimum: 1 } },
  } },
  { name: 'finalizar_por_peticion', description: 'Solicita el cierre cuando el interlocutor se despide o pide explícitamente terminar. Requiere la cita literal completa de la última intervención de la revisión vigente. No sirve para «no me cortes» ni para una decisión de riesgo.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['revision', 'cita'], properties: { revision: { type: 'integer', minimum: 1 }, cita: { type: 'string', minLength: 1, maxLength: 300 } },
  } },
];

function validate(name, args) {
  if (!object(args)) return false;
  const keys = Object.keys(args);
  if (name === 'consultar_estado') return keys.length === 0;
  if (name === 'solicitar_corte') return keys.length === 1 && Number.isSafeInteger(args.revision) && args.revision > 0;
  if (name === 'finalizar_por_peticion') return keys.length === 2 && Number.isSafeInteger(args.revision) && args.revision > 0 && typeof args.cita === 'string' && args.cita.length > 0 && args.cita.length <= 300;
  if (name !== 'evaluar_conversacion' || keys.length !== 4 || !['request_id', 'revision_previa', 'transcripcion_interlocutor', 'ficha'].every(k => Object.hasOwn(args, k))) return false;
  return typeof args.request_id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(args.request_id) &&
    Number.isSafeInteger(args.revision_previa) && args.revision_previa >= 0 &&
    typeof args.transcripcion_interlocutor === 'string' && args.transcripcion_interlocutor.trim().length > 0 && args.transcripcion_interlocutor.length <= 12000 &&
    object(args.ficha) && Object.keys(args.ficha).length === 4 && fields.every(k => Object.hasOwn(args.ficha, k) && typeof args.ficha[k] === 'string' && args.ficha[k].length <= 300 && (!args.ficha[k] || args.transcripcion_interlocutor.includes(args.ficha[k])));
}

// MCP stateless; la llamada y sus consentimientos viven en PhoneBridge, no en el modelo.
export function createLivePhoneMcp(config) {
  const requests = new Map(), verified = new Map();
  const enabled = config.enabled === true && config.secret?.length >= 24;
  async function verify(id) {
    if (!uuid.test(id ?? '') || (config.canUse && !config.canUse(id))) throw Error('call_unavailable');
    const lookup = config.lookupCall ?? (async callId => {
      if (!config.apiKey) throw Error('lookup_unavailable');
      const r = await (config.fetch ?? fetch)(`https://api.vapi.ai/call/${callId}`, {
        headers: { Authorization: `Bearer ${config.apiKey}`, 'User-Agent': 'vapi-cli/0.2.1' },
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw Error('lookup_failed');
      return r.json();
    });
    let entry = verified.get(id);
    if (!entry || entry.expires <= Date.now()) {
      for (const [key, value] of verified) if (value.expires <= Date.now()) verified.delete(key);
      if (!verified.has(id) && verified.size >= 8) throw Error('lookup_limit');
      entry = { expires: Date.now() + 5000, promise: Promise.resolve().then(() => lookup(id)) };
      verified.set(id, entry);
    }
    let call;
    try { call = await entry.promise; } catch (error) { if (verified.get(id) === entry) verified.delete(id); throw error; }
    if (call?.id !== id || call.assistantId !== config.assistantId || !['queued', 'ringing', 'in-progress'].includes(call.status)) { verified.delete(id); throw Error('call_unavailable'); }
    // También exige un monitor autorizado y comprueba que no haya otra llamada activa.
    if (!config.authorize(id)) { verified.delete(id); throw Error('call_unavailable'); }
  }
  return {
    clearCall(id) { requests.delete(id); verified.delete(id); },
    close() { requests.clear(); verified.clear(); },
    async http(req, res, pathname) {
      if (pathname !== '/v1/phone/live/mcp') return false;
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      if (!enabled) { send(404, { error: 'Ruta no habilitada' }); return true; }
      if (!equal(req.headers['x-tiskz-live-secret'], config.secret)) { send(401, { error: 'No autorizado' }); return true; }
      if (req.method !== 'POST') { send(405, { error: 'POST requerido' }); return true; }
      let rpc;
      try {
        let size = 0; const chunks = [];
        for await (const part of req) { size += part.length; if (size > 65536) throw Error(); chunks.push(part); }
        rpc = JSON.parse(Buffer.concat(chunks).toString());
      } catch { send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido o demasiado grande' } }); return true; }
      if (!object(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.id !== undefined && !(typeof rpc.id === 'string' && rpc.id.length <= 100) && !(Number.isSafeInteger(rpc.id)))) {
        send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Petición inválida' } }); return true;
      }
      const ok = result => send(200, { jsonrpc: '2.0', id: rpc.id, result });
      const fail = (code, message) => send(200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });
      if (rpc.id === undefined) { send(202); return true; }
      if (rpc.method === 'initialize') {
        const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
        ok({ protocolVersion: versions.includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tiskz-live', version: '1.0.0' } }); return true;
      }
      if (rpc.method === 'ping') { ok({}); return true; }
      if (rpc.method === 'tools/list') { ok({ tools: livePhoneTools }); return true; }
      if (rpc.method !== 'tools/call') { fail(-32601, 'Método no disponible'); return true; }
      const { name, arguments: args = {} } = rpc.params ?? {};
      if (!livePhoneTools.some(tool => tool.name === name) || !validate(name, args)) { fail(-32602, 'Herramienta o argumentos inválidos; la ficha requiere citas literales'); return true; }
      const id = req.headers['x-call-id'];
      try {
        await verify(id);
        let result;
        if (name === 'evaluar_conversacion') {
          let cache = requests.get(id);
          if (!cache) { cache = new Map(); requests.set(id, cache); }
          const signature = createHash('sha256').update(JSON.stringify([args.revision_previa, args.transcripcion_interlocutor, ...fields.map(k => args.ficha[k])])).digest('hex');
          const previous = cache.get(args.request_id);
          if (previous && previous.signature !== signature) throw Error('request_reused');
          if (!previous && cache.size >= 200) throw Error('request_limit');
          if (!previous) cache.set(args.request_id, { signature, promise: Promise.resolve().then(() => config.evaluate(id, args)) });
          result = await cache.get(args.request_id).promise;
          if (config.state(id)?.revision !== result.revision) result = { status: 'superseded', revision: config.state(id)?.revision, identity_verified: false };
        } else if (name === 'consultar_estado') result = config.state(id);
        else result = await config.hangup(id, args.revision, name === 'finalizar_por_peticion' ? args.cita : null);
        ok({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: result?.status === 'rejected' });
      } catch {
        ok({ content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable', message: 'No se pudo confirmar la llamada o completar esta operación. No afirmes que se ejecutó; consulta el estado actual.', identity_verified: false }) }], isError: true });
      }
      return true;
    },
  };
}
