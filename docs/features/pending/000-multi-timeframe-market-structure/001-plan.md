# Plan: Multi-timeframe market structure and candle tools for agents

Status: DRAFT for owner review. Nothing here is implemented.

Repos touched: `traderton` (almost all of the work), `herobids` (thin proxies, tool names, docs), `traderton-skills` (skill text). This plan lives in `herobids` because that is where the owner asked for it. Traderton owns the behaviour.

## Goal

Let a trading agent see 1h, 2h, 4h and 1d market structure and CISD signals for a symbol, as finished readings with real price levels, so it can build entry, stop and take-profit without doing indicator maths itself. Also add a raw candle tool, and make candle sources pluggable, with Hyperliquid as the first source after Binance.

## Background

Evidence is from a read-only look at staging on 2026-11-21 (agent `bright-parrot`, `e5312010-e9b7-4e5e-80eb-eac9c0e3fc86`) and from the code.

- The agent's trading tools give it no candles beyond what `check_regime` summarises. `check_regime` is fixed to the 1h interval, 200 candles, one benchmark symbol (`packages/worker/src/tools/market-data.ts` in Traderton: `regimeCandleProvider = CANDLE_PROVIDERS.binance`, `interval: '1h'`). It returns EMA, ADX, VWAP, a choppy flag and a three-value `marketStructure` (`higherHighs`, `lowerHighs`, `mixed`). It returns no swing prices and no timeframe choice.
- On 2026-11-20 the agent worked around this. It added the `web-access` skill itself (`agent_skills.assignment_source = agent_self`), called Binance's public klines API with `make_http_request` for 2h and 4h BTC candles, worked out CISD levels itself, set price watches and opened a paper short. It repeated the fetch several times that day.
- That workaround costs tokens and tool calls on every run, relies on the model's own arithmetic, and uses a spot price feed (`api.binance.com/api/v3/klines`) while the agent trades Hyperliquid perps.
- Traderton already has the building blocks, unused by agent tools: `detectSwingPoints`, `classifyStructure`, `detectCHOCH` in `packages/market-data/src/indicators.ts` (used by `packages/strategy/src/scan-engine.ts`).
- Candle fetching in Traderton is spread over three paths:
  1. `check_regime` and `get_volatility` through the provider registry, hard-wired to `CANDLE_PROVIDERS.binance` (`packages/market-data/src/candle-registry.ts`, whose key type has one member, `'binance'`).
  2. The scanner fetcher, `createScannerCandleFetcherFromConfig` (`packages/worker/src/scanner-candle-fetcher.ts`) wrapping `VenueCandleFetcher` (`packages/venues/src/candle-fetcher.ts`): orderbook venues go to Binance, swap venues to GeckoTerminal. It is used by `score_candidate`.
  3. `ProviderRegistry` (`packages/market-data/src/provider-registry.ts`): `binance.candles`, `geckoterminal.candles`, and a `hyperliquid` entry that has asset contexts only, no candles.
- There is no Hyperliquid candle code anywhere in Traderton.
- Herobids hides any Traderton tool that has no local proxy in its own registry. Three preset tools are hidden today for that reason (`docs/bug-reports/2026/11/21/001-preset-tools-dropped-no-local-registry-entry.md`). Every new tool in this plan therefore needs a herobids proxy, or agents will never see it.

### Live check of the Hyperliquid candle endpoint (2026-11-21)

