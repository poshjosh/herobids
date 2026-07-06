# 001 — Watch Token Discovery and Pin

**Status:** Draft  
**Created:** 2026-06-25  
**Scope:** Allow `watch_token` to accept `chain: "any"` safely by resolving a concrete asset identity once at watch creation time and pinning all later repricing to that identity.

## Problem

`get_price` and `watch_token` currently share the same chain vocabulary, including `any`.

That is valid for `get_price` because it is a one-shot lookup: asking for the best current market match across supported DEX chains is acceptable when the caller only needs a single answer.

It is not valid for `watch_token` because a watch is long-lived. The current `watch_token` flow stores only `symbol` and `chain`, then re-runs price resolution later during watch evaluation. When `chain` is `any`, the price service searches across chains and picks the highest-liquidity match at that moment. If market liquidity shifts, the same watch can silently drift from one asset identity to another between checks.

Examples:

- A watch created for `PEPE` on `any` may initially resolve to Solana, then later evaluate against Base if Base liquidity becomes higher.
- A watch created for `USDC` on `any` may track a different chain instance over time even though the user intended one concrete token.
- A triggered alert can become non-actionable because the reported watch target is a moving search result rather than a pinned asset.

This violates the meaning of a watch. A watch must monitor one stable asset identity over time.

## Goal

Keep the ergonomic benefit of `chain: "any"` for watch creation, but convert that request into a stable, concrete identity at creation time.

After this feature:

- `watch_token` may accept `chain: "any"` for spot-token discovery.
- The system resolves the request once to a concrete chain and asset identity.
- The stored watch pins later checks to that concrete identity.
- `check_watches` never re-runs ambiguous cross-chain search for an already-created watch.
- `get_price` keeps its current one-shot `any` behavior.

## Non-Goals

- Do not change the meaning of `get_price` for existing callers.
- Do not add a new database table or SQL migration; watch state remains Redis-backed JSON.
- Do not implement a user-facing picker or interactive disambiguation flow.
- Do not broaden `any` to mean cross-venue resolution that includes Hyperliquid perps.
- Do not silently infer a pinned identity for existing stored watches without a defined migration strategy.

## Solution Outline

Introduce a first-class price-resolution API that can return both price metadata and the concrete asset identity chosen by the resolver.

`watch_token` will use that resolver when the caller supplies `chain: "any"`.

The watch entry will persist:

- the caller-requested chain
- the resolved chain actually chosen
- the resolved address when available

All future repricing for that watch will use the resolved identity, not the original ambiguous request.

This preserves the convenience of discovery while making the watch deterministic.

## Why This Is the Clean Version

There are two implementation shapes:

1. Tool-local shortcut: call DexScreener search directly inside `watch_token`, choose the best result, and persist that.
2. Clean version: teach the market-data layer to resolve and return identity, then let tools consume that shared abstraction.

This plan chooses the second approach.

Rationale:

- Asset-selection logic already lives conceptually in the price service.
- Re-implementing selection rules in the watch tool would duplicate market-data behavior and drift over time.
- A shared resolver is easier to test, easier to reuse, and keeps tool code thin.
- Future tools that need “discover once, then act on exact identity” can use the same API.

## Design Decisions

### D1: Add a dedicated resolution API instead of overloading `getPrice`

**Decision:** Extend the price-service abstraction with a new identity-aware method rather than changing the semantics of `getPrice`.

Suggested interface shape:

```typescript
export interface ResolvedPriceLookupResult {
  requestedSymbol: string;
  requestedChain: string;
  resolvedSymbol: string;
  resolvedChain: string;
  resolvedAddress?: string;
  priceUsd: number;
  source: PriceSource;
  fetchedAt: string;
  stale: boolean;
}

export interface PriceService {
  getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult>;
  resolvePrice(symbol: string, chain: string, address?: string): Promise<
    | { ok: true; data: ResolvedPriceLookupResult }
    | { ok: false; error: PriceLookupError }
  >;
}
```

`getPrice` remains a lightweight compatibility method. Internally it can delegate to `resolvePrice` and project away the extra identity fields.

**Rationale:**

- Preserves current callers and behavior.
- Makes identity selection explicit instead of hidden in price-only data.
- Keeps the watch flow honest about whether it is performing discovery or exact repricing.

### D2: `chain: "any"` remains allowed for watch creation, but only as a request-time input

**Decision:** `watch_token` may accept `chain: "any"`, but a persisted watch must never remain ambiguous after successful creation.

If the resolver succeeds, the stored watch pins concrete fields.

If the resolver cannot produce one clear best match, watch creation fails with a deterministic error.

