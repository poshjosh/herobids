# Plan: Dynamic LLM Pricing — Database-Backed Provider Pricing

**Status:** Done
**Created:** 2026-06-27  
**Feature ID:** 006-dynamic-llm-pricing  
**ADR:** [010-llm-pricing-data-not-hardcoded.md](../../../../tech/adrs/2026/06/010-llm-pricing-data-not-hardcoded.md)  
**Discovery:** [000-llm-billing-not-dynamic.md](./000-llm-billing-not-dynamic.md)

## Problem

`PROVIDER_DEFINITIONS` in `packages/domain/src/models/llm-models.ts` hardcodes ~120 model prices across 6 providers in TypeScript. This object feeds both the UI model catalog and billing rate card seeding (`getLlmModelRateCardItems()`). For OpenRouter — the only provider exposed in production — pricing is also fetched dynamically via `fetchOpenRouterCatalog()`, but that data is used only for UI display. Billing uses the hardcoded static prices. The UI and billing can diverge silently.

Additionally: updating any price requires a code change and deploy. New OpenRouter models get no per-model billing rate. The hardcoded data/code coupling is a code smell.

## Goal

**LLM provider pricing is stored in PostgreSQL (`llm_pricing_snapshots`) and loaded at runtime.** Hardcoded pricing data is removed from application code. Provider metadata moves to `config/providers.yaml`. OpenRouter pricing is fetched periodically by the worker and written to DB. Rate card seeding reads from DB. API model catalog reads from DB.

## Approach

Three-tier data architecture:

| Tier | What | Where | Lifecycle |
|------|------|-------|-----------|
| **Provider metadata** | IDs, `catalogMode`, `fetchUrl`, `isMultiProvider`, `devOnly` | `config/providers.yaml` | Deploy (operator) |
| **Static pricing** | OpenAI, Anthropic, DeepSeek, Google model prices | `config/providers.yaml` → upserted to DB on startup | Deploy (operator) |
| **Dynamic pricing** | OpenRouter model prices | Worker fetch → DB (`llm_pricing_snapshots`) | Hourly refresh (automated) |

Production continues to expose only `catalogMode: 'dynamic'` providers (OpenRouter). Static providers remain dev-only. The freshness guarantee for static pricing is unchanged.

---

## Implementation Plan

### Phase 1: Database

#### 1a. Create `llm_pricing_snapshots` schema

**File:** `packages/db/src/schema/llm-pricing-snapshots.ts` (new)

```ts
import { pgTable, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';

export const llmPricingSnapshots = pgTable(
  'llm_pricing_snapshots',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    models: jsonb('models').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_llm_pricing_snapshots_provider_active').on(t.provider, t.isActive),
  ],
);
```

- `id`: e.g. `"openrouter_2026-06-27T14:00:00.000Z"` (deterministic from provider + timestamp)
- `fetchedAt`: `null` for statically-seeded rows, timestamp for dynamically-fetched rows
- `models`: JSONB — `{ "openai/gpt-5.5": { "inputUsdPerM": 5, "outputUsdPerM": 30 }, ... }`
- `isActive`: only one row per provider is active at a time

**File:** `packages/db/src/schema/index.ts` — add export

#### 1b. Generate migration

```bash
pnpm --filter @herobids/db run generate
```

Migration creates the table + index. No seed data (data comes from `config/providers.yaml`).

#### 1c. Add repository methods

**File:** `packages/db/src/usage-billing-repository.ts`

