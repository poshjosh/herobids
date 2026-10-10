# syntax=docker/dockerfile:1
# Build context: monorepo root

FROM node:22-alpine AS base
RUN corepack enable

# ── build: install all deps and compile TypeScript ───────────────────────────
FROM base AS build
WORKDIR /app
COPY . .
# GitHub Packages auth for @poshjosh/contracts (scope-only .npmrc; token from
# the NPM_TOKEN build secret, never baked into the image).
RUN --mount=type=secret,id=NPM_TOKEN \
    --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    sh -c 'printf "//npm.pkg.github.com/:_authToken=%s\n" "$(cat /run/secrets/NPM_TOKEN)" >> .npmrc && pnpm install --frozen-lockfile'
RUN pnpm --filter @herobids/domain run build && \
    pnpm --filter @herobids/db run build && \
    pnpm --filter @herobids/llm run build && \
    pnpm --filter @herobids/worker run build

# ── deploy: self-contained production layout ─────────────────────────────────
FROM build AS deploy
RUN echo "inject-workspace-packages=true" >> .npmrc && \
    pnpm --filter @herobids/worker deploy --prod /deploy/worker
    
# ── runtime image ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app/apps/worker
# Point the preset loader to the project root where config/ lives.
ENV HEROBIDS_CONFIG_DIR=/app
COPY --from=build /app/config /app/config
COPY --from=deploy /deploy/worker ./
CMD ["node", "dist/index.js"]