**Rationale:**

- Preserves the agent UX that motivated the change.
- Ensures the stored watch always means “watch this exact asset.”

### D3: Persist requested identity separately from resolved identity

**Decision:** Store both the caller’s requested values and the resolved values in the watch entry.

Suggested shape:

```typescript
interface WatchEntry {
  watchId: string;
  symbol: string;
  chain: string;
  resolvedSymbol?: string;
  resolvedChain?: string;
  resolvedAddress?: string;
  thresholdPrice: number;
  condition: 'above' | 'below';
  note?: string;
  createdAt: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
}
```

Semantics:

- `symbol` / `chain`: what the caller asked for.
- `resolvedSymbol` / `resolvedChain` / `resolvedAddress`: what the resolver pinned.

**Rationale:**

- Improves observability and debugging.
- Avoids losing the original request context.
- Supports future UI or journal messages that show both intent and resolution.

### D4: Repricing must prefer pinned identity over requested values

**Decision:** `check_watches` and initial watch state hydration use pinned identity when available.

Lookup rules:

1. If `resolvedAddress` exists, use `resolvedSymbol`, `resolvedChain`, and `resolvedAddress`.
2. Else if `resolvedChain` exists, use `resolvedSymbol` and `resolvedChain`.
3. Else fall back to legacy `symbol` and `chain`.

**Rationale:**

- Guarantees watch stability for new entries.
- Preserves compatibility for legacy entries already stored before the feature.

### D5: Existing stored `any` watches should be handled explicitly, not silently guessed

**Decision:** Treat legacy watches without pinned identity as a migration case.

Short-term behavior for legacy ambiguous entries:

- If `chain !== 'any'`, continue to use the legacy fields as before.
- If `chain === 'any'` and no resolved fields exist, mark the watch as unchecked with a reason such as `watch_requires_repin` or fail the check with a descriptive reason.

Do not silently re-resolve on every check.

**Rationale:**

- Silent reprovisioning recreates the exact ambiguity this feature is meant to remove.
- Explicit handling surfaces operational debt cleanly.

### D6: Hyperliquid remains explicit-only for watch creation

**Decision:** `any` resolution is only for DEX spot-style lookups. It must not imply “search Hyperliquid and all spot chains together.”

`hyperliquid` remains an explicit chain choice.

**Rationale:**

- Current `any` semantics already map to DexScreener-style cross-chain search, not cross-venue discovery.
- Mixing perps and spot assets into one disambiguation flow would add policy and ambiguity.

### D7: Resolver tie-breaking continues to use existing highest-liquidity preference

**Decision:** The clean implementation preserves the current best-match rule for `any`: choose the highest-liquidity candidate when no explicit address is supplied.

The key change is not the selection heuristic; it is when the selection happens and what gets persisted afterward.

**Rationale:**

- Reuses established behavior.
- Minimizes surprise for current `get_price` callers.

## Proposed API and Data Changes

### 1. `packages/market-data/src/price-service.ts`

Add:

- a `ResolvedPriceLookupResult` type
- a `resolvePrice(...)` method on `PriceService`
- internal helpers that return both price and selected identity

The resolver should surface the chosen token’s:

- canonical symbol from the provider result
- concrete network / chain
- concrete address when present

### 2. `packages/domain/src/tools.ts`

Extend `ToolContext.priceService` to expose `resolvePrice(...)` in addition to `getPrice(...)`.

This keeps worker tools decoupled from raw provider details.

### 3. `apps/worker/src/tools/watch.ts`

Change watch creation to:

- validate the input
- call `resolvePrice` when a price service exists
- pin the returned identity into the stored watch entry
- compute the initial threshold state from the resolved result

Change watch evaluation to:

- use pinned fields when present
- never re-run an ambiguous `any` search for a pinned watch
- flag legacy ambiguous watches rather than drifting them

### 4. Redis watch payload

No storage migration is required. Redis watch entries are JSON blobs, so adding optional fields is safe.

## Implementation Plan

### Step 1: Introduce resolved-identity result types in market-data

Files:

- `packages/market-data/src/price-service.ts`
- `packages/market-data/src/index.ts`

Tasks:

- Define `ResolvedPriceLookupResult`.
- Define a result union for `resolvePrice` parallel to existing `PriceResult`.
- Export the new types from the market-data package.
- Keep `PriceSource` and `PriceLookupError` unchanged unless new error codes are required.

Acceptance for step:

- New types compile.
- No caller behavior changes yet.

### Step 2: Refactor price-service internals so selection returns identity and price together

Files:

- `packages/market-data/src/price-service.ts`

Tasks:

- Extract the DexScreener selection path so it returns the selected token identity in addition to price metadata.
- Preserve current exact-address behavior when `address` is supplied.
- Preserve current highest-liquidity behavior when `address` is absent.
- Preserve Hyperliquid behavior for explicit `hyperliquid` requests.
- Decide whether Hyperliquid fallback to DexScreener `any` should set `resolvedChain` to `hyperliquid` or to the oracle chain actually used. The recommended behavior is:
  - explicit Hyperliquid execution success: resolvedChain = `hyperliquid`
  - Hyperliquid fallback to oracle: resolvedChain = actual DEX network returned by the oracle result

Acceptance for step:

- `resolvePrice('PEPE', 'any')` can return the chosen network and address.
- `resolvePrice('PEPE', 'solana', '0xdiscovered')` preserves exact-address identity.
- `getPrice(...)` still returns the same payload as before.

### Step 3: Expose `resolvePrice` through the tool context contract

Files:

- `packages/domain/src/tools.ts`
- any worker-side construction/wiring files that build `ToolContext`

Tasks:

- Extend the domain-facing `priceService` contract with `resolvePrice(...)`.
- Update worker runtime wiring to pass through the new method from the concrete market-data service.
- Keep existing `getPrice(...)` consumers untouched.

Acceptance for step:

- Worker tools can call `ctx.priceService.resolvePrice(...)`.
- Existing tooling compiles without semantic changes.

### Step 4: Add pinned identity fields to watch entries and lookup helpers

Files:

- `apps/worker/src/tools/watch.ts`

Tasks:

- Extend `WatchEntry` with `resolvedSymbol`, `resolvedChain`, and `resolvedAddress`.
- Add a helper such as `getPinnedLookupTarget(watch)` that returns the identity to use for repricing.
- Update summary and serialization paths only as needed; do not broaden summary scope unnecessarily.

Acceptance for step:

- New watches may carry pinned fields.
- Old watches still parse successfully.

### Step 5: Change `watch_token` creation flow to discover once and pin

Files:

- `apps/worker/src/tools/watch.ts`

Tasks:

- If `ctx.priceService` exists, call `resolvePrice(...)` during watch creation instead of `getPrice(...)`.
- For explicit chains, still record resolved fields so all new watches use one consistent model.
- For `chain: 'any'`, require a successful resolution before persisting the watch.
- Copy the resolved price into the initial threshold-state calculation.
- Return both requested and resolved identity in tool output when useful, for example:

```typescript
data: {
  ok: true,
  watchId,
  symbol: requestedSymbol,
  chain: requestedChain,
  resolvedChain,
  resolvedAddress,
}
```

Acceptance for step:

- New `any` watches are persisted with concrete pinned identity.
- New explicit-chain watches also gain pinned identity metadata.

### Step 6: Change `check_watches` to use pinned identity and reject legacy ambiguous entries cleanly

Files:

- `apps/worker/src/tools/watch.ts`

Tasks:

- Build lookup keys from pinned identity when present.
- Use `resolvedAddress` to force exact-identity repricing when available.
- For legacy watches with `chain === 'any'` and no pinned identity, do not silently perform fresh cross-chain discovery.
- Instead, add them to `unchecked` with a clear reason such as `watch created before identity pinning; recreate watch with explicit chain or pinned resolution`.

Acceptance for step:

- Pinned watches remain stable even if search ranking changes later.
- Legacy ambiguous watches are surfaced as operational cleanup items rather than drifting.

### Step 7: Improve tool descriptions and validation messages

Files:

- `apps/worker/src/tools/watch.ts`
- optionally `apps/worker/src/tools/price.ts` if wording needs alignment

Tasks:

- Update `watch_token` parameter descriptions to explain that `any` is resolved once and then pinned.
- Update errors so they distinguish between:
  - unsupported chain
  - ambiguous or unresolvable asset
  - legacy unpinned watch that cannot be safely checked

Acceptance for step:

- Agent-facing contract is explicit and self-consistent.

### Step 8: Add regression and contract tests

Files:

- `packages/market-data/src/price-service.test.ts`
- `apps/worker/src/tools/watch.test.ts`

Tasks:

Add market-data tests for:

- `resolvePrice` returns concrete network and address for `chain: 'any'`
- explicit-address lookups preserve exact address identity
- same-symbol multi-token search still chooses highest liquidity when no address is given
- `getPrice` remains backward-compatible after the refactor

Add watch-tool tests for:

- `watch_token` with `chain: 'any'` stores pinned `resolvedChain` and `resolvedAddress`
- `check_watches` reuses pinned identity instead of requested `any`
- a watch created from `any` does not switch targets when later search results reorder
- explicit-chain watches also store resolved identity when available
- legacy `chain: 'any'` watch without pinned fields is returned in `unchecked` with the new reason