```ts
/** Get the active pricing snapshot for a provider, or null if none exists. */
async getLatestPricingSnapshot(provider: string): Promise<LlmPricingSnapshot | null> {
  const [row] = await this.db
    .select()
    .from(llmPricingSnapshots)
    .where(
      and(
        eq(llmPricingSnapshots.provider, provider),
        eq(llmPricingSnapshots.isActive, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Upsert a new pricing snapshot. Sets the new row active, deactivates previous rows for the same provider. */
async upsertPricingSnapshot(params: {
  id: string;
  provider: string;
  fetchedAt: Date | null;
  models: Record<string, ModelPricing>;
}): Promise<void> {
  await this.db.transaction(async (tx) => {
    await tx
      .update(llmPricingSnapshots)
      .set({ isActive: false })
      .where(
        and(
          eq(llmPricingSnapshots.provider, params.provider),
          eq(llmPricingSnapshots.isActive, true),
        ),
      );
    await tx
      .insert(llmPricingSnapshots)
      .values({
        id: params.id,
        provider: params.provider,
        fetchedAt: params.fetchedAt,
        models: params.models as any,
        isActive: true,
      })
      .onConflictDoNothing();
  });
}
```

---

### Phase 2: Config & Domain

#### 2a. Create `config/providers.yaml`

**File:** `config/providers.yaml` (new)

```yaml
# LLM Provider Registry
# - Provider metadata (IDs, catalog mode, fetch URLs)
# - Static provider model pricing (OpenAI, Anthropic, DeepSeek, Google)
# - Dynamic providers (OpenRouter) have empty models — pricing is fetched at runtime
#
# To add a provider: add an entry here.
# To add/update static pricing: edit the models block + deploy.
# Dynamic pricing updates automatically (worker fetches hourly).

providers:
  openai:
    catalogMode: static
    models:
      gpt-5.5:       { inputUsdPerM: 5,    outputUsdPerM: 30 }
      gpt-5.4:       { inputUsdPerM: 2.5,  outputUsdPerM: 15 }
      gpt-5:         { inputUsdPerM: 2,    outputUsdPerM: 8 }
      o3:            { inputUsdPerM: 2,    outputUsdPerM: 8 }
      gpt-4.1:       { inputUsdPerM: 2,    outputUsdPerM: 8 }
      gpt-5.4-mini:  { inputUsdPerM: 0.75, outputUsdPerM: 4.5 }
      gpt-5-mini:    { inputUsdPerM: 0.75, outputUsdPerM: 4.5 }
      gpt-4o:        { inputUsdPerM: 2.5,  outputUsdPerM: 10 }
      o4-mini:       { inputUsdPerM: 1.1,  outputUsdPerM: 4.4 }
      gpt-4.1-mini:  { inputUsdPerM: 0.4,  outputUsdPerM: 1.6 }
      gpt-4.1-nano:  { inputUsdPerM: 0.1,  outputUsdPerM: 0.4 }
      gpt-4o-mini:   { inputUsdPerM: 0.15, outputUsdPerM: 0.6 }
      gpt-5-nano:    { inputUsdPerM: 0.2,  outputUsdPerM: 1.25 }
      gpt-5.4-nano:  { inputUsdPerM: 0.2,  outputUsdPerM: 1.25 }

  anthropic:
    catalogMode: static
    models:
      claude-opus-4-8:   { inputUsdPerM: 5,   outputUsdPerM: 25 }
      claude-opus-4-7:   { inputUsdPerM: 5,   outputUsdPerM: 25 }
      claude-opus-4-5:   { inputUsdPerM: 15,  outputUsdPerM: 75 }
      claude-sonnet-4-6: { inputUsdPerM: 3,   outputUsdPerM: 15 }
      claude-sonnet-4-5: { inputUsdPerM: 3,   outputUsdPerM: 15 }
      claude-haiku-4-5:  { inputUsdPerM: 1,   outputUsdPerM: 5 }
      claude-haiku-3-5:  { inputUsdPerM: 0.8, outputUsdPerM: 4 }

  deepseek:
    catalogMode: static
    models:
      deepseek-v4-flash: { inputUsdPerM: 0.14, outputUsdPerM: 0.28 }
      deepseek-v4-pro:   { inputUsdPerM: 0.43, outputUsdPerM: 0.87 }
      deepseek-r1:       { inputUsdPerM: 0.7,  outputUsdPerM: 2.5 }
      deepseek-chat:     { inputUsdPerM: 0.32, outputUsdPerM: 0.89 }

  google:
    catalogMode: static
    models:
      gemini-3.1-pro-preview:        { inputUsdPerM: 2,     outputUsdPerM: 12 }
      gemini-2.5-pro:                { inputUsdPerM: 1.25,  outputUsdPerM: 10 }
      gemini-3-flash-preview:        { inputUsdPerM: 0.5,   outputUsdPerM: 3 }
      gemini-2.5-flash:              { inputUsdPerM: 0.3,   outputUsdPerM: 2.5 }
      gemini-3.1-flash-lite-preview: { inputUsdPerM: 0.25,  outputUsdPerM: 1.5 }
      gemini-2.5-flash-lite:         { inputUsdPerM: 0.1,   outputUsdPerM: 0.4 }
      gemini-1.5-pro:                { inputUsdPerM: 1.25,  outputUsdPerM: 5 }
      gemini-1.5-flash:              { inputUsdPerM: 0.075, outputUsdPerM: 0.3 }

  openrouter:
    catalogMode: dynamic
    isMultiProvider: true
    fetchUrl: https://openrouter.ai/api/v1
    models: {}

  ollama:
    catalogMode: dynamic
    devOnly: true
    models: {}
```

