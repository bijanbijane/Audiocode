# backend/Dockerfile
FROM node:22-bookworm-slim AS builder
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json ./
COPY src ./src
COPY backend ./backend

RUN npm install
RUN npm run build

FROM node:22-bookworm-slim AS production
WORKDIR /app

# Install base Linux runtime dependencies for onnxruntime-node and ffmpeg for streaming worker
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/dist ./dist
COPY --from=builder /workspace/backend/db ./db
COPY --from=builder /workspace/node_modules ./node_modules

RUN useradd -r -u 1001 -m paudio && mkdir -p /var/lib/paudio/models && chown -R paudio:paudio /var/lib/paudio
USER paudio

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