Acceptance for step:

- The regression that motivated this feature is covered by tests that fail on the pre-fix behavior.

### Step 9: Validate and roll out

Commands:

- `pnpm exec vitest run packages/market-data/src/price-service.test.ts apps/worker/src/tools/watch.test.ts`
- `pnpm lint`

Optional follow-up:

- inspect active Redis watch entries in non-prod to see whether legacy `chain: 'any'` data already exists
- if it exists in meaningful volume, decide whether a one-off repair script is worthwhile

## Testing Strategy

### Unit tests — market-data

Primary file:

- `packages/market-data/src/price-service.test.ts`

Add cases for:

1. `resolvePrice('SOL', 'any')` returns the concrete selected network and address.
2. `resolvePrice('PEPE', 'solana', '0xdiscovered')` honors exact address identity.
3. `resolvePrice('PEPE', 'any')` chooses the highest-liquidity candidate when multiple networks share the symbol.
4. `getPrice('PEPE', 'any')` still returns only price payload and remains compatible with existing tests.
5. cache keys remain identity-safe when address is present.

### Unit tests — watch tool

Primary file:

- `apps/worker/src/tools/watch.test.ts`

Add cases for:

1. `watch_token` with `chain: 'any'` calls `resolvePrice` and stores pinned fields.
2. `watch_token` with explicit chain stores pinned fields when the resolver provides them.
3. `check_watches` reprices pinned watches using resolved identity, not requested `any`.
4. changing mock search ordering after watch creation does not change the watch target.
5. legacy unpinned `any` watch is reported as unchecked.

### Backward-compatibility checks

Even though backward compatibility is not a product requirement in general, this feature should avoid unnecessary damage to existing stored state.

Specifically verify:

- existing non-`any` watch entries without resolved fields continue to work
- existing list/remove flows continue to parse watch JSON without migration
- summary refresh does not break when optional pinned fields are absent

## File Change Summary

| File | Change type | Purpose |
|---|---|---|
| `packages/market-data/src/price-service.ts` | Extend/refactor | Add resolved-identity API and shared selection helpers |
| `packages/market-data/src/index.ts` | Extend | Export new resolver types/functions |
| `packages/domain/src/tools.ts` | Extend | Expose `resolvePrice` on tool-facing `priceService` |
| `apps/worker/src/tools/watch.ts` | Extend/refactor | Pin resolved identity at watch creation and reuse it during checks |
| `packages/market-data/src/price-service.test.ts` | Extend | Add resolution and compatibility tests |
| `apps/worker/src/tools/watch.test.ts` | Extend | Add discovery-and-pin regression tests |

## Risks and Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Resolver refactor accidentally changes `getPrice` behavior | Existing tools rely on current price-only semantics | Keep `getPrice` delegating to `resolvePrice` and assert compatibility in tests |
| Legacy `any` watches already exist in Redis | They remain ambiguous after deploy | Surface them as `unchecked`, then optionally repair or recreate them |
| Exact-identity repricing loses provider matches on some chains | Address/chain normalization may differ by network | Reuse existing normalization helpers and add explicit address tests |
| Hyperliquid fallback identity is confusing | Oracle fallback can return a non-Hyperliquid chain | Define and document fallback semantics in tests and tool output |
| Agent behavior still keeps submitting `any` without understanding pinning | Tool contract may remain opaque | Update descriptions and return resolved identity so the agent can see what was pinned |

## Operational Notes

- No SQL migration is required.
- Redis watch entries become forward-compatible via optional fields.
- If a non-trivial number of legacy `any` watches exists, create a follow-up operational task to inspect and repair them.
- If later product work needs explicit user disambiguation rather than “highest liquidity wins,” that should be a separate feature on top of this resolver.

## Open Questions

1. For an explicit `hyperliquid` request that falls back to the oracle path, should the stored resolved chain reflect the actual oracle network or remain `hyperliquid` for user-facing simplicity?
2. Should `watch_token` fail closed when `ctx.priceService` is unavailable and `chain === 'any'`, or should it refuse only ambiguous requests while still allowing explicit chains to be stored without initial price hydration?
3. Do we want to add a follow-up admin script to list or rewrite legacy ambiguous watch entries in Redis, or is surfacing them as unchecked sufficient?

## Effort Estimate

| Area | Effort |
|---|---|
| Price-service API and refactor | Medium |
| Tool-context contract update | Small |
| Watch-tool persistence and repricing changes | Medium |
| Tests and validation | Medium |
| **Total** | **~1 engineer day** |

