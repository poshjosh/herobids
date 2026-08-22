# ADR — Eliminate Static LLM Provider Pricing

**Date:** 2026-07-06
**Status:** Proposed
**Supersedes:** [010-llm-pricing-data-not-hardcoded.md](../06/010-llm-pricing-data-not-hardcoded.md) (partial — replaces decision #3 and #6)

## Context

ADR 010 moved LLM pricing out of hardcoded TypeScript constants into a database-backed
architecture. However, it left a critical gap: providers other than OpenRouter (OpenAI,
Anthropic, DeepSeek, Google) still rely on **static prices embedded in `config/providers.yaml`**,
seeded to the DB once at startup and never refreshed.

This is a business risk:

- **Price cuts go uncaptured.** If OpenAI drops GPT-5.5 from $5/$30 to $2/$10 per 1M tokens,
  we continue charging users at the stale rate. Trust erodes.
- **Price hikes create losses.** If a provider raises prices, we eat the difference until
  someone notices and deploys a YAML update.
- **New models have no pricing.** A model added to a static provider requires a code deploy
  to appear with a price.

ADR 010 acknowledged this by restricting production to `catalogMode: 'dynamic'` providers
only (effectively just OpenRouter). Static providers were labeled "dev-only." But this is a
workaround, not a solution — it prevents users from bringing their own API keys for direct
providers and using them through the platform with accurate billing.

OpenRouter's pricing API already returns per-model pricing for **all** upstream providers
(OpenAI, Anthropic, DeepSeek, Google, and dozens more). We already fetch this data hourly
into `llm_pricing_snapshots`. The data is there — we're just not using it for direct providers.

## Decision

**All LLM provider pricing is dynamic.** No model price lives in `config/providers.yaml`
or any other static file. The `llm_pricing_snapshots` table (populated by the hourly
OpenRouter fetch) is the single source of pricing truth for every provider.

Specifically:

1. **OpenRouter pricing is the universal pricing source.** OpenRouter's model catalog
   includes pricing for models from all major providers, keyed as `openai/gpt-5.5`,
   `anthropic/claude-sonnet-4-6`, etc. When a user selects a direct provider (e.g. `openai`),
   the API cross-references the OpenRouter snapshot to find pricing for models matching
   that provider's prefix.

2. **Hardcoded model prices are removed from `config/providers.yaml`.** Static providers
   (openai, anthropic, deepseek, google) retain only metadata: `catalogMode`, `baseUrl`,
   `devOnly`, `isMultiProvider`. The `models` key is kept as an **optional allowlist**:
   if non-empty, only listed models appear (intersected with OpenRouter-derived models);
   if empty (`{}`), all OpenRouter-indexed models for that provider appear automatically.

3. **Provider visibility is gated on three conditions, ALL of which must pass:**
   - **API key configured:** The environment variable `LLM_API_KEY_<PROVIDER>` (uppercased)
     must be set. Providers without a configured key are hidden from the catalog.
   - **Pricing available:** An active `llm_pricing_snapshots` row must exist for the
     provider, or — for non-OpenRouter providers — pricing for that provider's models
     must be derivable from the OpenRouter snapshot.
   - **Locality match:** Providers marked `devOnly: true` (ollama) only appear when
     the runtime is on a local host (localhost, 127.0.0.1, etc.), determined by hostname
     inspection, not `NODE_ENV`.

4. **If only one provider survives all filters, the UI hides the provider selector.**
   The user sees only the model selector, pre-populated with that provider's models.
   The provider is implied.

5. **No stale fallback.** If the OpenRouter pricing snapshot is unavailable (worker
   hasn't fetched yet, or OpenRouter is down), non-OpenRouter providers are hidden
   entirely. We never fall back to YAML-embedded prices. OpenRouter itself can use
   its own snapshot — the worst case is the worker hasn't run yet after a cold start,
   in which case no providers appear and the system surfaces a clear error.

6. **Rate card seeding continues to read from `llm_pricing_snapshots`**, same as today.
   The change is that the snapshot now covers all providers, not just OpenRouter.

## Resolved Design Decisions

The following questions were raised during ADR review and resolved:

| # | Question | Decision |
|---|----------|----------|
| 1 | OpenRouter pricing includes their margin — direct-provider users would be billed at a marked-up rate. Accept or adjust? | **Accept the discrepancy.** OpenRouter pricing is the universal reference rate. Billing at the reference rate regardless of routing path is simple and conservative (we don't undercharge). Revisit if user feedback or competitive pressure warrants it. |
| 2 | Cold start: before the first worker fetch, zero providers appear. Acceptable? | **Yes.** This only occurs on the very first deploy to a fresh database. On all subsequent deploys, active pricing snapshots persist in Postgres. The window is seconds-long, and the API returns a clear `503` error. |
| 3 | Keep `models` in YAML as an allowlist, or expose all OpenRouter-indexed models? | **Keep as optional allowlist.** Non-empty `models` = intersect with OpenRouter-derived models. Empty `models` (`{}`) = show all. Operator control without constant YAML updates. |
| 4 | During migration, if a provider has both inline YAML prices AND an OpenRouter snapshot, which wins? | **OpenRouter snapshot wins.** Dynamic data is always fresher. Inline YAML prices serve only as a temporary fallback during the migration window, then are removed entirely in Phase 6. |

## Rationale

1. **Business safety.** Prices that affect our margin or our users' bills cannot be
   static. Every hour of staleness is a window for financial error.

2. **Data already exists.** We already fetch OpenRouter pricing hourly into the DB.
   OpenRouter's response includes pricing for hundreds of models across all major
   providers. The data we need is already in our database — we're just not querying it
   for direct providers.

3. **Single source of truth.** One table, one fetch schedule, one code path. No
   dual-path bugs where YAML says one price and OpenRouter says another.

4. **Users can bring their own keys.** Removing the "static = dev-only" restriction
   means users can configure their own OpenAI/Anthropic API keys, route through the
   platform, and get accurately billed. This is a product unlock.

5. **No new infrastructure.** No new external API calls, no new tables, no new worker
   loops. The OpenRouter fetch is already running. We change how we read the data
   it produces.

6. **Graceful degradation.** If OpenRouter is down, the platform surfaces unavailability
   rather than serving stale prices. This is the safe failure mode for a financial
   product.

## Consequences

### What changes

- `config/providers.yaml`: model prices removed from openai, anthropic, deepseek, google
  entries. Only metadata remains. The `models` key becomes optional; an empty `models: {}`
  signals "pricing is derived from OpenRouter snapshot."
- `apps/api/src/llm-model-catalog.ts`:
  - `getAvailableProviders()` gains API key gating and locality gating.
  - `getProviderCatalogEntry()` gains cross-reference logic: for a non-OpenRouter
    provider, query the OpenRouter snapshot for models matching `<provider>/<modelId>`
    and derive pricing metadata.
  - The fallback to YAML-embedded prices for static providers is removed.
- `apps/worker/src/`: static provider seeding logic (`seedStaticPricing`) is removed.
  The OpenRouter fetch becomes the sole pricing data pipeline.
- `apps/web/src/features/settings/ModelSelectionFields.tsx`:
  - `resolveDefaultModelSelection()` gains single-provider detection: when exactly one
    provider is available, auto-select it and suppress the provider dropdown.
- `packages/domain/src/models/llm-models.ts`:
  - `ProviderConfigSchema` relaxes: models can be empty for non-OpenRouter, non-ollama
    providers (pricing comes from DB cross-reference).
  - The refine check ("static providers must have inputUsdPerM and outputUsdPerM for
    every model") is removed or relaxed.

### What stays the same

- `llm_pricing_snapshots` table and schema — no changes.
- Worker OpenRouter pricing fetch — no changes to the fetch loop, only the seeding code
  that runs alongside it is removed.
- Rate card seeding from DB snapshots — no changes.
- `deriveLatestVariants` enrichment for OpenRouter — no changes.
- Ollama handling — unchanged (local discovery, Free pricing label).

### What is explicitly out of scope

- Fetching pricing directly from OpenAI/Anthropic/Google APIs. OpenRouter is the single
  upstream pricing source. Direct provider API pricing fetches would add complexity
  (N different API formats, N different auth schemes, N different rate limits) for
  marginal benefit — OpenRouter's pricing is already the market reference.
- `estimateLlmCostUsd()` in the agent runtime — still uses a heuristic. Tracked separately.
- Admin UI for managing pricing data — future feature.
