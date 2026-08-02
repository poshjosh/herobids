# Plan: Remove llm.catalog.locality

**Status:** Done
**Created:** 2026-07-07

## Problem

Feature 002-eliminate-static-llm-pricing (Phase 4) replaced the original `devOnly && isProduction`
Ollama gate with URL hostname inspection (`isLocalProviderEndpoint`) plus an operator config
override `llm.catalog.locality`.

This introduced accidental complexity:

1. `host.docker.internal` — Ollama's configured `baseUrl` — is classified as a known-local
   hostname, so Ollama passes the locality gate even on a remote production server running
   inside Docker.
2. `production.yaml` now requires an explicit `locality: remote` override to paper over this
   gap, turning a self-evident flag into a deployment footgun.
3. The `catalogLocality` value must be threaded through `OperatorLlmCatalogContext`,
   `LlmCatalogDeps`, route handlers, and five test fixtures — all for behaviour that
   `NODE_ENV` already encodes correctly.

The root cause is over-engineering: locality detection via URL heuristics solves a problem
(`NODE_ENV` is "not accurate enough") that does not actually exist — `NODE_ENV=production`
is already the authoritative signal for "this is a remote deployment".

## Goal

Remove `llm.catalog.locality` entirely. Restore the `devOnly && isProduction` gate.
Reduce the touch-surface of the provider catalog to its pre-feature-002-Phase-4 shape.

## Approach

Replace:
```typescript
if (config.devOnly) {
  const isLocal = isLocalProviderEndpoint(config.baseUrl, deps.context.catalogLocality);
  if (!isLocal) continue;
}
```

With:
```typescript
if (config.devOnly && isProduction) continue;
```

Delete the helpers and config that only exist to support the removed gate.

---

## Implementation Plan

### Phase 1: Logic — llm-model-catalog.ts

**Files:**
- `apps/api/src/llm-model-catalog.ts`

**Changes:**
- In `getAvailableProviders()`: replace the `devOnly` locality block with
  `if (config.devOnly && isProduction) continue;`
- In `getProviderCatalogEntry()` (line ~569): replace the Ollama "Free" label
  `isLocalProviderEndpoint(...)` guard with `!isProduction`.
- Delete `isLocalProviderEndpoint()` function.
- Delete `isKnownLocalHost()` function.
- Remove `catalogLocality` from the `OperatorLlmCatalogContext` interface.

---

### Phase 2: Schema — domain config

**Files:**
- `packages/domain/src/config/schema.ts`

**Changes:**
- Remove `locality` field from `LlmCatalogConfigSchema`.
- Update the `LlmCatalogConfig` TypeScript interface accordingly.

---

### Phase 3: Config files

**Files:**
- `config/default.yaml`
- `config/production.yaml`

**Changes:**
- `default.yaml`: remove the `locality: auto` line and its comment.
- `production.yaml`: remove the `locality: remote` line and its comment.
  If `catalog:` block becomes empty after removal, remove the block too
  (check `timeoutMs` / `cacheTtlMs` are still present).

---

### Phase 4: Wiring — index.ts and route handlers

**Files:**
- `apps/api/src/index.ts`
- `apps/api/src/routes/agent-evaluations.ts`

**Changes:**
- `index.ts`: remove `catalogLocality: appConfig.llm.catalog.locality` from the
  context object passed to catalog functions.
- `agent-evaluations.ts`: remove `catalogLocality` from `NarrativeLlmDeps` interface
  and the site where it is threaded into the catalog context.

---

### Phase 5: Tests

**Files:**
- `apps/api/src/llm-model-catalog.test.ts`
- `apps/api/src/routes/agents.test.ts`
- `apps/api/src/routes/agent-evaluations.test.ts`
- `apps/api/src/routes/agent-interactivity.test.ts`
- `apps/api/src/routes/agent-evaluation-narrative-llm.test.ts`
- `apps/worker/src/config.test.ts`
- `packages/domain/src/config/schema.test.ts`

**Changes:**
- Remove `catalogLocality: 'auto' | 'remote' | 'us'` from all test fixtures.
- Remove or rewrite the locality-specific unit tests in `llm-model-catalog.test.ts`
  (`catalogLocality: 'remote' forces ollama hidden` etc.) — replace with a test that
  asserts Ollama is hidden when `isProduction` is `true`.
- Remove the `locality` assertions in `schema.test.ts`.
- Remove the `locality: 'local'` assertion in `config.test.ts`.

---

## Acceptance Criteria

- `pnpm lint` passes.
- `pnpm test` passes.
- Ollama does not appear in the provider list when `NODE_ENV=production`.
- Ollama appears in the provider list in development when no other gate blocks it.
- `config/production.yaml` has no `locality` key.
- `LlmCatalogConfigSchema` has no `locality` field.