## Exit Criteria

- `watch_token` can safely accept `chain: "any"` without creating drifting watches.
- New watches created from `any` persist a concrete pinned identity.
- `check_watches` uses pinned identity for repricing.
- Legacy ambiguous watches are surfaced explicitly rather than silently re-resolved.
- `get_price` behavior remains unchanged for existing callers.
- Focused tests pass for market-data and watch tools.
- `pnpm lint` passes.# 001 — Watch Token Discovery and Pinning

**Status:** Draft  
**Created:** 2026-06-25  
**Scope:** Preserve `get_price(chain="any")` for one-shot discovery while making `watch_token` stable over time by resolving once and pinning to a concrete asset identity.

## Problem

`get_price` and `watch_token` currently share the same chain vocabulary, including `any`.

That is correct for `get_price`: a one-shot lookup can search broadly, pick the best current match, and return a price.

That is not correct for `watch_token`: a watch is long-lived. It is created once, stored in Redis, and re-evaluated later by `check_watches`. Today a watch only stores `symbol` and `chain`. When `chain="any"`, each later price check re-runs cross-chain search and picks the highest-liquidity match at that moment. The watched asset can silently drift from one token or chain to another without the agent asking for that change.

The same root problem also exists, in weaker form, for explicit-chain ticker watches when multiple assets on the same chain share the same symbol. The current price service already supports exact-address repricing, but watch entries do not persist the resolved address, so they cannot take advantage of that stability.

## Goal

Make every new watch point at one stable asset identity for its full lifetime.

Specifically:

- `get_price(chain="any")` remains supported for discovery.
- `watch_token(chain="any")` resolves the requested asset once, then stores the concrete identity it chose.
- `check_watches` always re-prices the pinned identity, not a fresh ambiguous search.
- Existing stored watches are handled without a database migration.
- Price resolution logic lives in one shared abstraction, not duplicated inside the watch tool.

## Non-Goals

- Interactive disambiguation with multiple candidate choices.
- Changing the meaning of `get_price`.
- Introducing a new database table or SQL migration.
- Making `chain="any"` span both Hyperliquid perps and DEX spot assets in one unified search.
- Reworking the broader watch UX beyond the minimum schema and tool-response changes needed for correctness.

## Solution Outline

Introduce a first-class price-target resolution API in the market-data layer.

That API returns the chosen asset identity together with the current price snapshot:

- resolved symbol
- resolved chain
- resolved address when applicable
- price, source, freshness metadata

`watch_token` will call that API at creation time and persist the pinned identity in the watch entry. Later `check_watches` calls will use the pinned identity for lookups, including the exact address when available.

For old watch entries already stored in Redis, `check_watches` will lazily repair them the first time it sees them. Repaired watches are rewritten with pinned identity fields. Watches that cannot be repaired are returned as `unchecked` with an explicit reason instead of silently drifting.

## Design Decisions

### D1: Add a new resolution API instead of overloading `getPrice`

**Decision:** Extend the price service with a new method such as `resolveAsset` or `resolvePriceTarget` rather than changing `getPrice` to return identity metadata.

**Rationale:**

- `getPrice` already has a small, stable contract used by multiple tools.
- Resolution and pricing are related but not identical concerns.
- A dedicated resolver keeps the watch pinning workflow explicit and easier to test.
- The price tool can continue projecting the simple `getPrice` response while the watch tool uses the richer resolver.

### D2: Pin all newly created watches, not only `chain="any"` watches

**Decision:** Every new watch created through `watch_token` should attempt to persist pinned identity metadata, even when the request used an explicit chain.

**Rationale:**

- Explicit-chain ticker lookups can still be ambiguous when multiple tokens share the same symbol on one chain.
- The price service already supports exact-address repricing when an address is known.
- Pinning all new watches gives one consistent mental model: a watch follows one asset, not a search query.

### D3: Keep `symbol` and `chain` as the effective watched identity

**Decision:** In `WatchEntry`, `symbol` and `chain` remain the operational identity used for display and future checks. Add optional audit fields to preserve the original request when the resolved target differs.

**Proposed shape:**

```typescript
interface WatchEntry {
  watchId: string;
  symbol: string;              // effective pinned symbol used for display/repricing
  chain: string;               // effective pinned chain used for repricing
  address?: string;            // pinned token address when applicable
  requestedSymbol?: string;    // original user/agent input when different
  requestedChain?: string;     // original requested chain, including "any"
  thresholdPrice: number;
  condition: 'above' | 'below';
  note?: string;
  createdAt: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
}
```

**Rationale:**

