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
RUN echo "inject-workspace-packages=true" >> .npmrc && \
    pnpm --filter @herobids/api deploy --prod /deploy/api
    
# ── runtime image ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app/apps/api
# Point the preset loader to the project root where config/ lives.
ENV HEROBIDS_CONFIG_DIR=/app
COPY --from=build /app/config /app/config
COPY --from=deploy /deploy/api ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
