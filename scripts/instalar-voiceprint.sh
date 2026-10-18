#!/bin/sh
# Instala el motor de huellas vocales en el disco persistente de la VM (/data).
# No reinicia el servidor ni cambia variables: el servidor solo lo usa con VOICEPRINT_ENABLED=true.
# Ejecutar dentro de la VM con: env NODE_OPTIONS= sh instalar-voiceprint.sh
set -eu
DIR="${VOICEPRINT_DIR:-/data/voiceprint}"
MODEL=wespeaker_en_voxceleb_resnet34_LM.onnx
SHA=e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/$MODEL"
mkdir -p "$DIR/models"
cd "$DIR"
[ -f package.json ] || echo '{"private":true}' > package.json
npm install --no-audit --no-fund --omit=dev sherpa-onnx-node@1.13.8
if ! echo "$SHA  models/$MODEL" | sha256sum -c - >/dev/null 2>&1; then
  # Node incluye certificados raíz; conserva la validación TLS aun si curl no
  # encuentra el almacén de certificados del contenedor mínimo.
  NODE_OPTIONS= node --input-type=module - "$URL" "models/$MODEL.tmp" <<'NODE'
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const [, , url, destination] = process.argv;
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok || !response.body) throw new Error(`model_download_${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
NODE
  echo "$SHA  models/$MODEL.tmp" | sha256sum -c -
  mv "models/$MODEL.tmp" "models/$MODEL"
fi
sync
echo "{\"installed\":true,\"dir\":\"$DIR\",\"model_sha256\":\"$SHA\"}"