- Existing summaries and list output already center on `symbol` and `chain`.
- Reusing those fields for the effective pinned identity minimizes downstream churn.
- `requestedChain="any"` can still be preserved for audit/debugging without keeping runtime semantics ambiguous.

### D4: `chain="any"` remains a DEX discovery mode, not a cross-venue mode

**Decision:** The clean implementation keeps `chain="any"` scoped to DEX/oracle discovery semantics. Hyperliquid remains an explicit chain choice.

**Rationale:**

- That matches the current price-service behavior.
- Hyperliquid prices come from a different execution-oriented source.
- Avoids turning this feature into a larger multi-venue resolution design.

### D5: Legacy watches are repaired lazily in `check_watches`

**Decision:** Do not create a separate migration job. Instead, repair old entries on read.

**Rules:**

- Legacy watch with missing `address` and explicit chain: attempt one-time resolution and rewrite the entry with pinned identity.
- Legacy watch with `chain="any"`: attempt one-time resolution, rewrite the entry to the resolved explicit chain plus address, and preserve `requestedChain="any"`.
- If repair fails, return the watch in `unchecked` with a reason such as `watch identity unresolved` and do not silently keep repricing an ambiguous search.

**Rationale:**

- Watches live in Redis JSON, so optional-field evolution is cheap.
- No SQL migration or one-off operator job is needed.
- The repair happens on the same execution path that already needs price service access.

### D6: Watch creation fails closed when identity cannot be resolved

**Decision:** `watch_token` should reject creation when it cannot resolve a stable target identity.

**Rationale:**

- A watch without stable identity is the exact bug this plan is fixing.
- Silent fallback to an unpinned watch would reintroduce the same defect.
- A clear tool error is better than storing an unreliable watch.

## Detailed Implementation Plan

### Step 1: Extend the market-data price service with a resolution contract

**Files:**

- `packages/market-data/src/price-service.ts`
- `packages/market-data/src/index.ts`
- `packages/domain/src/tools.ts`

Add a richer result type, for example:

```typescript
export interface ResolvedPriceTarget {
  symbol: string;
  chain: string;
  address?: string;
  name?: string;
  priceUsd: number;
  source: PriceSource;
  fetchedAt: string;
  stale: boolean;
}

export type ResolvePriceTargetResult =
  | { ok: true; data: ResolvedPriceTarget }
  | { ok: false; error: PriceLookupError };

export interface PriceService {
  getPrice(symbol: string, chain: string, address?: string): Promise<PriceResult>;
  resolvePriceTarget(symbol: string, chain: string, address?: string): Promise<ResolvePriceTargetResult>;
}
```

Update `ToolContext.priceService` in `packages/domain/src/tools.ts` to expose the new method.

**Notes:**

- Prefer `resolvePriceTarget` over `resolveAsset` if the team wants the name to stay clearly tied to price lookup semantics.
- Preserve the existing `getPrice` contract for current callers.

### Step 2: Refactor DexScreener selection into a reusable identity-aware helper

**Files:**

- `packages/market-data/src/price-service.ts`
- possibly `packages/market-data/src/dexscreener.ts` if helper extraction becomes cleaner there

Today the DexScreener path filters by chain, optionally filters by address, sorts by liquidity, and returns price only.

Refactor that logic so the chosen candidate can be reused by both:

- `getPrice` for one-shot price lookups
- `resolvePriceTarget` for discovery-and-pin

**Required behavior:**

- If `chain !== "any"`, filter candidates to that network.
- If `address` is provided, require exact address match.
- Otherwise choose the highest-liquidity candidate.
- Return the selected candidate's symbol, chain/network, address, and current price metadata.

**Hyperliquid behavior:**

- `resolvePriceTarget(symbol, "hyperliquid")` returns a target pinned to `chain="hyperliquid"`.
- It does not invent or store an on-chain address for the perp.
- If execution price succeeds, return execution metadata.
- If execution price falls back to oracle pricing internally, the identity remains `hyperliquid`; do not convert the watch into a DEX token watch.

### Step 3: Make `getPrice` delegate to the shared resolution logic where practical

**Files:**

- `packages/market-data/src/price-service.ts`

Update `getPrice` so it reuses the same asset-selection path instead of maintaining separate selection rules.

**Goal:** one source of truth for:

- chain filtering
- address matching
- highest-liquidity fallback
- error behavior for unresolved lookups

`getPrice` can still return the existing narrow result by projecting the richer resolved target down to `{ priceUsd, source, fetchedAt, stale }`.

### Step 4: Extend watch persistence schema with pinned identity fields

**Files:**

