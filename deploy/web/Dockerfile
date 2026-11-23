# Build the browser application independently from the API/runtime container.
FROM oven/bun:1 AS web-build
WORKDIR /workspace

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY index.html vite.config.ts tsconfig.json metadata.json ./
COPY src ./src
COPY packages ./packages
COPY public ./public

RUN bun run build

# The web tier serves only static assets. API paths are reverse-proxied by nginx.conf.
FROM nginx:alpine AS web-runtime
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /workspace/dist /usr/share/nginx/html

EXPOSE 8080
