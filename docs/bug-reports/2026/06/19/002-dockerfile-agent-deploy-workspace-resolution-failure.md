# Bug Report: Dockerfile.agent deploy stage fails with `workspace:*` resolution error

**Date:** 2026-06-19  
**Status:** Root cause identified, fix in progress  
**Severity:** HIGH — blocks all agent image builds (local and remote)

---

## Symptom

Agent Docker image build fails at the deploy stage with:

```
ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE  No matching version found for @herobids/backtesting@workspace:* inside the workspace. Available versions: 0.0.1-2026.06.19-a
```

This occurs in both:
- Remote deploy via `./scripts/push.sh --yes` (hetzner server)
- Local dev via `scripts/shell/run/reset-and-run.sh`

## Root Cause

The deploy stage uses `pnpm deploy --legacy`:

```dockerfile
RUN pnpm --filter @herobids/worker deploy --legacy --prod /deploy/agent
```

The `--legacy` flag forces pnpm's legacy deploy implementation, which resolves workspace dependencies (`@herobids/backtesting@workspace:*`) by querying the **npm registry** for published versions. Since `@herobids/backtesting` is a local monorepo package (never published), pnpm cannot find a matching version and aborts.

## Attempted Fix #1 (Failed)

Replaced with standard `pnpm install --prod --frozen-lockfile`:

```dockerfile
WORKDIR /deploy/agent
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile
```

**Result:** New error — `ERR_PNPM_NO_PKG_MANIFEST` because `/deploy/agent` is empty (no `package.json`). The deploy stage runs in a fresh container layer with no source code copied.

## Correct Fix

Skip pnpm entirely in the deploy stage. The build stage already has all dependencies resolved via `pnpm install --frozen-lockfile`. Just copy the already-installed `node_modules` and compiled output:

```dockerfile
FROM build AS deploy
RUN mkdir -p /deploy/agent && \
    cp -r apps/worker/node_modules /deploy/agent/node_modules && \
    cp -r apps/worker/dist /deploy/agent/dist
```

The runtime stage's `COPY --from=deploy /deploy/agent ./` will pick up everything unchanged.

## Files Affected

- `docker/Dockerfile.agent` (lines 21-23)

## Impact

- **Before fix:** All agent image builds fail — local dev (`reset-and-run.sh`) and production deploy (`push.sh`) both blocked.
- **After fix:** No change to runtime behavior; `node_modules` and `dist` are identical whether installed via pnpm or copied from build stage.

## Notes

- The `--legacy` flag on `pnpm deploy` is deprecated and fundamentally incompatible with monorepo workspace protocols.
- This bug was introduced when the project migrated to a monorepo with `workspace:*` dependency protocol.
