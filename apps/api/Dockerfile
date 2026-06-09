# syntax=docker/dockerfile:1
# Build context: monorepo root

FROM node:22-alpine AS base
RUN corepack enable

# ── build: install all deps and compile TypeScript ───────────────────────────
FROM base AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @herobids/domain run build && \
    pnpm --filter @herobids/db run build && \
    pnpm --filter @herobids/engine run build && \
    pnpm --filter @herobids/llm run build && \
    pnpm --filter @herobids/strategy run build && \
    pnpm --filter @herobids/venues run build && \
    pnpm --filter @herobids/backtesting run build && \
    pnpm --filter @herobids/api run build

# ── deploy: self-contained production layout ─────────────────────────────────
FROM build AS deploy
RUN pnpm --filter @herobids/api deploy --legacy --prod /deploy/api

# ── runtime image ─────────────────────────────────────────────────────────────
# WORKDIR mirrors apps/api depth so that the config loader resolves
# ../../../config from dist/ → /app/config correctly.
FROM node:22-alpine AS runtime
WORKDIR /app/apps/api
COPY --from=build /app/config /app/config
COPY --from=deploy /deploy/api ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
