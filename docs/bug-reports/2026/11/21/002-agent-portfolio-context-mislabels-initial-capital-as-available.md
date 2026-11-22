# Bug Report: agent portfolio context shows the initial capital as "Available capital" and derives equity, drawdown and starting capital from it
- **Status:** OPEN. Not fixed. Documents the defect and the approved herobids-side plan. No work started; waiting for the owner's greenlight.
- **Severity:** High. Agents see a wrong capital, equity, drawdown and P&L, and the prompt sizes positions off it.
- **Date:** 2026-11-21
- **Environment:** code analysis only. Not reproduced live.
- **Primary report (root cause, traderton):** `traderton/docs/bug-reports/2026/11/21/001-get-account-summary-returns-initial-capital-no-equity-or-pnl.md`. Trading authority lives in traderton, so the data fix lands there first. This report covers what herobids does with the data.
- **Related:** `docs/bug-reports/2026/10/05/006-portfolio-context-block-never-populated.md` (added `applyOwnToolResult`, which mirrors the agent's own tool reads into the prompt state).

## Summary
Traderton's `get_account_summary` returns the configured capital. Herobids stores it as `availableCapitalUsd`, then computes equity and starting capital from it. Each step compounds the error.

## Root Cause (herobids side)
Line numbers are approximate.
1. **Mislabel.** `apps/worker/src/runtime-composition.ts` ~line 2359: the `get_account_summary` handler sets `availableCapitalUsd` from `data['capital']`.
2. **Wrong equity.** ~line 847: `currentEquityUsd = availableCapitalUsd + exposureUsd`. Capital is neither reduced by margin nor changed by P&L, so this is wrong and double-counts when positions are open.
3. **Inferred starting capital, never refreshed.** ~lines 848-849: when `startingCapitalUsd` is null it is set to `equity - netPnl` once and kept for the session. It is not read from config. `peakEquityUsd`, `drawdownPct` and return metrics (~lines 852-861) build on these values.
4. **Partial P&L.** The `get_analytics` handler sets only `realizedPnlUsd` (a 7-day default window, and only if the agent called it). Unrealized comes only from `instance.context.snapshot` for a single symbol.
5. **Staleness presented as fresh.** `PORTFOLIO_FEED_TOOLS` (~lines 2140-2151) refreshes state only when the agent itself calls `get_account_summary`, `list_positions` or `get_analytics`. Each fold stamps a new freshness timestamp, so an unchanged initial value looks fresh. There is no platform-side account read after a fill.
6. **Prompt.** `apps/worker/src/hybrid-agent-prompt.ts` ~line 108 prints `Available capital: ...`; ~lines 320-321 compute `perPositionCap = availableCapitalUsd / maxPositions`. The portfolio block (`runtime-composition.ts` ~lines 1505-1530) shows no equity.
7. `instance-event-publisher.ts` ~lines 141-151 write `startingCapital` to Redis, defaulting to `'0'`. Readers not checked.

## Approved fix plan
Approved by the owner on 2026-11-21. Not started. Depends on traderton's new fields and the updated `@poshjosh/contracts`.
- Map `initialCapital`, `equity`, `availableCapital`, `realizedPnlUsd` and `unrealizedPnlUsd` directly from the boundary read into the portfolio state.
- Delete the `available + exposure` equity derivation and the infer-once `startingCapitalUsd`. Take starting capital from `initialCapital`.
- Compute peak and drawdown from the real equity, or take drawdown from the boundary if traderton provides it (single source).
- Show equity and total P&L in the portfolio block. Rename labels so "Available capital" means what traderton says it means.
- Size `perPositionCap` from the real available capital or equity, as the prompt text states.
- Refresh after fills (DECIDED, 2026-11-21): the platform reads the account summary from the boundary after a fill or position close, and at each decision wake, instead of waiting for the agent to call the tool. Debounce so a burst of fills triggers one read. No per-tick polling. Per Agent Mode Purity this is data, not policy, so providing it is allowed.
- Freshness (DECIDED): stamp freshness with the boundary `asOf` time of the actual read, not the time the result was folded in. Unrealized P&L is point-in-time, so show its timestamp.
- Capital edits (DECIDED): show `initialCapital`, lifetime realized P&L and P&L since the last capital change as separate lines. Percent return and drawdown use the current allocation period, as traderton defines them (since the profile's `capital_changed_at`, which lives in traderton). Do not recompute these or store any capital-edit state in herobids.
- Funding (DECIDED): if the summary reports `fundingIncluded: false`, label the P&L in the prompt block as excluding funding. Funding ingestion is a separate follow-up in traderton.
- Check readers of the Redis `startingCapital` key and align it with the real initial capital.
- Update `runtime-composition.test.ts`, `hybrid-agent-evaluator.test.ts` and `venue-intelligence.test.ts` fixtures that assume `availableCapitalUsd` equals capital.

## Acceptance criteria
- After a realized loss, the prompt block shows equity below initial capital and drawdown above zero.
- `startingCapitalUsd` equals the configured initial capital for the whole session.
- After a fill, the portfolio block updates without the agent calling any tool, and its freshness label shows the boundary read time.
- After a capital edit, the block shows the new initial capital, unchanged lifetime realized P&L and P&L since the change.
- Tests cover each criterion (names describe behavior). `pnpm lint`, `pnpm build` and `pnpm test` pass.

## Not verified
- Not reproduced live. Readers of the Redis `startingCapital` key were not checked.

## Implementation Plan (coordinator task list)
1. DONE - Map traderton summary fields (initialCapital, equity, availableCapital, realized/unrealized P&L, drawdown, pnlSinceCapitalChange, fundingIncluded, asOf) into portfolio state; delete `available + exposure` equity derivation and infer-once startingCapital; stamp freshness with boundary `asOf`.
2. PENDING - Prompt/portfolio block: show equity, total P&L, lifetime realized, P&L since capital change, funding label; rename "Available capital"; size perPositionCap from real available capital.
3. PENDING - Platform-side debounced account-summary refresh after fills/position close and at each decision wake.
4. PENDING - Redis `startingCapital` readers aligned; update fixtures/tests (`runtime-composition.test.ts`, `hybrid-agent-evaluator.test.ts`, `venue-intelligence.test.ts`); CHANGELOG.

## Outstanding Issues
### Item 1
- Medium: equity/netPnl freeze at the last summary read while `recalculatePortfolioFromPositions` still updates unrealized/exposure from live positions (resolved by item 3 refresh; prompt should show asOf/age next to equity).
- Medium: api `AccountSummary.capital`/`capitalAvailable` now carry initialCapital (label "Capital" still implies a balance); rename to initialCapital/initialCapitalSet and update i18n label `capability.trading.attr.capital` + visual check.
- Low: tool descriptions in `apps/worker/src/tools/account.ts` and `tool-schemas.ts` still say "usable/available capital"; hybrid-agent-evaluator.test.ts fixtures not updated with new fields; worker/api tsconfig exclude tests so lint doesn't typecheck them; `positions[]` of the summary is not folded into openPositions.
