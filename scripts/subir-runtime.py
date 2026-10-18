"""Sube el paquete preparado a /data y confirma su escritura durable antes de reiniciar.

Uso: python3 scripts/subir-runtime.py AGENT_ID
Consultar maritime guide --json antes de operar la plataforma.
No modifica las variables de entorno ni reinicia el servidor.
"""
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys

agent = sys.argv[1]
env = json.loads(Path('.maritime/runtime-env.json').read_text())
bundle = Path('.maritime/runtime-bundle.br').read_bytes()
digest = hashlib.sha256(bundle).hexdigest()
if digest != env['VOICE_RUNTIME_HASH']:
    raise SystemExit('El hash local no coincide.')
path = f'/data/voice-runtime-bundles/{digest}.br'
if env.get('VOICE_RUNTIME_BUNDLE_FILE') != path:
    raise SystemExit('Prepara primero un runtime con almacenamiento en archivo.')
script = '''const fs=require('fs'),crypto=require('crypto');
const bytes=Buffer.from(BUNDLE,'base64'),hash=HASH,path=DEST;
if(crypto.createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('local_hash');
const dir=path.slice(0,path.lastIndexOf('/'));fs.mkdirSync(dir,{recursive:true});
const tmp=path+'.upload',fd=fs.openSync(tmp,'w');
try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
fs.renameSync(tmp,path);
const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory)}finally{fs.closeSync(directory)}
require('child_process').execFileSync('sync');
if(crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')!==hash)throw Error('persisted_hash');
console.log(JSON.stringify({uploaded:true,bytes:bytes.length,sha256:hash}));'''
script = script.replace('HASH', json.dumps(digest)).replace('DEST', json.dumps(path)).replace('BUNDLE', json.dumps(base64.b64encode(bundle).decode()))
result = subprocess.run(['maritime', 'exec', agent, '--body-json', json.dumps({'command': 'env NODE_OPTIONS= node -e ' + shlex.quote(script)}), '--json'], capture_output=True, text=True)
if result.returncode:
    raise SystemExit(result.stderr)
response = json.loads(result.stdout).get('results', {})
if response.get('exitCode') != 0:
    raise SystemExit('La VM no confirmó la subida durable; no cambies el runtime ni reinicies.')
print(response['stdout'].strip())
