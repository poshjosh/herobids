# Plan: Eliminate Static LLM Provider Pricing

**Status:** draft
**Created:** 2026-07-06
**Feature ID:** 002-eliminate-static-llm-pricing
**ADR:** [001-eliminate-static-llm-pricing.md](../../../../tech/adrs/2026/07/001-eliminate-static-llm-pricing.md)
**Depends on:** 006-dynamic-llm-pricing (completed — `llm_pricing_snapshots` table and worker fetch)

## Problem

ADR 010 and feature 006 moved OpenRouter pricing to a database-backed dynamic model, but
left four major providers (OpenAI, Anthropic, DeepSeek, Google) on static YAML-embedded
prices. These prices go stale between deploys, creating a business risk: we either overcharge
users or eat margin losses when upstream prices change.

Additionally, the provider catalog has no API-key gating, no single-provider UX optimization,
and relies on `NODE_ENV` rather than hostname detection for locality gating of local providers.

## Goal

1. **Zero hardcoded model prices.** All pricing comes from `llm_pricing_snapshots`, refreshed
   hourly via the existing OpenRouter worker fetch.
2. **Provider visibility rules** are explicit, testable, and enforced in one place:
   API key present + pricing available + locality match.
3. **Single-provider UX.** When exactly one provider is available, the UI skips the provider
   selector and shows only the model selector.
4. **Safe failure mode.** If pricing data is unavailable, providers are hidden — never
   fall back to stale prices.

## Approach

```
                    ┌──────────────────────────┐
                    │   Worker (hourly tick)    │
                    │   fetchOpenRouterPricing  │
                    └────────────┬─────────────┘
                                 │ upserts
                    ┌────────────▼─────────────┐
                    │  llm_pricing_snapshots    │
                    │  (single source of truth) │
                    └────────────┬─────────────┘
                                 │ reads
                    ┌────────────▼─────────────┐
                    │  API: llm-model-catalog   │
                    │                           │
                    │  getAvailableProviders()  │
                    │    ├─ API key check        │
                    │    ├─ Pricing check        │
                    │    └─ Locality check       │
                    │                           │
                    │  getProviderCatalogEntry()│
                    │    ├─ OpenRouter: direct   │
                    │    ├─ ollama: local detect │
                    │    └─ Others: cross-ref    │
                    │       OpenRouter snapshot  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  UI: ModelSelectionFields  │
                    │                           │
                    │  Single provider → skip    │
                    │  provider dropdown, show   │
                    │  only model selector       │
                    └──────────────────────────┘
```

Pricing cross-reference logic:
- OpenRouter model IDs use the format `<upstream>/<model>` (e.g. `openai/gpt-5.5`).
- When a user selects provider `openai`, the catalog queries the OpenRouter snapshot
  for all models where the key starts with `openai/`, strips the prefix, and presents
  them as `openai` provider models with OpenRouter-derived pricing.
- If OpenRouter has no models for a given provider prefix, that provider is hidden.

---

## Implementation Plan

### Phase 1: Relax Schema — Allow Empty Models for Static Providers

**Goal:** `config/providers.yaml` validation no longer requires model prices for
static providers. An empty `models: {}` block is valid and signals "pricing comes
from DB cross-reference."

**Files:**
- `packages/domain/src/models/llm-models.ts` — `ProviderConfigSchema` refine

**Changes:**
- Remove or relax the refine that requires `inputUsdPerM` and `outputUsdPerM` for
  every model on static providers.
- The `models` key remains required (it defines which models exist), but individual
  model entries may omit pricing fields.
- Add a new `pricingSource` field to `ProviderConfig`: `'openrouter' | 'inline' | 'none'`.
  - `'openrouter'`: pricing cross-referenced from OpenRouter snapshot (openai, anthropic, deepseek, google)
  - `'inline'`: pricing embedded in YAML (only for backward compat during migration)
  - `'none'`: no pricing (ollama — free)

**Acceptance:**
- `pnpm lint` passes with `models: {}` for static providers.
- Existing tests that depend on inline pricing still pass (they use inline mode).

---

### Phase 2: API Key Gating

**Goal:** `getAvailableProviders()` checks for the corresponding `LLM_API_KEY_<PROVIDER>`
environment variable. Providers without a key are hidden.

**Files:**
- `apps/api/src/llm-model-catalog.ts` — `getAvailableProviders()`

**Changes:**
- Add a helper: `function hasApiKey(provider: string): boolean`
  - Checks `process.env[`LLM_API_KEY_${provider.toUpperCase()}`]`
  - Also checks `process.env['LLM_API_KEY']` as a generic fallback
- In the provider loop, skip providers where `!hasApiKey(providerId)`.
- Exception: ollama never requires an API key (local provider).
- Exception: OpenRouter without a key is still shown if `LLM_API_KEY` generic fallback
  is set (common operator setup).