`POST https://api.hyperliquid.xyz/info` with `{"type":"candleSnapshot","req":{"coin":"BTC","interval":"4h","startTime":...,"endTime":...}}` returned an array of `{t, T, s, i, o, c, h, l, v, n}`. `t` and `T` are open and close time in milliseconds, `o/c/h/l/v` are strings, `n` is the trade count. The last element is the candle still forming (its `T` is in the future). An unknown coin returned JSON `null`, not an error. Per [Hyperliquid's docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), only the most recent 5000 candles are available and the interval list includes 1h, 2h, 4h, 12h, 1d and 1w.

## Scope

In:
- A candle-source interface, a registry of sources chosen by operator config, and two sources: Binance (existing, wrapped) and Hyperliquid (new).
- `get_market_structure` (derived readings only).
- `get_candles` (raw candles, Traderton-side, shipped dark).
- Herobids proxies, tool catalog entries, tests and docs for both tools.
- `crypto-trading` skill text and Traderton's tool-to-skill map.
- A decision-record amendment for the raw tool.

Out:
- Changing `check_regime`, `get_volatility` or `score_candidate` behaviour. They keep their current Binance path. Moving them onto the new registry is a later, separate change (open question 7).
- Blocking or restricting the agent's own web-access candle fetching.
- Any strategy, risk, sizing or preset change.
- Continuation breaks of structure (BOS), order blocks, fair value gaps, and other ICT concepts.
- Swap or DEX candles (GeckoTerminal) in the new tools. The interface leaves room for them.

## Decisions

Made by the owner:
1. CISD: option D. Return three separately labelled signals per timeframe: `cisd`, `sweepConfirmed` and `structureBreak`.
2. Both the derived tool (2a) and a raw candle tool (2b) are wanted. The raw tool overturns Traderton decision 004 (see Separation rules).
3. Candle sources must be pluggable. Hyperliquid is the first plug-in after Binance, built now because the effort and risk are small.

Proposed by this plan (owner to confirm or change, see Open questions):
- Operator config sets the default source order. Proposed default: `hyperliquid`, then `binance`. The agent trades Hyperliquid perps, so levels should come from that venue first.
- Signal parameters (swing lookback, minimum run length, freshness window, sweep lookback) are operator config, not tool arguments. This keeps the model from tuning rules per call and follows `docs/best-practices/configuration.md`.
- Only closed candles are analysed. The forming candle is dropped.
- `get_candles` is shipped but not tagged to any skill until the owner approves, so agents cannot see it yet.

## Design

### Candle source interface (Traderton, `packages/market-data`)

A small port, one file per source:

```ts
interface CandleSource {
  id: string;                        // 'hyperliquid' | 'binance' | later others
  instrumentKind: 'perp' | 'spot';   // reported to the agent
  intervals: readonly string[];      // intervals this source can serve
  maxLimit: number;                  // most candles per request
  supports(symbol: string): Promise<boolean> | boolean;
  fetch(query: { symbol: string; interval: string; limit: number }): Promise<{
    candles: PriceCandle[];          // oldest first, includes closeTime; may include the forming candle
    freshness: { source: 'upstream' | 'cache'; ageMs: number; isStale: boolean };
  }>;
}
```

A `CandleSourceRegistry` takes the sources and the operator-configured order. `fetch({ symbol, interval, limit, source? })` tries the requested source, or each configured source in order. It falls through on "symbol not supported" or a fetch failure, and reports which source answered and which were skipped and why. Each source reuses the existing rate-limit coordinator and `loadWithCache` (cache key includes source, symbol, interval and limit).

`PriceCandle` (`@traderton/domain`) has an open timestamp and no close time. The registry derives close time from open time plus interval so that "closed candle" filtering works for every source.

### Sources

- **Binance:** wrap the existing `fetchBinanceCandles` and `SYMBOL_MAP`/`resolveBinanceSymbol`. Reports `instrumentKind: 'spot'`. No change to current behaviour.
- **Hyperliquid (new):** `fetchHyperliquidCandles` in `packages/market-data/src/hyperliquid-candles.ts`, a `candleSnapshot` POST through the existing Hyperliquid base URL and rate limiter pattern from `hyperliquid-info.ts`. Reports `instrumentKind: 'perp'`. It maps the base ticker to the Hyperliquid coin name. A `null` response means "symbol not supported" and falls through. Coin names such as the 1000x-style `k` prefixes and HIP-3 `dex:NAME` need checking against Hyperliquid's `meta` list before relying on a ticker mapping (open question 9).

### `get_market_structure`

Input (Zod, validated at the boundary):
- `symbol`: base ticker, e.g. `BTC`.
- `intervals`: array from an allowed list (default `["1h","4h"]`, allowed `1h, 2h, 4h, 12h, 1d`, at most 4 per call).
- `source`: optional. Default is the operator-configured order.

Output per interval (and a top-level `symbol`, `asOf`, `source`, `instrumentKind`). One failing interval returns an error entry for that interval and does not fail the others.

```ts
{
  interval, source, instrumentKind: 'perp' | 'spot',
  lastClosedAt,                       // close time of the latest closed candle used
  candlesUsed,
  freshness: { source: 'upstream' | 'cache', ageMs, isStale },
  trend: 'bullish' | 'bearish' | 'unclear',
  swings: [{ type: 'high' | 'low', price, time }],   // last N, oldest first
  lastSwingHigh: { price, time } | null,
  lastSwingLow:  { price, time } | null,
  structureBreak: { direction, brokenLevel, breakClose, breakTime, barsAgo } | null,
  cisd: { direction, triggerLevel, runLength, runStartTime, breakClose, breakTime, barsAgo } | null,
  sweepConfirmed: boolean,            // true only when a CISD is present and was preceded by a sweep
  sweep: { sweptLevel, sweptTime } | null,
  atrPct: number | null               // optional, see open question 4
}
```

No raw candles are returned. All prices are numbers and all times are ISO strings.

### Computation rules (pure functions in `packages/market-data/src/market-structure.ts`)

Shared inputs: closed candles only, oldest first. Parameters come from operator config.

- **Swings and trend:** `detectSwingPoints(candles, swingLookback, minSwingPct)`, then `classifyStructure`. Map `bullish` to `bullish`, `bearish` to `bearish`, `indeterminate` to `unclear`. A swing needs `swingLookback` candles on its right to confirm, so the newest swing lags by that many candles. The tool description must say so.
- **`structureBreak`:** `detectCHOCH(candles, swings, structure, confirmBars)`. A reversal break only: a close beyond the last opposing swing. Continuation breaks are out of scope. This is an MSS or CHOCH, not CISD, and the output labels it that way.
- **`cisd`** (body-based, after ICT's Change in State of Delivery, per the secondary sources reviewed in the planning discussion; I could not check Huddleston's own teaching):
  - A run is a maximal series of consecutive same-direction candles (down-closing = close below open; up-closing = close above open).
  - Bullish CISD: take a down run of at least `minRunLength` candles that ended at candle `k`. The trigger level is the open of the first candle in that run. The CISD fires on the first later candle `j > k` whose body closes above the trigger level. Wicks do not count.
  - Bearish CISD is the mirror image.
  - Report the most recent CISD whose break candle is within `freshBars` of the latest closed candle. Otherwise `null`.
  - A doji (close equals open) continues the current run and does not start one. This is a proposal (open question 2).
- **`sweepConfirmed`:** for a bullish CISD, true when, within `sweepLookbackBars` before the break, some candle's low traded below the most recent confirmed swing low that existed before the run began. Wicks count for the sweep. Bearish mirror uses highs. `sweep` carries the level and time.

Each rule has a table-driven test with hand-built candle series (see Validation).

### `get_candles`

Input: `symbol`, `interval`, `limit` (default and cap from operator config; proposed default 100, cap 500), `source` (optional), `includeForming` (default false). Output: `{ symbol, interval, source, instrumentKind, freshness, candles: [{ t, o, h, l, c, v }] }` with ISO times and numeric prices. Category `read-market-data`. The tool description tells the model to prefer `get_market_structure` and to use raw candles only to inspect a specific pattern.

### Operator config (Traderton `config/default.yaml`)

Operator-level, restart to change. Instance-level trading settings are untouched.

```yaml
marketData:
  candles:
    sourceOrder: [hyperliquid, binance]
    structure:
      candlesPerInterval: 200
      swingLookback: 3
      minSwingPct: 0
      chochConfirmBars: 5
      cisd:
        minRunLength: 2
        freshBars: 3
        sweepLookbackBars: 10
    raw:
      defaultLimit: 100
      maxLimit: 500
  hyperliquid:
    candles:
      requestsPerMinute: 60
      burstCapacity: 10
      maxWaitMs: 2000
      cacheTtlMs: 30000
```

All numbers above are starting proposals, not tuned values. They go through the config Zod schema with the existing fail-fast validation. If any new environment variable is introduced (none is expected), the matching `.env*.example` file changes in the same commit.

## Steps

### Phase A. Candle sources and Hyperliquid (Traderton)

1. Add the `CandleSource` interface, `CandleSourceRegistry`, and closed-candle helper (close time from open time plus interval) in `packages/market-data/src/`.
2. Add `hyperliquid-candles.ts` (`candleSnapshot` fetch, response parsing with Zod, `null` handling) and unit tests with recorded response fixtures, including the live sample shape above and a `null` response.
3. Wrap the existing Binance fetcher as a `CandleSource` without changing its behaviour.
4. Extend `createProviderRegistry` (`provider-registry.ts`) to build the source registry from config, with a Hyperliquid limiter and `loadWithCache`. Extend `marketData` config schema and `config/default.yaml`.
5. Extend the `marketDataRegistry` shape in `packages/domain/src/trading/tool-contract.ts` so tools can reach the source registry. Keep the existing `binance.candles` entry so `check_regime` is untouched.

### Phase B. `get_market_structure` (Traderton)

6. Add `market-structure.ts` with the pure functions described above, reusing `detectSwingPoints`, `classifyStructure` and `detectCHOCH`. Unit tests per rule.
7. Add the tool to `packages/worker/src/tools/market-data.ts` and to `marketDataTools`. Category `read-market-data`, so the boundary's read-only gate admits it automatically (`getReadOnlyToolNames`).
8. Add the output schemas to `packages/contracts` (`MarketStructureResult`) and validate the tool's own output against them in tests. Bump the contracts version.
9. Add `get_market_structure` to the `traderton/skills/crypto-trading` list in `packages/boundary/src/mcp/skill-tool-map.ts`. Check `packages/boundary/src/mcp/tools-from-registry.test.ts` (it asserts the crypto-trading list and which tools are advertised) and update it where needed.
10. Add a live case to `packages/boundary/src/dev/boundary-e2e.ts` (BTC, 4h, both sources).

### Phase C. Herobids proxies

11. In `apps/worker/src/tools/market-data.ts`, add a proxy for `get_market_structure` in the existing pattern: Zod parameter schema, degrade with `market_data_not_configured` when `ctx.externalBackend` is absent, otherwise `mapReadResultToToolResult(await ctx.externalBackend.invoke({ toolName, payload }))`. No trading logic in herobids.
12. Add the name to `KNOWN_AGENT_TOOL_NAMES` and an entry to `TOOL_CATALOG` in `packages/domain/src/tools.ts`. Add it to `MARKET_DATA_TOOLS` in `apps/worker/src/runtime-tool-visibility.ts`. All three must change together: the worker's startup check (`assertToolCatalogMatchesRegistry` in `apps/worker/src/tools/index.ts`) throws on any mismatch.
13. Tests in `apps/worker/src/tools/market-data.test.ts`: degrade without a boundary, payload forwarding, and failure mapping, following the existing stub pattern.
14. Update the trading skill text in `apps/worker/src/tools/platform-docs-data.ts` and add a `CHANGELOG.md` entry.
15a. Update `apps/worker/src/external-backend/__fixtures__/traderton-skill-tools.json` in the same change. Any tool added to Traderton's `SKILL_TOOL_MAP` (here `get_market_structure`) must also be added to that fixture, or `backend-skill-tools.test.ts` will not guard it. Keep the fixture names-only. Changing it alongside the proxy also means the registration surface from the preset-tools fix applies: the `KNOWN_AGENT_TOOL_NAMES` list, the `TOOL_CATALOG` entry, the barrel `apps/worker/src/tools/index.ts`, and a row in the "Exhaustive Tool Ownership" table of `docs/features/pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md` (`apps/api/src/routes/providers.test.ts` asserts that table equals `KNOWN_AGENT_TOOL_NAMES`). See `.kiro/specs/preset-tools-dropped-no-local-registry/design.md`, section 1. Expect textual merge conflicts in those files with the preset-tools fix.

### Phase D. Skill text (`traderton-skills`)

15. In `skills/crypto-trading/SKILL.md`, add `get_market_structure` to the Observe section with plain guidance: what each field means, that the newest swing lags, that CISD, structure break and sweep are separate labelled signals, and that the agent should build entry, stop and target from the returned levels. Add a `CHANGELOG.md` entry under Unreleased.

### Phase E. Rollout (follow `docs/tech/agents/agent-runtime-rollout-guide.md`: dependency first, prove on one target)

16. Deploy Traderton to staging first. Run the boundary e2e case. Confirm the tool appears in the MCP `tools/list`.
17. Deploy Herobids (proxy and catalog). Confirm no startup assertion failure.
18. Agents discover tools at start and at skill reload. Restart or reload one agent (`bright-parrot` is the natural candidate) and confirm in its `Backend tool visibility` log line that `toolCount` goes from 19 to 20 and `taggedToolCount` from 22 to 23, that the only dropped tools are the three known preset tools, and that `get_market_structure` is in the visible set. Before restarting, confirm its open position's stop and take-profit watches live in Traderton, not in the agent process (I saw them created through `watch_token`, but I did not verify where they are stored).
19. Watch the agent for one trading day: does it call the tool, and does it stop calling `make_http_request` for klines? Read-only access per `.github/skills/access-remote-targets`.
20. Rollback: remove the tool from `SKILL_TOOL_MAP` and redeploy Traderton. Herobids then stops seeing it with no Herobids change.

### Phase F. `get_candles` (raw), after owner approval of the decision amendment

21. Add the tool and its output schema to Traderton, a Herobids proxy and catalog entries, and tests, the same way as Phases B and C. Do not add it to `SKILL_TOOL_MAP` yet: herobids shows an agent only tools that Traderton tags to its skill, so it stays invisible.
22. Record the amendment to Traderton decision 004 (see Separation rules). Then add it to the `crypto-trading` map and the SKILL.md text, and roll it out as in Phase E.

## Separation rules check

- **INV-L1, INV-L2, INV-L3** (`docs/decisions/02-invariants.md`): trading logic, candle fetching and structure maths all live in Traderton. Herobids gets only pass-through proxies and catalog entries. Traderton is reached over the existing signed HTTPS boundary and herobids imports no `@traderton/*` code. No rule is touched. `@poshjosh/contracts` is the existing versioned contract package.
- **Derived-only rule** (not an invariant; it is Traderton decision 004 and the comment on `scannerCandleFetcher` in `packages/domain/src/trading/tool-contract.ts`): `get_market_structure` keeps it. `get_candles` breaks it. The owner has approved both. Before Phase F ships, record the amendment where Traderton keeps its decisions, giving the reason and the guardrails (cap, closed candles only, description steering toward the derived tool).
- **INV-P4** (nothing merges to `main` during trading extraction without owner approval) may still apply. The invariants file says to check Traderton's `CANONICAL-STATE.md` for whether it is active. Not checked.

## Validation

- `pnpm lint`, then focused vitest runs, in each repo (`traderton`: `packages/market-data`, `packages/worker`, `packages/boundary`, `packages/contracts`; `herobids`: `apps/worker`, `packages/domain`).
- Pure-function tests with hand-built candle series, one table per rule:
  - Bullish and bearish CISD fire on the first body close through the run's opening price.
  - A wick through the level does not fire.
  - A run shorter than `minRunLength` does not fire.
  - A CISD older than `freshBars` is not reported.
  - Sweep true and false cases.
  - The forming candle never influences a result.
  - Fewer candles than needed returns `unclear` and no signals, not an error.
- Source tests: Hyperliquid parsing, `null` symbol falls through to Binance, source failure falls through and reports `fallbackFrom`.
- Contract test: tool output validates against the contracts schema.
- Cross-check on staging: compare the tool's 2h and 4h swing levels for BTC with the levels the agent computed itself on 2026-11-20 (swing high 62,342, sweep low 61,230), allowing for Binance spot versus Hyperliquid perp price differences.
- Rate limits: check the Hyperliquid and Binance budgets with the tool called for 4 intervals by a few agents in a minute (cache should absorb most).

## Risks

- **CISD definition drift.** Traders define it slightly differently. Mitigation: the rule is written down above, parameters are in config, structure break and sweep are separate labelled signals, and the tool never claims more than it computed.
- **Lagging swings.** The newest swing is only confirmed `swingLookback` candles later, so an agent could read a stale level. Mitigation: `lastClosedAt` and `barsAgo` in the output, and a clear tool description.
- **Source differences.** Binance spot and Hyperliquid perp prices differ slightly. Mitigation: `source` and `instrumentKind` in every response, Hyperliquid first by default.
- **Hyperliquid coin names.** Ticker to coin mapping is unproven for `k`-prefixed and HIP-3 coins. Mitigation: unknown symbols fall through to Binance and are reported, and the mapping is tested against a recorded `meta` fixture.
- **Rate limits.** The new Hyperliquid candle budget is separate from its intelligence budget; Binance's budget is shared with `check_regime`. Cache TTLs and the per-call interval cap bound the load. The existing double-acquire caveat in the scanner fetcher is not touched.
- **The raw tool invites model arithmetic and large prompts.** Mitigation: it ships invisible, with a cap, closed candles only, and a description steering toward the derived tool. 500 candles is large; the default is 100.
- **Proxy gap recurs.** Forgetting a herobids proxy hides the tool silently (bug report 2026/11/21/001). Mitigation: the rollout step that reads `taggedToolCount` against `toolCount`, and the suggested test in that report.
- **No unit tests exist for the live agent flow.** The agent's reaction to the new tool is only checked on staging.

## Effort

Estimates, not commitments:
- Phase A (sources and Hyperliquid): 1 to 1.5 days. The Hyperliquid fetcher itself is small. Most of the time goes to the registry, config schema and tests.
- Phase B (structure tool and rules): 2 to 3 days. Most of the time goes to the CISD and sweep rules and their tests.
- Phase C (herobids): 0.5 to 1 day.
- Phase D (skill text): 0.5 day.
- Phase E (rollout and one-day observation): 0.5 to 1 day of work, plus the observation day.
- Phase F (raw tool and decision record): 0.5 to 1 day.

Total: about 5 to 8 working days across three repos.

Hyperliquid effort and risk are small, as the owner assumed: one POST function, a registry entry and a config block, public endpoint with no credentials, response shape already confirmed live. The risk that remains is symbol mapping.

## Open questions

1. **Default source order.** Proposal is `hyperliquid` then `binance`. Confirm.
2. **CISD details.** Minimum run length (proposal 2), how a doji is treated (proposal: continues the run), freshness window (3 candles), sweep lookback (10 candles). Are these right, or do you have your own rules?
3. **Continuation breaks (BOS).** Out of scope here. Add later?
4. **ATR in the output.** `atrPct` helps the agent set a stop distance and is cheap, but it is outside what was asked for. Keep or drop?
5. **Raw tool visibility.** When approved, should `get_candles` join `crypto-trading` or sit in its own skill? Are the proposed caps (default 100, max 500) acceptable?
6. **Where to record the decision 004 amendment.** The decision log under `docs/features/initial/` may be frozen. Which file is current?
7. **Migrating `check_regime`, `get_volatility` and the scanner onto the new registry.** Not in this plan. Do it later for consistency, or leave as is?
8. **Contracts versioning.** Adding schemas bumps `@poshjosh/contracts`. Herobids pins an exact version. Does herobids need to bump it, given the proxies pass data through without parsing?
9. **Hyperliquid coin naming.** How should an agent-supplied ticker (for example `PEPE`) map to Hyperliquid's coin (`kPEPE`)? Resolve through `meta`, or through Traderton's instrument repo, which already resolves `find_instrument`?
10. **Agent web-access candle fetching.** Left alone here. After this ships, should the agent be steered away from fetching klines itself (skill text only), or technically blocked?
