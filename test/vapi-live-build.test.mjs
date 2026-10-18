import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const run = promisify(execFile);
const script = new URL('../scripts/preparar-vapi-live.mjs', import.meta.url).pathname;
const env = { ...process.env, TISKZ_LIVE_MCP_URL: 'https://example.invalid/v1/phone/live/mcp', VAPI_LIVE_MCP_SECRET: 'test-fake-mcp-secret-not-real-12345', VAPI_WEBHOOK_SECRET: 'test-fake-webhook-secret-not-real-12345' };

test('el generador protege el archivo con claves y evita publicar o sobrescribir un candidato', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tiskz-live-build-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'candidate.json');
  const result = await run(process.execPath, [script, file], { env });
  assert.equal(result.stdout.includes(env.VAPI_LIVE_MCP_SECRET), false);
  assert.equal(JSON.parse(result.stdout).published, false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const raw = await readFile(file, 'utf8');
  const candidate = JSON.parse(raw);
  assert.equal(candidate.model.tools[0].server.headers['X-Tiskz-Live-Secret'], env.VAPI_LIVE_MCP_SECRET);
  assert.equal(candidate.server.headers['X-Vapi-Secret'], env.VAPI_WEBHOOK_SECRET);
  await assert.rejects(run(process.execPath, [script, file], { env }));
  assert.equal(await readFile(file, 'utf8'), raw);
});

test('rechaza una URL que expondría las credenciales por HTTP o parámetros', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tiskz-live-url-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const url of ['http://example.invalid/v1/phone/live/mcp', 'https://user:pass@example.invalid/v1/phone/live/mcp', 'https://example.invalid/v1/phone/live/mcp?secret=bad']) {
    const file = join(dir, 'candidate.json');
    await assert.rejects(run(process.execPath, [script, file], { env: { ...env, TISKZ_LIVE_MCP_URL: url } }));
    await assert.rejects(stat(file), { code: 'ENOENT' });
  }
});