**Acceptance:**
- Unit test: provider with `LLM_API_KEY_OPENAI=sk-xxx` appears; without it, hidden.
- Unit test: ollama appears regardless of API key.
- Integration test: `GET /ai/available-models` returns only keyed providers.

---

### Phase 3: Pricing Cross-Reference from OpenRouter Snapshot

**Goal:** For providers with `pricingSource: 'openrouter'`, the catalog derives model
pricing from the active OpenRouter `llm_pricing_snapshots` row.

**Files:**
- `apps/api/src/llm-model-catalog.ts` — `getProviderModels()`, `getProviderCatalogEntry()`

**Changes:**
- Add a function: `async function getOpenRouterDerivedModels(provider: string, deps: LlmCatalogDeps): Promise<ProviderModelEntry[]>`
  1. Fetch the active OpenRouter snapshot from DB.
  2. Filter snapshot keys that start with `${provider}/`.
  3. Strip the prefix to get model IDs (e.g. `openai/gpt-5.5` → `gpt-5.5`).
  4. Map pricing from the snapshot entries.
  5. If no models match, return empty array → provider is hidden.
- In `getProviderModels()`, for providers with `pricingSource: 'openrouter'`, call
  `getOpenRouterDerivedModels()` instead of reading from YAML.
- In `getProviderCatalogEntry()`, for providers with `pricingSource: 'openrouter'`,
  use the derived models with pricing metadata (same format as OpenRouter entries).
- Remove the "DO NOT add pricing for static providers" guard — it's now safe to add
  pricing because the source is dynamic.

**Acceptance:**
- Unit test: `openai` provider returns models from OpenRouter snapshot with correct pricing.
- Unit test: if OpenRouter snapshot has no `openai/*` models, `openai` provider is hidden.
- Unit test: model IDs are correctly stripped ( `openai/gpt-5.5` → `gpt-5.5`).

---

### Phase 4: Locality Gating (Fix ollama Detection)

**Goal:** Ollama only appears when running on a local host, determined by hostname
inspection (not `NODE_ENV`).

**Files:**
- `apps/api/src/llm-model-catalog.ts` — `getAvailableProviders()`

**Changes:**
- Replace the `devOnly && isProduction` check with a locality check:
  - For `devOnly: true` providers, call `isLocalProviderEndpoint(config.baseUrl, deps.context.catalogLocality)`.
  - If not local, skip the provider.
- This is already implemented in `getProviderCatalogEntry()` for the Free label — reuse
  the same `isLocalProviderEndpoint()` function for availability gating.

**Acceptance:**
- Unit test: ollama appears when `baseUrl` is `http://localhost:11434/v1`.
- Unit test: ollama hidden when `baseUrl` is `http://192.168.1.50:11434/v1` (remote host).
- Unit test: `catalogLocality: 'remote'` forces ollama hidden regardless of hostname.

---

### Phase 5: Single-Provider UI Mode

**Goal:** When the API returns exactly one available provider, the UI hides the provider
dropdown and shows only the model selector.

**Files:**
- `apps/web/src/features/settings/ModelSelectionFields.tsx` — component and `resolveDefaultModelSelection()`
- `apps/web/src/features/agents/AgentsPage.tsx` — agent creation flow
- `apps/web/src/features/agents/EditAgentModal.tsx` — agent editing flow

**Changes:**
- In `resolveDefaultModelSelection()`:
  - After filtering, if `providers.length === 1`, auto-select that provider.
  - This replaces the current `isMultiProvider` fallback which is a heuristic, not a rule.
- In `ModelSelectionFields` component:
  - Add a `hideProviderSelector` prop or derive it from `providers.length === 1`.
  - When `hideProviderSelector` is true, render the provider as a read-only label or
    hidden field, and show only the model dropdowns.
- Update call sites in `AgentsPage.tsx`, `EditAgentModal.tsx`, and `SettingsPage.tsx`
  to pass the single-provider state through.

**Acceptance:**
- Visual test: with one provider, only model dropdowns are visible.
- Unit test: `resolveDefaultModelSelection` returns the single provider when only one exists.
- Unit test: `resolveDefaultModelSelection` returns `null` when zero providers exist.

---

### Phase 6: Remove Static Pricing Data

**Goal:** Strip model prices from `config/providers.yaml` for openai, anthropic,
deepseek, google. Remove static seeding logic.

**Files:**
- `config/providers.yaml` — remove price values from static provider entries
- `apps/worker/src/usage-billing-service.ts` (or wherever `seedStaticPricing` lives) — remove
- `packages/domain/src/models/llm-models.ts` — remove `getProviderModelIds` dependence on inline pricing

**Changes:**
- For each static provider, change `models:` to `models: {}` and add `pricingSource: 'openrouter'`.
- Remove the `seedStaticPricing()` function and its call site in the worker startup.
- Ensure the worker OpenRouter fetch is the sole pricing data pipeline.

