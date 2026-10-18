FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs decisions.mjs understanding.mjs voice.mjs live-voice.mjs live-phone-mcp.mjs phone-bridge.mjs phone-evidence.mjs scribe-sidecar.mjs call-policy.mjs evidence.mjs ./
COPY prompts ./prompts
COPY web ./web
ENV NODE_ENV=production DATA_DIR=/data
CMD ["node", "/app/server.mjs"]