- `apps/worker/src/tools/watch.ts`
- any summary/helper types that consume watch entries

Update `WatchEntry` to include:

- `address?: string`
- `requestedSymbol?: string`
- `requestedChain?: string`

Keep all new fields optional so old Redis entries remain readable.

Update helpers accordingly:

- `watchLookupKey` should prefer `chain + address` when `address` exists.
- `toRuntimeActiveWatch` and summary generation should continue to work when the new fields are absent.
- If the runtime summary model can accept it without churn, include `address` or requested metadata for operator visibility; otherwise keep the summary unchanged for now.

### Step 5: Resolve and pin identity during `watch_token` creation

**Files:**

- `apps/worker/src/tools/watch.ts`
- `apps/worker/src/tools/watch.test.ts`

New flow for `watch_token`:

1. Validate the requested symbol and chain as today.
2. Require `ctx.priceService` and call `resolvePriceTarget(trimmedSymbol, requestedChain, addressIfInputIsAlreadyAddress)`.
3. If resolution fails, return a non-retryable tool error.
4. Construct the watch entry from the resolved target:
   - `symbol = resolved.symbol`
   - `chain = resolved.chain`
   - `address = resolved.address` when present
   - `requestedSymbol = trimmedSymbol` when it differs from `resolved.symbol`
   - `requestedChain = originalChain` when it differs from `resolved.chain` or when it was `any`
5. Initialize `lastConditionMet` and `lastCheckedAt` from the resolved target's current price snapshot.
6. Persist the watch.

**Tool response changes:**

Return both requested and resolved identity where useful, for example:

```typescript
{
  ok: true,
  watchId,
  symbol: watch.symbol,
  chain: watch.chain,
  address: watch.address,
  requestedSymbol: watch.requestedSymbol,
  requestedChain: watch.requestedChain,
  thresholdPrice,
  condition,
}
```

This makes it explicit to the agent that `chain="any"` was converted into one concrete watch target.

### Step 6: Add lazy repair for legacy watch entries in `check_watches`

**Files:**

- `apps/worker/src/tools/watch.ts`
- `apps/worker/src/tools/watch.test.ts`

Introduce a helper such as:

```typescript
async function ensurePinnedWatchIdentity(
  watch: WatchEntry,
  priceService: ToolContext['priceService'],
): Promise<
  | { ok: true; watch: WatchEntry }
  | { ok: false; reason: string }
>
```

**Behavior:**

- If `watch.address` already exists, return the watch unchanged.
- If the watch is legacy but has explicit chain and symbol, resolve once and rewrite it with pinned fields.
- If the watch is legacy and `chain="any"`, resolve once and rewrite it to the resolved explicit chain/address while preserving `requestedChain="any"`.
- If resolution fails, return a failure result and surface the watch through `unchecked`.

`check_watches` should persist repaired entries before or during the normal update flow so the repair only happens once.

### Step 7: Update repricing to always use pinned identity

**Files:**

- `apps/worker/src/tools/watch.ts`

Change price fetches in both creation-time initialization and `check_watches` evaluation to use:

- effective `watch.chain`
- effective `watch.symbol`
- pinned `watch.address` when present

Update deduplication so two same-symbol watches on the same chain but different addresses do not collapse into one lookup.

### Step 8: Update tool descriptions and validation text

**Files:**

- `apps/worker/src/tools/watch.ts`
- optionally `apps/worker/src/tools/price.ts` if the `get_price` description should clarify its discovery role more strongly

Update the watch tool description to explain:

- `chain="any"` is allowed for discovery convenience
- the tool resolves the asset once and pins the watch to the selected token
- the returned `chain` may be more specific than the requested chain

If useful, update `get_price` text to explicitly position it as the discovery step when the agent is unsure of the chain.

### Step 9: Add focused tests for resolution, pinning, and legacy repair

**Files:**

- `packages/market-data/src/price-service.test.ts`
- `apps/worker/src/tools/watch.test.ts`

#### Price-service tests

Add unit tests for `resolvePriceTarget` covering:

1. explicit-chain symbol lookup returns the selected candidate's address and chain
2. `chain="any"` returns the highest-liquidity cross-chain candidate
3. address input returns the exact matching candidate, not the highest-liquidity different token
4. Hyperliquid resolution keeps identity on `chain="hyperliquid"`
5. unresolved lookup returns `price.not_found`

#### Watch-tool tests

Add tests covering:

1. `watch_token(chain="any")` stores a pinned explicit chain and address
2. the tool response includes requested-vs-resolved identity when they differ
3. `check_watches` uses pinned address for repricing and does not switch to a higher-liquidity same-symbol token later
4. legacy explicit-chain watch with no address is lazily repaired on first check
5. legacy `chain="any"` watch is lazily repaired to an explicit chain/address
6. unreparable legacy watch is returned in `unchecked` with a clear reason