#### 2b. Add Zod schemas for providers.yaml

**No new dependency.** Both `apps/worker/src/config.ts` and `apps/api/src/config.ts` already import `parseYaml` from the `yaml` package. The same package is used here.

**File:** `packages/domain/src/models/llm-models.ts` — add schemas (keep types)

```ts
import { z } from 'zod';

export const ModelPricingSchema = z.object({
  inputUsdPerM: z.number().positive(),
  outputUsdPerM: z.number().positive(),
  reasoningUsdPerM: z.number().positive().optional(),
});

const RawProviderConfigSchema = z.object({
  catalogMode: z.enum(['static', 'dynamic']),
  devOnly: z.boolean().optional(),
  isMultiProvider: z.boolean().optional(),
  fetchUrl: z.string().url().optional(),
  models: z.record(z.string(), z.object({
    inputUsdPerM: z.number().positive().optional(),
    outputUsdPerM: z.number().positive().optional(),
    reasoningUsdPerM: z.number().positive().optional(),
  })),
});

// Refine: static providers must have pricing for all models
export const ProviderConfigSchema = RawProviderConfigSchema.refine(
  (config) => {
    if (config.catalogMode === 'static') {
      return Object.values(config.models).every(
        (m) => m.inputUsdPerM != null && m.outputUsdPerM != null,
      );
    }
    return true;
  },
  { message: 'Static providers must have inputUsdPerM and outputUsdPerM for every model' },
);

export const ProvidersYamlSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersYaml = z.infer<typeof ProvidersYamlSchema>;
```

#### 2c. Add config loading

**File:** `packages/domain/src/config/load-providers.ts` (new)

**Note:** `config/providers.yaml` is loaded as a **standalone file** — separate from `loadConfig()` / `AppConfigSchema`. It is provider metadata/data, not operator infra config (DB URLs, ports, etc.). Keeping it separate follows the "separate file for separate concern" pattern and avoids bloating the existing config resolution chain.

```ts
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ProvidersYamlSchema, type ProvidersYaml } from '../models/llm-models.js';

export function loadProvidersConfig(path: string): ProvidersYaml {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  return ProvidersYamlSchema.parse(parsed);
}
```

Note: `yaml` is not currently a dependency. Check if already in the tree. If not, add `yaml` to `packages/domain/package.json`. Alternatively, use the existing config loading mechanism (`packages/domain/src/config/`) if it already handles YAML.

#### 2d. Refactor domain helpers

**File:** `packages/domain/src/models/llm-models.ts`

