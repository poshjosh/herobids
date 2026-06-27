# ADR — LLM Pricing Sourced from Database, Not Hardcoded

**Date:** 2026-06-27
**Status:** Proposed

## Context

`PROVIDER_DEFINITIONS` in `packages/domain/src/models/llm-models.ts` hardcodes ~120
model prices across 6 providers into a TypeScript constant. This object feeds both the
UI model catalog and the billing rate card seeding (`getLlmModelRateCardItems()`).

For OpenRouter, a second code path (`fetchOpenRouterCatalog()`) fetches live pricing
from the API — but only for UI display. Billing continues to use the hardcoded static
prices. This means the UI and billing can diverge silently.

Updating any price requires a code change and deploy. New OpenRouter models appear in
the dynamic catalog but get no per-model billing rate, falling through to generic
catch-all defaults.

## Decision

**LLM provider pricing is stored in PostgreSQL and loaded at runtime.** Hardcoded
pricing data is removed from application code.

Specifically:

1. A new `llm_pricing_snapshots` table stores provider → model → pricing as JSONB.
   Each row is a timestamped snapshot. The latest `is_active = true` row per provider
   is the current pricing source.

2. Provider metadata (IDs, catalog mode, fetch URLs, whether multi-provider) moves
   to `config/providers.yaml`. This is operator config, validated at startup, and
   changes only with deploys.

3. Static providers (OpenAI, Anthropic, DeepSeek, Google) embed their model pricing
   directly in `config/providers.yaml`. On startup, the app upserts this data into
   `llm_pricing_snapshots` if no active row exists. The YAML is the single source of
   truth — the DB is a runtime cache. No pricing data lives in migrations.

4. Dynamic providers (OpenRouter) are fetched periodically by the worker, written
   to `llm_pricing_snapshots` as new active rows. The API reads pricing from the DB
   instead of making its own HTTP fetch, eliminating code duplication.

5. Rate card seeding (`seedDefaultRateCardItems`) reads from `llm_pricing_snapshots`
   instead of calling `getLlmModelRateCardItems()`. For static providers, the data
   originated from `config/providers.yaml`. For dynamic providers, it originated from
   the provider API.

6. Production continues to expose only `catalogMode: 'dynamic'` providers. Static
   providers remain dev-only. This is unchanged — static pricing still requires a
   deploy to update, so the freshness guarantee is the same as before.

## Rationale

1. **Data/code separation.** 180 lines of pricing data do not belong in TypeScript
   source. The `PROVIDER_DEFINITIONS` constant is removed entirely.

2. **Single source of truth.** `config/providers.yaml` is the authoritative baseline
   for all provider metadata and static pricing. The DB stores runtime state. They
   cannot drift because the YAML is the only place data is authored.

3. **Price history.** Every dynamic fetch creates a new snapshot row. Price changes
   are auditable. Dispute resolution ("what was the price on June 15th?") is a
   SQL query, not a git blame on a stale constant.

4. **Zero-deploy dynamic pricing.** OpenRouter prices refresh automatically. The
   worker fetches, validates, and stores. The billing system reads the latest
   snapshot. No human intervention, no deploy.

5. **No new infrastructure.** The project already runs PostgreSQL with 22 Drizzle
   migrations. One new table and one new config file. No Docker volume mounts,
   no `.gitignore`/`.dockerignore` changes, no filesystem bootstrap logic.

6. **Simpler API catalog.** The API's `llm-model-catalog.ts` currently contains
   ~80 lines of HTTP fetch, in-memory caching, and cache staleness logic for
   OpenRouter. This collapses to a DB read. The `deriveLatestVariants` enrichment
   stays (presentation concern).

## Consequences

- `PROVIDER_DEFINITIONS` and all hardcoded pricing removed from `packages/domain/src/models/llm-models.ts`
- New schema: `llm_pricing_snapshots` table + migration
- New config: `config/providers.yaml` (provider metadata + static pricing)
- `seedDefaultRateCardItems()` reads from `llm_pricing_snapshots` instead of `getLlmModelRateCardItems()`
- Worker gains periodic OpenRouter pricing fetch → DB upsert
- API `llm-model-catalog.ts` replaces inline HTTP fetch with DB read for OpenRouter
- `estimateLlmCostUsd()` in agent runtime is NOT addressed (separate follow-up)
- All existing helpers (`getLlmModelPricing`, `getLlmProviderModels`, etc.) are refactored
  to accept data as parameters rather than reading a global constant
