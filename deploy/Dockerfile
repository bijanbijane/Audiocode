# Stage 1: Compile Rust/Symphonia/DSP core to WebAssembly
FROM rust:1.82-slim-bookworm AS wasm-builder
WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends curl pkg-config libssl-dev ca-certificates \
    && curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh \
    && rm -rf /var/lib/apt/lists/*

COPY wasm-audio-core ./wasm-audio-core
RUN wasm-pack build wasm-audio-core --target web --out-dir /workspace/wasm-out --release

# Stage 2: Typecheck, Release Quality Gate tests, and Vite production build
FROM node:22-alpine AS web-builder
WORKDIR /workspace

COPY package.json ./
COPY tsconfig.json vite.config.ts index.html metadata.json ./
COPY src ./src
COPY packages ./packages
COPY backend ./backend
COPY docs ./docs
COPY public ./public
COPY server.ts ./
COPY --from=wasm-builder /workspace/wasm-out ./src/wasm-pkg

RUN npm install --no-audit --no-fund
RUN npm run lint && npx tsx --test src/quality-gate/AutomatedQualityGateRunner.test.ts
RUN npm run build

# Stage 3: Hardened non-root Nginx serving static bundle with COOP/COEP/CSP & Byte-Range models
FROM nginxinc/nginx-unprivileged:1.27-alpine AS production
COPY deploy/nginx/security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=web-builder /workspace/dist /usr/share/nginx/html
EXPOSE 8080
USER nginx
CMD ["nginx", "-g", "daemon off;"]