- Remove `PROVIDER_DEFINITIONS` constant entirely
- Remove `KNOWN_LLM_PROVIDERS` constant and `LlmProviderId` type
- Remove `isKnownLlmProvider()`
- Refactor remaining helpers to accept data as parameters:

```ts
/** Returns model IDs for a provider from the loaded config. */
export function getProviderModelIds(
  providerConfig: ProviderConfig | undefined,
): string[] {
  if (!providerConfig) return [];
  return Object.keys(providerConfig.models);
}

/** Returns pricing for a specific model from a pricing snapshot. */
export function getLlmModelPricing(
  snapshot: Record<string, ModelPricing> | null,
  modelId: string,
): ModelPricing | undefined {
  if (!snapshot) return undefined;
  const m = snapshot[modelId];
  if (!m || m.inputUsdPerM === undefined || m.outputUsdPerM === undefined) return undefined;
  return m as ModelPricing;
}

/** Generate rate card seed items from a pricing snapshot. */
export function getLlmModelRateCardItems(
  providerId: string,
  snapshot: Record<string, ModelPricing> | null,
): Array<{
  meterKey: string;
  provider: string;
  modelPattern: string;
  priceMicrousd: number;
  perUnit: number;
}> {
  // Same conversion logic (USD per 1M → µUSD per 1K), iterates snapshot instead of PROVIDER_DEFINITIONS
  // ...
}

/** Validate model selection against provider config. */
export function validateLlmModelSelection(
  selection: { provider: string; lightModel: string; heavyModel: string },
  providerConfig: ProviderConfig | undefined,
): Array<{ code: 'custom'; path: string[]; message: string }> {
  // Uses providerConfig.models keys instead of PROVIDER_DEFINITIONS
  // ...
}
```

#### 2e. Update `llm-models.test.ts`

**File:** `packages/domain/src/models/llm-models.test.ts`

- Remove tests that assert on `PROVIDER_DEFINITIONS` structure
- Add tests for `ProvidersYamlSchema` validation:
  - Valid static provider (all models have pricing) → passes
  - Static provider with missing pricing → fails
  - Dynamic provider with empty models → passes
- Add tests for refactored helpers with parameterized data

---

### Phase 3: Worker — Pricing Fetch & Seed

#### 3a. Extract OpenRouter fetch logic to shared utility

**File:** `packages/llm/src/openrouter-pricing.ts` (new)

Extract the core `fetchOpenRouterCatalog()` logic from `apps/api/src/llm-model-catalog.ts`:

```ts
export interface OpenRouterPricingResult {
  models: Record<string, ModelPricing>;
}

export async function fetchOpenRouterPricing(params: {
  apiKey: string;
  fetchUrl: string;
  timeoutMs: number;
}): Promise<OpenRouterPricingResult> {
  // Calls OpenRouter /v1/models endpoint
  // Returns ModelPricing (inputUsdPerM, outputUsdPerM, reasoningUsdPerM)
  // On failure, returns { models: {} }
  // No in-memory cache — caller (worker) handles persistence via DB
}
```

The existing `fetchOpenRouterCatalog()` in the API has ~80 lines of fetch + in-memory cache + `deriveLatestVariants`. We extract ONLY the fetch + parse portion. The cache and `deriveLatestVariants` stay in the API (presentation concerns).

#### 3b. Add periodic pricing refresh to worker

**File:** `apps/worker/src/usage-billing-service.ts` (or a new file)

