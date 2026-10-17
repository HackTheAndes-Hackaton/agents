import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';


export async function createAgentServer(config = {}) {
  const dataDir = config.dataDir ?? process.env.DATA_DIR ?? '/data';
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = config.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const model = config.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
  const role = config.role ?? process.env.AGENT_ROLE ?? 'comprension';
  if (!['comprension', 'deteccion'].includes(role)) throw new Error('AGENT_ROLE debe ser comprension o deteccion');
  const instructions = config.instructions ?? await readFile(new URL(`./prompts/${role}.md`, import.meta.url), 'utf8');
  const persistHistory = config.persistHistory ?? process.env.PERSIST_HISTORY === 'true';
  const timeoutMs = config.timeoutMs ?? 24000;
  const busy = new Set();

  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, rol: role, modelo_configurado: Boolean(apiKey), historial_persistente: persistHistory });
    }
    if (req.method !== 'POST' || req.url !== '/chat') return send(404, { error: 'Ruta no encontrada' });
    let conversationKey;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) return send(413, { error: 'La solicitud es demasiado grande' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return send(400, { error: 'Se esperaba un objeto JSON' }); }
      if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 16000) {
        return send(400, { error: 'message debe contener de 1 a 16000 caracteres' });
      }
      let incident;
      try { incident = JSON.parse(body.message); } catch { /* El saludo no contiene un incidente. */ }
      if (!incident || incident.consentimiento_analisis !== true || typeof incident.transcripcion !== 'string' || !incident.transcripcion.trim()) {
        return send(200, { response: JSON.stringify({ rol: role, estado: 'requiere_entrada', mensaje: 'Envíame un JSON con consentimiento_analisis: true y transcripcion. Solo analizo conversaciones autorizadas; compartir requiere otro permiso.' }) });
      }
      const conversationId = body.conversationId ?? body.conversation_id ?? 'default';
      if (typeof conversationId !== 'string' || conversationId.length > 256 || !conversationId) {
        return send(400, { error: 'conversationId debe contener de 1 a 256 caracteres' });
      }
      if (!apiKey) return send(503, { error: 'Falta configurar el modelo. Habilita Maritime LLM o configura OPENAI_API_KEY.' });
      const key = createHash('sha256').update(conversationId).digest('hex');
      if (busy.has(key)) return send(409, { error: 'Esta conversación está procesando otro mensaje. Reintenta en unos segundos.' });
      conversationKey = key;
      busy.add(key);
      if (persistHistory) await mkdir(dataDir, { recursive: true });
      const historyPath = join(dataDir, `${key}.json`);
      let history = [];
      try { if (persistHistory) history = JSON.parse(await readFile(historyPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const messages = [
        { role: 'system', content: instructions },
        ...history.slice(-20),
        { role: 'user', content: body.message.trim() },
      ];
      const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: 1800, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!upstream.ok) {
        console.error(JSON.stringify({ event: 'model_error', status: upstream.status }));
        return send(502, { error: `El proveedor devolvió HTTP ${upstream.status}. Revisa el modelo, la clave y los créditos de IA.` });
      }
      const result = await upstream.json();
      const reply = result.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('El modelo no devolvió texto');
      const analysis = JSON.parse(reply);
      if (analysis.rol !== role || !Array.isArray(analysis.evidencias) || !Array.isArray(analysis.limitaciones)) throw new Error('Respuesta estructurada inválida');
      for (const evidence of analysis.evidencias) {
        if (typeof evidence.cita !== 'string' || !evidence.cita.trim() || !incident.transcripcion.includes(evidence.cita)) throw new Error('Cita sin respaldo');
      }
      if (role === 'deteccion' && !['bajo', 'medio', 'alto', 'informacion_insuficiente'].includes(analysis.riesgo_estimado)) throw new Error('Riesgo inválido');
      const nextHistory = [...history, { role: 'user', content: body.message.trim() }, { role: 'assistant', content: reply }].slice(-20);
      if (persistHistory) {
        await writeFile(`${historyPath}.tmp`, JSON.stringify(nextHistory), { mode: 0o600 });
        await rename(`${historyPath}.tmp`, historyPath);
      }
      console.log(JSON.stringify({ event: 'chat_completed', model }));
      send(200, { response: reply, conversationId });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      console.error(JSON.stringify({ event: 'chat_failed', type: error.name }));
      if (!res.headersSent) send(timedOut ? 504 : 500, { error: timedOut ? 'Se agotó el tiempo de respuesta. Prueba una solicitud más breve.' : 'El agente no pudo completar el análisis. Revisa los registros.' });
    } finally {
      if (conversationKey) busy.delete(conversationKey);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createAgentServer();
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', host: '0.0.0.0', port })));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
