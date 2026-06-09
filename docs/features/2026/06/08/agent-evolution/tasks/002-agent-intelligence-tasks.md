# Plan 002 — Task List

**Epic:** B (Agent Intelligence)
**Plans:**
- [Agent Context and Progress](../references/agent-context-and-progress.md)
- [Agent Data Contract by Venue](../references/agent-data-contract-by-venue.md)
- [Market Data Discovery and Venue Intelligence](../references/market-data-discovery-and-venue-intelligence.md)
**Goal:** Give agents richer, venue-aware market context and explicit progress feedback so they can make better decisions without wasting extra tool-call round-trips.

---

## Tasks

### T1: Expand runtime state for portfolio, venue, and cost inputs

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)

Replace the current minimal `RuntimeSessionMetrics` shape with a richer state model that can carry:

- portfolio summary inputs (exposure, realized/unrealized P&L, drawdown)
- open-position snapshots
- recent venue intelligence for active instruments
- recent platform events and tool outcomes
- per-session cost inputs needed by the progress score

The data model should tolerate partial availability and preserve explicit `unavailable` / stale markers instead of silently dropping fields.

**Files:** `apps/worker/src/runtime-composition.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.test.ts`
**Acceptance:** The runtime composition state can represent all fields needed by the reference docs without overloading `lastPnlSummary` / `lastPositionSide`. Tests cover ingestion from runtime messages and tool results.

---

### T2: Rework context assembly order and trimming policy

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1

Refactor `buildSystemPrompt()` and `buildTickUserContext()` so the prompt follows the agreed order:

1. static identity / tools / guardrails / playbook
2. capability readiness
3. portfolio summary
4. open positions
5. regime summary
6. venue-specific intelligence
7. recent events and managed bots
8. progress score last

Implement the trimming policy from the reference doc rather than the current single-block character slicing. Preserve the progress section, active positions, and one-line regime summary under pressure.

**Files:** `apps/worker/src/runtime-composition.ts`, `apps/worker/src/runtime-composition.test.ts`
**Acceptance:** Prompt assembly is deterministic, static content comes first, progress is always the terminal block, and constrained-budget tests verify the documented trimming order.

---

### T3: Add portfolio, position, and recent-event context blocks

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1, T2

Replace the current single `Trading Context` summary with first-class dynamic blocks for:

- portfolio summary
- open positions
- recent platform / execution events
- managed bots summary

Use the data already flowing through runtime messages and tool results before introducing new fetches. The goal is to make the prompt materially better even before venue intelligence lands.

**Files:** `apps/worker/src/runtime-composition.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.test.ts`
**Acceptance:** The tick prompt shows portfolio and position data as separate blocks, recent events are bounded and ordered newest-last, and mixed direct-trading / bot-management sessions render coherently.

---

### T4: Inject perps venue intelligence for active instruments

**Status:** done
**Approach:** Vertical slice
**Effort:** Medium (1–2 sessions)
**Depends on:** T2

Implement the perps-side data contract for active Hyperliquid / Bybit instruments:

- funding rate
- open interest
- mark vs. oracle / index spread
- 24h volume and price change
- orderbook or crowding proxy where already available

Only inject data for instruments the agent can actually trade or currently holds. Normalize freshness metadata alongside values so the prompt can say `unavailable` or `[stale 2m]` instead of pretending freshness.

**Files:** `packages/market-data/src/` (new venue-intelligence helpers), `packages/market-data/src/index.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`
**Acceptance:** Agents with perps bindings receive a dedicated perps intelligence block with funding / OI / activity signals for active instruments. Agents without perps bindings do not see the block. Tests cover fresh, stale, and unavailable cases.

---

### T5: Inject DEX venue intelligence for active holdings and watchlists

**Status:** done
**Approach:** Vertical slice
**Effort:** Medium (1–2 sessions)
**Depends on:** T2

Implement the DEX-side data contract for Jupiter / 1inch workflows:

- held-token balances and USD value
- watched token prices
- liquidity and 24h volume
- pool age / discovery freshness where available
- optional enrichment fields when a provider is configured

Keep this block asset-class aware: if the agent has no swap bindings or DEX watchlist / holdings, omit it entirely.

**Files:** `packages/market-data/src/dexscreener.ts`, `packages/market-data/src/geckoterminal.ts`, `packages/market-data/src/index.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`
**Acceptance:** DEX-capable agents receive a DEX intelligence block showing liquidity and activity for held or watched tokens. Agents trading only perps do not pay token budget for DEX-only context. Tests cover both paths.

---

### T6: Replace the placeholder progress score with goal-aware performance scoring

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1, T3, T4, T5

The current progress score is just decision acceptance rate. Replace it with the weighted score from the reference doc:

- net P&L relative to starting capital
- win rate
- risk-adjusted return proxy
- drawdown from peak

Also track session cost inputs so the terminal progress block can report:

- LLM cost
- estimated server cost
- net profit after costs
- session duration
- performance score (1–10)

Move any fixed cost assumptions into operator config or a clearly typed runtime constant rather than hard-coding values inside prompt assembly.

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`, `packages/llm/src/llm-provider.ts`, `packages/domain/src/config/schema.ts`, `apps/worker/src/config.ts`
**Acceptance:** Every tick ends with a `Performance Summary` block. The score no longer depends on decision acceptance rate alone. Cost and drawdown inputs are tracked explicitly and covered by tests.

---

### T7: Add agent-facing intelligence and discovery tools

**Status:** done
**Approach:** Vertical slice
**Effort:** Large (1–2 sessions)
**Depends on:** T4, T5

Add the first read-only intelligence tools described by the reference docs:

- `discover_tokens`
- `get_market_overview`
- `get_funding_rates`

Expose them through skill definitions, runtime tool visibility, and `executeTool()` with normalized result shapes. Keep them read-only so Epic A scout mode can later reuse them without special-case work.

**Files:** `packages/domain/src/skills.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`, `packages/market-data/src/` (new discovery helpers)
**Acceptance:** Configured agents can call the new tools and receive normalized responses. Unconfigured providers hide the tools rather than advertising broken capabilities. Tests cover visibility gating and representative payloads.

---

### T8: Enforce freshness annotations and mixed-venue prompt coverage

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T4, T5, T6, T7

Implement the staleness rules from the data-contract reference so every injected value either:

- is fresh enough,
- is explicitly marked stale with age, or
- is explicitly unavailable.

Add focused tests for three prompt shapes:

- perps-only
- DEX-only
- mixed perps + DEX

This is the final guard against prompt drift after the richer intelligence blocks land.

**Files:** `apps/worker/src/runtime-composition.ts`, `apps/worker/src/runtime-composition.test.ts`, `apps/worker/src/agent.ts`
**Acceptance:** Prompt tests cover all three venue mixes and verify freshness annotations. No venue-specific block silently disappears when data is unavailable; it renders an explicit degraded marker instead.

---

## Parallelization Notes

- **T1** must land before the richer context model can stabilize.
- **T2** should follow immediately after T1 because every later task depends on the prompt shape.
- **T4** and **T5** can proceed in parallel once T2 is done.
- **T6** depends on the richer context inputs from T3–T5.
- **T7** can start once the perps / DEX intelligence fetchers exist.
- **T8** is the final consolidation pass.

```
T1 (runtime state)
	→ T2 (ordering + trimming)
		→ T3 (portfolio / positions / events)
		→ T4 (perps intelligence) ─┐
		→ T5 (DEX intelligence) ───┼→ T6 (progress score)
															 └→ T7 (intelligence tools)

T6 + T7 → T8 (freshness + mixed-venue coverage)
```