```ts
/** Refresh dynamic provider pricing from their APIs and persist to DB. */
async function refreshDynamicPricing(
  providers: ProvidersYaml,
  repo: UsageBillingRepository,
): Promise<void> {
  for (const [providerId, config] of Object.entries(providers.providers)) {
    if (config.catalogMode !== 'dynamic' || !config.fetchUrl) continue;

    try {
      const result = await fetchOpenRouterPricing({
        apiKey: resolveApiKey(providerId),
        fetchUrl: config.fetchUrl,
        timeoutMs: 15_000,
      });

      if (Object.keys(result.models).length === 0) {
        logger.warn({ provider: providerId }, 'Dynamic pricing fetch returned empty — keeping existing snapshot');
        continue;
      }

      const now = new Date();
      await repo.upsertPricingSnapshot({
        id: `${providerId}_${now.toISOString()}`,
        provider: providerId,
        fetchedAt: now,
        models: result.models,
      });

      logger.info({ provider: providerId, modelCount: Object.keys(result.models).length },
        'Dynamic pricing snapshot refreshed');
    } catch (err) {
      logger.warn({ err, provider: providerId }, 'Failed to refresh dynamic pricing — will retry next tick');
    }
  }
}
```

#### 3c. Seed static providers on startup

**File:** `apps/worker/src/usage-billing-service.ts`

```ts
/** Ensure static providers have an active pricing snapshot (upsert from YAML if missing). */
async function seedStaticPricing(
  providers: ProvidersYaml,
  repo: UsageBillingRepository,
): Promise<void> {
  for (const [providerId, config] of Object.entries(providers.providers)) {
    if (config.catalogMode !== 'static') continue;

    const existing = await repo.getLatestPricingSnapshot(providerId);
    if (existing) continue; // already seeded from prior deploy

    const models = Object.fromEntries(
      Object.entries(config.models)
        .filter(([, m]) => m.inputUsdPerM != null && m.outputUsdPerM != null)
        .map(([id, m]) => [id, {
          inputUsdPerM: m.inputUsdPerM!,
          outputUsdPerM: m.outputUsdPerM!,
          ...(m.reasoningUsdPerM != null ? { reasoningUsdPerM: m.reasoningUsdPerM } : {}),
        }]),
    );

    if (Object.keys(models).length === 0) continue;

    await repo.upsertPricingSnapshot({
      id: `seed_${providerId}_v1`,
      provider: providerId,
      fetchedAt: null, // static — no fetch timestamp
      models,
    });

    logger.info({ provider: providerId, modelCount: Object.keys(models).length },
      'Seeded static pricing snapshot from config');
  }
}
```

#### 3d. Wire into worker startup and tick loop

**File:** `apps/worker/src/index.ts` (or wherever the worker lifecycle is)

- On startup: load `config/providers.yaml` → `seedStaticPricing()` → `refreshDynamicPricing()`
- On periodic tick (every `catalog.cacheTtlMs`, default ~1 hour): `refreshDynamicPricing()`

#### 3e. Update rate card seeding

**File:** `packages/db/src/usage-billing-repository.ts` — `seedDefaultRateCardItems()`

Change from:
```ts
const modelItems = getLlmModelRateCardItems().map(...)
```

To:
```ts
// For each provider with an active pricing snapshot, generate per-model rate card items
const modelItems: Array<{...}> = [];
for (const [providerId] of Object.entries(this.providers.providers)) {
  const snapshot = await this.getLatestPricingSnapshot(providerId);
  if (!snapshot) continue;
  const items = getLlmModelRateCardItems(providerId, snapshot.models as Record<string, ModelPricing>);
  modelItems.push(...items.map((item) => ({...})));
}
```

Note: `UsageBillingRepository` will need access to the loaded `ProvidersYaml`. Pass via constructor or as a parameter to `seedDefaultRateCardItems()`.

---

### Phase 4: API — Model Catalog

#### 4a. Replace inline OpenRouter fetch with DB read

**File:** `apps/api/src/llm-model-catalog.ts`

Current flow:
```
getProviderCatalogEntry('openrouter')
  → fetchOpenRouterCatalog()  // HTTP call to OpenRouter
    → in-memory cache
    → deriveLatestVariants()
  → mapProviderModels(...)
```

