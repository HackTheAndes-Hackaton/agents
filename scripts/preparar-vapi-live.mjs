import { readFile, writeFile } from 'node:fs/promises';

// Genera un archivo privado; no publica cambios ni imprime claves en stdout.
const destination = process.argv[2];
if (!destination) throw Error('Uso: node scripts/preparar-vapi-live.mjs /ruta/privada/candidato.json');
const secret = process.env.VAPI_LIVE_MCP_SECRET;
const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;
if (!secret || secret.length < 24 || !webhookSecret || webhookSecret.length < 24) throw Error('Configura VAPI_LIVE_MCP_SECRET y VAPI_WEBHOOK_SECRET con al menos 24 caracteres');
const url = new URL(process.env.TISKZ_LIVE_MCP_URL);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1/phone/live/mcp')) throw Error('TISKZ_LIVE_MCP_URL requiere HTTPS y la ruta /v1/phone/live/mcp sin credenciales ni parámetros');
const template = JSON.parse(await readFile(new URL('../config/vapi-live-assistant.template.json', import.meta.url), 'utf8'));
template.model.tools[0].server = { url: url.href, headers: { 'X-Tiskz-Live-Secret': secret } };
const webhook = new URL(url); webhook.pathname = url.pathname.slice(0, -'/v1/phone/live/mcp'.length) + '/v1/phone/vapi';
template.server = { url: webhook.href, headers: { 'X-Vapi-Secret': webhookSecret } };
await writeFile(destination, JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ generated: true, model: template.model.model, voice: template.voice.voiceId, published: false }));
