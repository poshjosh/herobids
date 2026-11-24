# syntax=docker/dockerfile:1
# Build context: monorepo root
#
# Shared multi-service Dockerfile. All 7 shared packages are compiled once in
# `build-shared`; `api` and `worker` extend it — halving peak memory usage and
# build time vs independent per-service Dockerfiles on a low-RAM server.
#
# Production targets : api, worker
# Dev target         : build-shared  (tsx hot-reload; app package not needed)

FROM node:22-alpine AS base
RUN corepack enable

# ── build-shared: install all deps + compile shared packages ──────────────────
FROM base AS build-shared
WORKDIR /app
COPY . .
# GitHub Packages auth for @poshjosh/contracts. The token is read from the
# NPM_TOKEN build secret into a temporary user config that is deleted in the same
# RUN, so it never lands in an image layer. Repo .npmrc stays scope-only.
RUN --mount=type=secret,id=NPM_TOKEN \
    --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    sh -c 'umask 077 && printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/NPM_TOKEN)" > /tmp/npm-auth && NPM_CONFIG_USERCONFIG=/tmp/npm-auth pnpm install --frozen-lockfile; rc=$?; rm -f /tmp/npm-auth; exit $rc'
RUN pnpm --filter @herobids/domain run build && \
    pnpm --filter @herobids/db run build && \
    pnpm --filter @herobids/documents run build && \
    pnpm --filter @herobids/llm run build

# ── build-api: compile api on top of shared ───────────────────────────────────
FROM build-shared AS build-api
RUN pnpm --filter @herobids/api run build

# ── build-worker: compile worker on top of shared ─────────────────────────────
FROM build-shared AS build-worker
RUN pnpm --filter @herobids/worker run build

# ── deploy-api: self-contained production layout ──────────────────────────────
FROM build-api AS deploy-api
RUN --mount=type=secret,id=NPM_TOKEN \
    sh -c 'umask 077 && printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/NPM_TOKEN)" > /tmp/npm-auth && echo "inject-workspace-packages=true" >> .npmrc && NPM_CONFIG_USERCONFIG=/tmp/npm-auth pnpm --filter @herobids/api deploy --prod /deploy/api; rc=$?; rm -f /tmp/npm-auth; exit $rc'

# ── deploy-worker: self-contained production layout ───────────────────────────
FROM build-worker AS deploy-worker
RUN --mount=type=secret,id=NPM_TOKEN \
    sh -c 'umask 077 && printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/NPM_TOKEN)" > /tmp/npm-auth && echo "inject-workspace-packages=true" >> .npmrc && NPM_CONFIG_USERCONFIG=/tmp/npm-auth pnpm --filter @herobids/worker deploy --prod /deploy/worker; rc=$?; rm -f /tmp/npm-auth; exit $rc'

# ── api runtime ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS api
WORKDIR /app/apps/api
ENV HEROBIDS_CONFIG_DIR=/app
COPY --from=build-shared /app/config /app/config
COPY --from=build-shared /app/package.json /app/package.json
COPY --from=deploy-api /deploy/api ./
EXPOSE 3000
CMD ["node", "dist/index.js"]

# ── worker runtime ────────────────────────────────────────────────────────────
FROM node:22-alpine AS worker
WORKDIR /app/apps/worker
ENV HEROBIDS_CONFIG_DIR=/app
COPY --from=build-shared /app/config /app/config
COPY --from=deploy-worker /deploy/worker ./
CMD ["node", "dist/index.js"]
