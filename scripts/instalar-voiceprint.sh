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
  curl -fsSL -o "models/$MODEL.tmp" "$URL"
  echo "$SHA  models/$MODEL.tmp" | sha256sum -c -
  mv "models/$MODEL.tmp" "models/$MODEL"
fi
sync
echo "{\"installed\":true,\"dir\":\"$DIR\",\"model_sha256\":\"$SHA\"}"
