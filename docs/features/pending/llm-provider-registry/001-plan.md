# Provider Registry Pattern — Implementation Plan

The goal is to make llm provider data flexible, extensible and easy to maintain by amongst others having a single source of truth for llm provider data. 

## Problem

Adding a new LLM provider requires editing **two files**:
1. `packages/domain/src/models/llm-models.ts` — register in `KNOWN_LLM_PROVIDERS` and `LLM_PROVIDER_MODELS`
2. `apps/api/src/llm-model-catalog.ts` — add to `PROVIDER_METADATA`

This is error-prone, duplicates metadata, and creates friction for operators who want to add providers (e.g., DeepSeek).

## Goal

Make adding a new provider a **single-line change** in one file (`packages/domain/src/models/llm-models.ts`) while maintaining type safety and keeping the API layer clean.

## Design

### Provider Definition Interface

```typescript
export interface ProviderDefinition {
  id: string;
  models: string[];
  catalogMode: 'static' | 'dynamic';
  devOnly?: boolean;
  isMultiProvider?: boolean;
}
```

### Single Source of Truth in Domain

All provider metadata moves into `PROVIDER_DEFINITIONS` in domain. The API layer imports and uses this directly — no duplicate definitions.

### Key Invariants

- Domain owns **what providers exist** (provider list, model lists, catalog mode)
- API owns **how to fetch/catalog** (OpenRouter pricing, Ollama discovery)
- No provider-specific logic leaks into domain (no API calls, no HTTP)
- Type safety preserved via `Record<string, ProviderDefinition>` + `keyof`

## Implementation Steps

### Step 1: Define registry in domain

**File:** `packages/domain/src/models/llm-models.ts`

- Add `ProviderDefinition` interface
- Create `PROVIDER_DEFINITIONS` record with all current providers
- Derive `KNOWN_LLM_PROVIDERS` from `Object.keys(PROVIDER_DEFINITIONS)`
- Keep `LLM_PROVIDER_MODELS` as a derived helper (or remove if unused elsewhere)

### Step 2: Update API catalog to consume registry

**File:** `apps/api/src/llm-model-catalog.ts`

- Remove local `PROVIDER_METADATA` definition
- Import `PROVIDER_DEFINITIONS` from domain
- Use it directly in `isProviderAllowed()` and other lookup functions
- No functional changes — just refactoring

### Step 3: Update worker config (if needed)

**File:** `apps/worker/src/config.ts`

- Check if worker has its own provider metadata (it doesn't currently, but verify)
- If it references `KNOWN_LLM_PROVIDERS`, it should still work via domain import

### Step 4: Add tests

**File:** `packages/domain/src/models/llm-models.test.ts` (new)

- Test that all providers in `PROVIDER_DEFINITIONS` have required fields
- Test that `KNOWN_LLM_PROVIDERS` matches `PROVIDER_DEFINITIONS` keys
- Test that adding a provider is a single-line operation

### Step 5: Update documentation

**File:** `docs/best-practices/llm-providers.md` (new or update existing)

- Document how to add a new provider
- Show the single-line change example
- List all current providers and their catalog modes

## Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/models/llm-models.ts` | Add `ProviderDefinition`, `PROVIDER_DEFINITIONS`, derive `KNOWN_LLM_PROVIDERS` |
| `apps/api/src/llm-model-catalog.ts` | Remove `PROVIDER_METADATA`, import from domain |
| `packages/domain/src/models/llm-models.test.ts` | New — registry tests |
| `docs/best-practices/llm-providers.md` | New — how-to guide |

## Verification

- [ ] `pnpm lint` passes (no type errors)
- [ ] `pnpm test` passes (all existing tests still pass)
- [ ] Adding a new provider is a single-line change in domain
- [ ] API catalog functions correctly with imported registry
- [ ] No duplicate metadata between domain and API

## Rollout Order

1. Domain changes (Step 1) — no breaking changes, just additions
2. API catalog refactor (Step 2) — drop-in replacement
3. Tests (Step 4) — regression coverage
4. Documentation (Step 5) — operator guidance

## Warning

Don't limit yourself to the information contained in this plan. The code may have changed or this plan may have missed something, so properly check the code base before starting.

