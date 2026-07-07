# CoinMarketCap Env Key, Registry Parity, and Doc Fixes

## Background

CoinMarketCap is fully implemented: client, discovery fan-out, enrichment pass, provider registry, config schema, and startup validation are all in place. However, three gaps remain relative to the Birdeye provider (which was implemented after CMC):

1. No `COINMARKETCAP_API_KEY` env override in the config loaders or `.env.example`. The API key can only be set via YAML. Birdeye has `BIRDEYE_API_KEY`.
2. The provider registry has a safety-net throw for Birdeye (`'Birdeye is enabled but no API key is configured'`) but not for CMC. The schema catches it at startup in the normal config load path, but the agent runtime in `apps/worker/src/agent.ts` does `JSON.parse(...) as MarketDataConfig` without re-validating, leaving a gap.
3. Two architecture docs are stale:
   - `docs/tech/architecture/market-data.md` claims both CMC and Birdeye have "a safety-net throw in the provider registry" — currently only Birdeye does.
   - Same file lists "Birdeye is present in config/types but not wired" in Known Gaps — Birdeye has been wired and implemented.
   - `docs/tech/market-data/market-data-discovery-diversification-knobs.md` has no `coinMarketCap.*` section despite CMC being a live opt-in discovery and enrichment provider.

## Scope

### In scope

- `apps/worker/src/config.ts` — add `COINMARKETCAP_API_KEY` env override
- `apps/api/src/config.ts` — add `COINMARKETCAP_API_KEY` env override
- `.env.example` — document the new env var next to `BIRDEYE_API_KEY`
- `config/default.yaml` — add override comment to `coinMarketCap.apiKey`
- `packages/market-data/src/provider-registry.ts` — add safety-net throw for CMC (parity with Birdeye)
- `apps/worker/src/config.test.ts` — add env override tests for `COINMARKETCAP_API_KEY`
- `apps/api/src/config.test.ts` — add env override tests for `COINMARKETCAP_API_KEY`
- `docs/tech/architecture/market-data.md` — fix the inaccurate registry safety-net claim and remove the stale Birdeye Known Gap entry
- `docs/tech/market-data/market-data-discovery-diversification-knobs.md` — add `marketData.coinMarketCap.*` section and a quick-reference row

### Out of scope

- Any changes to CMC client logic, discovery logic, or enrichment logic
- Any changes to the Birdeye provider or its wiring
- Any new API endpoints or UI changes

## Constraints

### The registry safety-net throw must be structurally identical to Birdeye's

The existing Birdeye guard is:
```ts
// Birdeye is opt-in — enabled without an API key is a loud startup error
const birdeyeConfig: BirdeyeConfig | undefined = config.birdeye.enabled
  ? (() => {
      if (!config.birdeye.apiKey) {
        throw new Error('Birdeye is enabled but no API key is configured');
      }
      ...
    })()
  : undefined;
```

The CMC guard must follow the same pattern so the two providers behave identically under invalid config.

### Env override must preserve existing YAML values when the env var is absent or empty

This is the established behavior for `BIRDEYE_API_KEY`, tested in `apps/worker/src/config.test.ts`. The same semantics apply: if `COINMARKETCAP_API_KEY` is set to a non-empty string, it overwrites YAML; if it is empty or unset, the YAML value is preserved.

### No changes to the schema Zod validation

The schema in `packages/domain/src/config/schema.ts` already enforces `enabled + empty apiKey → startup error`. That invariant is not changing — the registry guard adds a second layer for the un-validated runtime path, not a replacement.

## Plan

### 1. Add `COINMARKETCAP_API_KEY` env override

**Files:** `apps/worker/src/config.ts`, `apps/api/src/config.ts`

In the `ENV_OVERRIDES` map in each file, add the entry immediately after `BIRDEYE_API_KEY`:

```ts
COINMARKETCAP_API_KEY: { path: 'marketData.coinMarketCap.apiKey', type: 'string' },
```

Dependency: none.

---

### 2. Document the new env var

**Files:** `.env.example`, `config/default.yaml`

In `.env.example`, extend the "Market data providers" block:

```
# required when marketData.coinMarketcap.enabled is true; https://coinmarketcap.com/api/
COINMARKETCAP_API_KEY=
```

Place it directly below the existing Birdeye entry.

In `config/default.yaml`, change:

```yaml
    apiKey: ""
```

to:

```yaml
    apiKey: ""                # override: COINMARKETCAP_API_KEY — required when coinMarketCap.enabled is true
```

Dependency: step 1.

---

### 3. Add safety-net throw in the provider registry

**File:** `packages/market-data/src/provider-registry.ts`

The current CMC block:

```ts
  // CMC is opt-in — only build config when explicitly enabled
  const cmcConfig: CoinMarketCapConfig | undefined = config.coinMarketCap.enabled
    ? (() => {
        const cmcBudget: SharedBudgetConfig = { ... };
        return {
          baseUrl: config.coinMarketCap.baseUrl,
          apiKey: config.coinMarketCap.apiKey,
          ...
        };
      })()
    : undefined;
```

Becomes:

```ts
  // CMC is opt-in — enabled without an API key is a loud startup error
  const cmcConfig: CoinMarketCapConfig | undefined = config.coinMarketCap.enabled
    ? (() => {
        if (!config.coinMarketCap.apiKey) {
          throw new Error('CoinMarketCap is enabled but no API key is configured');
        }
        const cmcBudget: SharedBudgetConfig = { ... };
        return {
          baseUrl: config.coinMarketCap.baseUrl,
          apiKey: config.coinMarketCap.apiKey,
          ...
        };
      })()
    : undefined;
```

Dependency: none.

---

### 4. Add env override tests

**Files:** `apps/worker/src/config.test.ts`, `apps/api/src/config.test.ts`

Mirror the existing Birdeye tests in each file. Three tests per file:

1. `applies COINMARKETCAP_API_KEY env override without clobbering YAML defaults` — sets `process.env['COINMARKETCAP_API_KEY']` to a value, asserts `config.marketData?.coinMarketCap.apiKey` equals that value, and asserts `enabled` is still `false`.

2. `preserves YAML CoinMarketCap apiKey when the env override is empty` — YAML has a non-empty `apiKey`, env var is `''`, asserts the YAML value is preserved.

3. `COINMARKETCAP_API_KEY overrides YAML apiKey when coinMarketCap is enabled` — YAML has `enabled: true` with a key, env overrides it; asserts the env value wins.

Dependency: step 1.

---

### 5. Fix stale architecture docs

**File:** `docs/tech/architecture/market-data.md`

**Change A** — correct the safety-net claim (currently says "safety-net throw in the provider registry" for both CMC and Birdeye; this becomes accurate once step 3 is done, so no doc change needed after step 3 is applied — the existing text becomes accurate).

Actually, after step 3 is complete this sentence in the doc becomes accurate:

> CoinMarketCap and Birdeye are opt-in and fail-soft; enabled-without-API-key is a loud startup error caught by both Zod schema validation and a safety-net throw in the provider registry

No doc change needed for that sentence — implementing step 3 makes it true.

**Change B** — remove the stale Known Gaps entry:

Remove:
> 1. Birdeye is present in config/types but not wired into the provider registry.

And re-number the remaining entries (2 → 1, 3 → 2, 4 → 3).

Also remove the stale Update Checklist item at the bottom:
> - a currently planned provider such as Birdeye becomes real

Dependency: none.

---

### 6. Update the diversification-knobs doc

**File:** `docs/tech/market-data/market-data-discovery-diversification-knobs.md`

**Change A** — add a quick-reference row for CoinMarketCap:

```markdown
| Add CoinMarketCap cross-chain discovery and enrichment | Set `marketData.coinMarketCap.enabled: true` | Requires a CoinMarketCap API key; adds trending and new-listing tokens cross-chain, plus a post-merge enrichment pass |
```

Insert after the Birdeye row in the quick-reference table.

**Change B** — add a `marketData.coinMarketCap.*` section after the Birdeye section:

```markdown
### `marketData.coinMarketCap.*` (cross-chain, opt-in)

CoinMarketCap is an optional paid provider that contributes two things: discovery fan-out (trending and new listings, cross-chain) and a post-merge enrichment pass that fills market cap, FDV, holder count, and CEX listing metadata on already-discovered tokens.

| Knob | Default | Effect |
|---|---|---|
| `coinMarketCap.enabled` | `false` | When `true`, CMC trending and new listings are included in the discovery fan-out, and a CMC enrichment pass runs after merge/filter/sort. Requires a valid `apiKey`. |
| `coinMarketCap.apiKey` | `""` | CoinMarketCap API key. If `enabled` is `true` and this is empty, the worker fails to start with a clear error. Set via `COINMARKETCAP_API_KEY` env var. |
| `coinMarketCap.requestsPerMinute` | `30` | Rate ceiling shared across the discovery (trending, new listings) and enrichment (quotes batch) endpoints. The free tier allows ~10 K calls/month; 30 req/min is conservative. |
| `coinMarketCap.cacheTtlMs` | `3600000` (1 hr) | TTL for CMC discovery results. Also influences the aggregate discovery cache TTL (the registry takes the minimum across enabled providers). |
```

Dependency: none.

---

## Test Strategy

- `apps/worker/src/config.test.ts` — new env override tests (step 4)
- `apps/api/src/config.test.ts` — new env override tests (step 4)
- Existing `packages/market-data/src/provider-registry.test.ts` already has a test that CMC is skipped when disabled — extend it with an assertion that `createProviderRegistry` throws when `enabled: true` and `apiKey: ''`
- Validation command: `pnpm test && pnpm lint`

## Exit Criteria

- `COINMARKETCAP_API_KEY` env var sets `marketData.coinMarketCap.apiKey` in both worker and API config loaders.
- Empty or absent `COINMARKETCAP_API_KEY` preserves the YAML value.
- `createProviderRegistry` throws with a clear message when CMC is enabled and apiKey is empty.
- The architecture doc no longer lists Birdeye as unwired and no longer has the stale Update Checklist item.
- The diversification-knobs doc has a CMC quick-reference row and a full `coinMarketCap.*` knobs section.
- `pnpm test && pnpm lint` passes.