**Acceptance:**
- `pnpm lint` passes.
- `config/providers.yaml` passes Zod validation.
- Worker starts without error (no static seeding code).
- Integration test: after worker fetch, all providers have pricing from DB.

---

### Phase 7: Tests & Cleanup

**Files:**
- `apps/api/src/routes/ai.test.ts` — add/update tests for new gating rules
- `apps/api/src/llm-model-catalog.test.ts` (new or existing) — unit tests for cross-reference
- `packages/domain/src/models/llm-models.test.ts` — update for relaxed schema
- `apps/web/src/features/settings/model-selection-fields.test.tsx` — single-provider tests

**Acceptance:**
- All existing tests pass.
- New tests cover: API key gating, pricing cross-reference, single-provider selection,
  locality gating, empty snapshot handling.

---

## Open Questions & Caveats

### Q1: What if OpenRouter doesn't list a model we want to offer?

Example: a new OpenAI model launches and isn't yet in OpenRouter's catalog. Under this
design, the model won't appear until OpenRouter indexes it. This is intentional (no
stale fallback) but means we lag behind provider launches by OpenRouter's indexing delay
(typically hours, occasionally days).

**Mitigation:** Acceptable for v1. If this becomes a business problem, we can add a
direct-provider pricing fetch as a secondary pipeline in a future iteration.

### Q2: What if OpenRouter's pricing differs from the direct provider's pricing?

**Resolved — Option A: Accept the discrepancy.**

OpenRouter adds a margin on top of upstream provider pricing. A model routed directly
through OpenAI costs less than the same model routed through OpenRouter. We bill at
OpenRouter's reference rate regardless of routing path. This is simple, conservative
(we don't undercharge), and users see transparent pricing in the UI before they select.
Revisit if user feedback or competitive pressure warrants it.

### Q3: Locality gating — what about Docker?

`host.docker.internal` is already in `isKnownLocalHost()`. But the API container's
`baseUrl` for ollama would be `http://host.docker.internal:11434/v1` — this resolves
correctly. Verify the API container can detect this as local.

### Q4: What happens during a cold start before the first worker fetch?

**Resolved — Accept the cold-start window.**

This only occurs on the very first deploy to a fresh database. On all subsequent
deploys and restarts, active pricing snapshots persist in Postgres. The window is
seconds-long (worker fetches immediately on startup), and the API returns a clear
`503: No AI provider is configured on this platform` during it.

The `llm_pricing_snapshots` table will have no active rows. `getAvailableProviders()`
will find zero providers (OpenRouter fails the "has active snapshot" check, others
fail the "OpenRouter snapshot available for cross-reference" check). The UI shows
"No AI providers configured."

This is acceptable: the platform must not serve stale or absent pricing, and the
window affects only the first deploy to a new database.

### Q5: Should we keep the `models` key in providers.yaml for openrouter-derived providers?

**Resolved — Keep as an optional allowlist.**

If pricing comes entirely from the DB, the `models` key in YAML serves as a
model allowlist/denylist:
- If `models` is **non-empty**, intersect with OpenRouter-derived models — only
  explicitly listed models appear. Operator controls exactly what's offered.
- If `models` is **empty** (`{}`), show all OpenRouter-derived models for that
  provider prefix automatically. Less maintenance for operators who want everything.

This gives operators control without requiring constant YAML updates.

### Q6: Backward compatibility during migration?

**Resolved — OpenRouter snapshot wins, then inline YAML prices removed.**

The migration path:
1. Deploy code with relaxed schema (Phase 1) — old YAML with inline prices still works.
2. Deploy code with cross-reference logic (Phases 2-5) — if a provider has both inline
   YAML prices AND an OpenRouter snapshot, **OpenRouter snapshot wins.** Dynamic data
   is always fresher. Inline prices are only used as a fallback during the migration
   window, and only in development (production already filters static providers).
3. Remove inline prices from YAML (Phase 6) — cross-reference is now the only path.
   Inline pricing code is deleted entirely.

### Q7: What about `estimateLlmCostUsd()` in the agent runtime?

This function (`apps/worker/src/agent.ts`) uses a hardcoded lookup for cost estimation
during agent reasoning. It is explicitly out of scope for this feature. It continues
to use its current heuristic. A follow-up feature should make it read from the DB
snapshot.

### Q8: Rate limiting for the OpenRouter pricing fetch?

The worker already fetches OpenRouter pricing hourly. No change to fetch frequency.
But if we now depend on this data for ALL providers (not just OpenRouter display),
the reliability requirement increases. Consider:
- Adding a freshness metric + alert if the snapshot is >2 hours old.
- Adding a health check that fails if no active snapshot exists after startup + grace period.