The API already has access to `Database` via the `aiRoutes()` function signature (`db: Database`). The catalog helpers will query `llm_pricing_snapshots` directly via `db` rather than requiring the full `UsageBillingRepository`. This is simpler: the read query is a one-liner `SELECT ... WHERE provider = $1 AND is_active = true LIMIT 1`, and the API already uses `UsageBillingRepository` for billing concerns (`entitlement-sync.ts`, `routes/billing.ts`) — we avoid coupling the catalog presentation layer to billing infrastructure.

New flow:
```
getProviderCatalogEntry('openrouter', db, providersYaml)
  → SELECT * FROM llm_pricing_snapshots WHERE provider='openrouter' AND is_active=true LIMIT 1
  → convert DB models (JSONB) to OpenRouterCatalog format
    → in-memory cache (short TTL, e.g., 30s)
    → deriveLatestVariants()
  → mapProviderModels(...)
  → fallback: if no snapshot, return providersYaml.openrouter.models keys without pricing
    (same degraded behavior as today when OpenRouter API is unreachable)
```

The `deriveLatestVariants()` logic stays — it's presentation logic (`:latest` aliases). The HTTP fetch + in-memory cache + stale cache fallback logic (~80 lines) is removed.

#### 4b. Update `getAvailableProviders()`

**File:** `apps/api/src/llm-model-catalog.ts`

Current logic:
```
Production: only catalogMode === 'dynamic' providers
Development: all configured providers
```

New logic (unchanged rule, refined implementation):
```
Production: catalogMode === 'dynamic' AND has active pricing snapshot
Development: all configured providers that have an active pricing snapshot
```

