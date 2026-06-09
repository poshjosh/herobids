# 011 — Dockerfiles: @herobids/strategy built before @herobids/llm

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** Docker E2E stack build failed because `@herobids/strategy` was compiled before `@herobids/llm` in the Dockerfiles, causing `Cannot find module '@herobids/llm'`.
- **Root Cause:** `packages/strategy/src/llm-provider.ts` imports from `@herobids/llm`. In the Docker build step, `@herobids/strategy` was listed before `@herobids/llm` in the RUN command, so the llm package had no compiled output when strategy tried to reference it.
- **Fix:** Moved `pnpm --filter @herobids/llm run build` to run before `pnpm --filter @herobids/strategy run build` in both `apps/api/Dockerfile` and `apps/worker/Dockerfile`.
- **Files Changed:**
  - `apps/api/Dockerfile`
  - `apps/worker/Dockerfile`
- **Verification:** Full test suite (unit + integration + functional + E2E) passes — 15 E2E tests pass.