### Step 10: Validate with targeted and repo-wide checks

**Commands:**

- `pnpm exec vitest run packages/market-data/src/price-service.test.ts apps/worker/src/tools/watch.test.ts`
- `pnpm lint`

If the watch tool contract changes in a way that affects functional tests, add the narrowest worker-level or API-level follow-up checks needed. Otherwise keep validation scoped to the touched slices plus lint.

## Complete File Change Summary

| File | Change type | Purpose |
|---|---|---|
| `packages/market-data/src/price-service.ts` | Extend/refactor | Add `resolvePriceTarget`, unify selection logic, preserve `getPrice` |
| `packages/market-data/src/index.ts` | Extend | Export new types/functions if needed |
| `packages/domain/src/tools.ts` | Extend | Add `resolvePriceTarget` to `ToolContext.priceService` |
| `apps/worker/src/tools/watch.ts` | Extend/refactor | Persist pinned identity, lazily repair legacy watches, reprice by address |
| `apps/worker/src/tools/watch.test.ts` | Extend | Tests for pinning and legacy repair |
| `packages/market-data/src/price-service.test.ts` | Extend | Tests for resolution semantics |
| `apps/worker/src/tools/price.ts` | Optional docs-only tweak | Clarify discovery semantics if needed |

## Edge Cases

1. **Two same-symbol tokens on one chain**

   New watches resolve once and pin an address. Later checks cannot switch to the other token.

2. **Legacy watch with ambiguous ticker and no address**

   The first post-deploy `check_watches` run repairs it using the current selection rule and persists the result. If repair fails, the watch is surfaced as `unchecked` instead of drifting silently.

3. **Address-shaped input with explicit chain**

   Resolution should preserve the exact address and avoid any symbol-based ambiguity.

4. **`chain="any"` with no result**

   `watch_token` should fail and tell the agent the asset could not be resolved to a stable identity.

5. **Hyperliquid watch**

   Remains pinned to Hyperliquid identity without requiring an address.

6. **Cached stale price after resolution**

   Price freshness behavior remains unchanged. Pinning affects target identity, not cache policy.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Resolution logic diverges between `getPrice` and watch pinning | Centralize candidate selection in one helper and have both APIs use it |
| Legacy watches silently keep old ambiguous behavior | Fail repair loudly into `unchecked`; do not keep repricing `chain="any"` without pinning |
| Tool contract change ripples into unrelated callers | Keep `getPrice` unchanged and add a new `resolvePriceTarget` method rather than expanding the old response shape |
| Hyperliquid fallback accidentally turns into DEX identity | Keep Hyperliquid identity explicit even if price fallback uses oracle data internally |
| Watch summaries or list output become confusing after pinning | Preserve requested identity separately when it differs and include it in tool responses |

## Effort Estimate

| Step | Effort |
|---|---|
| 1. Price-service contract extension | Small |
| 2. Shared selection/refactor | Medium |
| 3. `getPrice` delegation cleanup | Small |
| 4. Watch schema extension | Small |
| 5. Watch creation pinning | Medium |
| 6. Legacy repair path | Medium |
| 7. Repricing + dedupe changes | Small |
| 8. Tool description updates | Small |
| 9. Tests | Medium |
| 10. Validation and cleanup | Small |
| **Total** | **~1 engineer day** |

## Dependencies

- No DB migration.
- No operator-config changes.
- Requires price service to be available wherever `watch_token` and `check_watches` run.

## Acceptance Criteria

- `get_price(chain="any")` still works as a one-shot discovery lookup.
- Every newly created watch is pinned to one stable identity for future checks.
- `watch_token(chain="any")` returns and stores the resolved explicit chain and address when applicable.
- `check_watches` re-prices pinned identity and does not drift across chains or same-symbol addresses.
- Legacy ambiguous watches are either repaired automatically or surfaced as `unchecked` with a clear reason.
- `pnpm exec vitest run packages/market-data/src/price-service.test.ts apps/worker/src/tools/watch.test.ts` passes.
- `pnpm lint` passes.

## Open Questions

1. Should `list_watches` expose both requested and resolved identity by default, or only the resolved identity plus optional audit fields?
2. Should unresolved legacy watches remain stored until the agent removes them, or should the system offer an automatic cleanup path later?
3. Do we want `watch_token` to return a human-readable explanation when `chain="any"` resolves to a different chain than the agent likely expected, or is the structured response enough?