The refinement: a dynamic provider without a snapshot (worker hasn't fetched yet) is not shown. This is the correct behavior — no pricing = no offering.

#### 4c. Update `validateAiModelSelection()`

**File:** `apps/api/src/llm-model-catalog.ts`

Uses `validateLlmModelSelection()` from domain. Refactored helper now accepts `ProviderConfig` parameter. Pass the loaded config from `providers.yaml`. Logic unchanged.

---

### Phase 5: Frontend

**No changes expected.** The frontend consumes the API's `/ai/available-models` endpoint. The response shape (`ProviderCatalogEntry` with `ModelPricingMetadata`) is unchanged. Pricing labels, model IDs, and provider metadata remain the same.

Verification: check that the UI model picker still renders correctly with the API returning DB-sourced data.

---

### Phase 6: Tests

#### 6a. Unit tests

| Test | File | What it verifies |
|------|------|-----------------|
| `ProvidersYamlSchema` — valid static | `llm-models.test.ts` | Static provider with full pricing passes validation |
| `ProvidersYamlSchema` — missing pricing | `llm-models.test.ts` | Static provider with missing `inputUsdPerM` fails |
| `ProvidersYamlSchema` — dynamic empty | `llm-models.test.ts` | Dynamic provider with `models: {}` passes |
| `getLlmModelRateCardItems()` with snapshot | `llm-models.test.ts` | Correct µUSD/1K conversion from snapshot |
| `getLlmModelRateCardItems()` empty snapshot | `llm-models.test.ts` | Returns empty array |
| `getLlmModelPricing()` with snapshot | `llm-models.test.ts` | Returns correct pricing or undefined |
| `upsertPricingSnapshot()` | `usage-billing-repository.test.ts` | New row active, old rows deactivated |
| `getLatestPricingSnapshot()` | `usage-billing-repository.test.ts` | Returns active row, null if none |
| `seedDefaultRateCardItems()` with snapshots | `usage-billing-repository.test.ts` | Rate card items generated from DB data |
| `fetchOpenRouterPricing()` | `openrouter-pricing.test.ts` | Parses API response correctly; returns empty on failure |
| API model catalog with DB snapshot | `ai.test.ts` | `GET /ai/available-models` returns openrouter models with pricing from DB |

#### 6b. Integration tests

| Test | What it verifies |
|------|-----------------|
| Worker fetch → DB → rate card seeding | Full pipeline: OpenRouter API → `llm_pricing_snapshots` → `billing_rate_card_items` populated with correct prices |
| Static provider seeding on startup | `config/providers.yaml` → DB upsert on first run → subsequent runs skip (idempotent) |
| API reads stale snapshot when worker hasn't refreshed | API returns last-known-good pricing from DB |
| API returns empty catalog when no snapshot exists | First deploy before worker fetch — graceful degradation |

#### 6c. Functional tests

| Test | File | What it verifies |
|------|------|-----------------|
| Agent creation validates model against DB-backed catalog | `bots-lifecycle.test.ts` or similar | Model selection passes/fails based on active snapshot, not hardcoded data |
| Rate card item pricing matches DB snapshot | `usage-billing-service.test.ts` | `computeCharge()` uses correct per-model rate |

#### 6d. E2E tests (if applicable)

| Test | What it verifies |
|------|-----------------|
| Agent creation flow — model picker shows OpenRouter models with pricing | UI renders pricing from DB-backed API response |
| Agent runs → usage billed at DB-sourced rate | End-to-end: fetch → DB → rate card → computeCharge → ledger entry |

---

### Phase 7: Documentation

| Doc | Update |
|-----|--------|
| `docs/best-practices/llm-providers.md` | Replace `PROVIDER_DEFINITIONS` architecture diagram with `providers.yaml` + `llm_pricing_snapshots` diagram. Document how to add a provider. |
| `docs/best-practices/configuration.md` | Add `providers.yaml` to the operator config layer documentation. |
| `docs/product/llm-billing-not-dynamic.md` | Update status to "resolved" with link to ADR + plan. |
| `CHANGELOG.md` | Entry: "LLM pricing sourced from database (`llm_pricing_snapshots`) + `config/providers.yaml`. Hardcoded `PROVIDER_DEFINITIONS` removed." |

---

### Phase 8: Cleanup

- Remove `PROVIDER_DEFINITIONS` constant from `packages/domain/src/models/llm-models.ts`
- Remove `KNOWN_LLM_PROVIDERS`, `LlmProviderId`, `isKnownLlmProvider()`
- Remove inline `fetchOpenRouterCatalog()` from `apps/api/src/llm-model-catalog.ts` (the cache + HTTP fetch portion; keep `deriveLatestVariants`)
- Remove `clearOpenRouterPricingCache()` export (no longer needed; DB is the cache)
- Verify no remaining imports of removed symbols — `pnpm lint` must pass

---

## Out of Scope

- `estimateLlmCostUsd()` in `apps/worker/src/agent.ts` — agent cost estimation heuristic. Tracked as follow-up.
- Ollama dynamic pricing — Ollama models are free/local and have no pricing. Model discovery is unchanged.
- Admin UI for managing provider pricing — future feature.
- Automated static provider price freshness checks — future feature if static providers ever go to production.

---

## Resolved Decisions

These questions were raised during planning and resolved as follows:

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | YAML dependency? | Already present | `apps/worker/src/config.ts` and `apps/api/src/config.ts` both import `parseYaml` from `yaml`. No new dep. |
| 2 | `providers.yaml` — merge into `AppConfig` or standalone? | **Standalone file** | Provider metadata/data is a different concern than operator infra config (DB URLs, ports). Separate file = separate concern. Simple to load: `readFileSync` + `parseYaml` + Zod validate. |
| 3 | How does API catalog access pricing data? | **Direct `db` query** | API's `aiRoutes()` already receives `db: Database`. Catalog queries `llm_pricing_snapshots` directly — a one-liner SELECT. `UsageBillingRepository` is already wired for billing concerns; we avoid coupling catalog presentation to billing infrastructure. |
| 4 | Worker fetch interval? | `catalog.cacheTtlMs` from operator config | Already configured. On startup, fetch immediately regardless of TTL for fresh data after deploy. |
| 5 | Who seeds static providers? | **Worker only** | Worker seeds on startup from `providers.yaml`. API reads from DB only. Single writer, no coordination needed. |
