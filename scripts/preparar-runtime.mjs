// Alternativa para un constructor remoto atascado: imagen oficial de Node + código privado en env cifrado.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
const files = {};
async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const e of entries) {
    const name = `${path}/${e.name}`;
    if (name === 'node_modules/ws/README.md') continue;
    if (e.isDirectory()) await collect(name);
    else if (e.isFile()) files[name] = (await readFile(name)).toString('utf8');
  }
}
for (const path of ['voice.mjs', 'live-voice.mjs', 'phone-bridge.mjs', 'evidence.mjs', 'decisions.mjs', 'understanding.mjs', 'package.json']) files[path] = (await readFile(path)).toString('utf8');
for (const path of ['prompts', 'web', 'node_modules/ws']) await collect(path);
// Mantiene el arranque bajo el límite de env de la VM sin eliminar validaciones.
for (const name of Object.keys(files)) if (/\.m?js$/.test(name)) files[name] = transformSync(files[name], { minify: true, legalComments: 'inline', target: 'es2022' }).code;
const packed = brotliCompressSync(Buffer.from(JSON.stringify(files)));
const hash = createHash('sha256').update(packed).digest('hex');
const bootstrap = `import fs from 'node:fs';import zlib from 'node:zlib';import{pathToFileURL}from'node:url';
const root='/data/voice-runtime-'+process.env.VOICE_RUNTIME_HASH;
const files=JSON.parse(zlib.brotliDecompressSync(Buffer.from(process.env.VOICE_RUNTIME_B64,'base64')));
for(const[name,data]of Object.entries(files)){if(name.startsWith('/')||name.split('/').includes('..'))throw Error('Invalid runtime path');const p=root+'/'+name;fs.mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true});fs.writeFileSync(p,data);}
const{createVoiceServer}=await import(pathToFileURL(root+'/voice.mjs'));const server=await createVoiceServer();const port=Number(process.env.PORT||18789);server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'listening',port,runtime:process.env.VOICE_RUNTIME_HASH})));process.on('SIGTERM',async()=>{await server.closeVoice?.();server.close(()=>process.exit(0));});`;
const env = { NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(bootstrap).toString('base64')}`, VOICE_RUNTIME_B64: packed.toString('base64'), VOICE_RUNTIME_HASH: hash };
if (Buffer.byteLength(JSON.stringify(env)) > 49000) throw new Error('Runtime demasiado grande para el límite de arranque de Maritime; usa el Dockerfile.');
await mkdir('.maritime', { recursive: true });
await writeFile('.maritime/runtime-env.json', JSON.stringify(env), { mode: 0o600 });
await writeFile('.maritime/bootstrap-local.env', Object.entries({ ...env, VOICE_ACCESS_CODE:'local-bootstrap-check-only', PORT:'18789' }).map(([k,v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
console.log(JSON.stringify({ runtime_sha256: hash, compressed_bytes: packed.length, env_bytes: Buffer.byteLength(JSON.stringify(env)) }));
