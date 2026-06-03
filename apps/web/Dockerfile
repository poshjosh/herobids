# syntax=docker/dockerfile:1
# Build context: monorepo root

FROM node:22-alpine AS base
RUN corepack enable

# ── build: install deps and compile Vite app ─────────────────────────────────
FROM base AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# VITE_API_BASE_URL defaults to /api which nginx proxies to the api service.
# Pass VITE_API_ORIGIN so the OAuth URL points at the host-accessible API port.
ARG VITE_API_ORIGIN=http://localhost:3000
ENV VITE_API_ORIGIN=$VITE_API_ORIGIN
RUN pnpm --filter @herobids/web run build

# ── runtime: nginx serves the built static assets ────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
