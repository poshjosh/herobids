# L3d Plan — delete the in-tree trading code (the deletion register)

**Status:** LIVE register (authored 2026-09-08). **L3c APPENDS to this as it defers deletions**, then L3d
executes it. **Branch:** `consume-traderton` ONLY. **Do NOT edit the sibling `traderton` repo.**
**Depends on:** L3c committed + reviewed (nothing here is deleted until side-effecting traffic goes to the
boundary). **Authority for decisions:** `traderton/docs/CANONICAL-STATE.md` §3.1/§3.2.

## Why this doc exists (read this)

L3c rewires the side-effecting path to the boundary but **deliberately leaves dead code behind** (disabled
maxBots enforcement, orphaned `bots`-table writes, now-unused trading imports) rather than delete mid-rewire.
That deferral is a **dropped-work hazard**: once L3c commits and we pause, the dead trading-policy code
(maxBots) and the `bots` table sit in herobids with nothing tracking that they MUST be deleted — which is
exactly the legal-isolation leak #4 exists to close (trading policy/state must not live on the platform).

**So this register is the durable home for every deferred deletion.** The rule:

> **L3c may defer a deletion ONLY by recording the exact file + symbol here (§C, the append log).**
> A fresh session picking up L3d executes §A + §B + §C and nothing is lost.

## §A — Known DELETE set (the big subtraction; seeded now)

The trading-execution code herobids imports in-process, to delete once nothing references it:

- **Packages (whole):** `packages/engine`, `packages/venues`, `packages/market-data`, `packages/strategy`,
  `packages/backtesting`.
- **Worker execution slices:** `apps/worker/src/agent-trading-actor.ts`, `trading-actor.ts`,
  `execution-actor.ts`, `runtime.ts` (the `trading-instance-lifecycle` `WorkerRuntime`/BullMQ consumer), and
  the technical/scanner/tick/candle/swap/`venue-adapter-factory`/`venue-instrument-cache` helpers.
- **Trading DB tables + repos** (`packages/db`): `positions`, `fills`, `orders`, `execution-plans`,
  `decisions`, `decision-*`, `balance-snapshots`, `reconciliation-events`, `backtest-runs`, `instruments`,
  **`bots`**, `venue_accounts`, `user_credentials` (the last two now Traderton-owned — deleted here once
  L3-P1 provisioning is live) + their repos (`position-repository`, `reconciliation-repository`,
  `backtesting-repository`, `instrument-repository`, `decision-*-repository`, the trading slices of
  `repositories.ts`).
- **Trading-package imports** in `apps/worker/src/index.ts` (`@herobids/{engine,venues,market-data,strategy,
  backtesting}`) once the composition root no longer constructs the actor/runtime.

## §B — #4-specific deletions (maxBots + bots state — the legal-isolation closers)

These are the trading-POLICY/STATE items #4 requires gone from herobids. **They are the highest-priority
deletions** — leaving them is the leak.

- **`bots` table + repo** (see §A) — herobids owns no bot state.
- **maxBots enforcement:** `botLimitCheck` / `tryMarkBotRunningWithLimit` wiring in the broker; `checkBotLimit`
  in `apps/api/src/routes/bots.ts`; the maxBots resolution in `apps/api/src/agents/agent-create-normalization.ts`
  (~:368–390) and any `agentRiskDefaults.maxBots`/plan-entitlement bot-cap logic.
- **Any `bots`-table read/write** left in the rewired tools/routes.

## §C — Deferred-deletion append log (L3c POPULATES THIS — one line per item)

> **L3c: every place you disable/orphan trading code instead of deleting it, add a line here** with the
> exact `path:symbol` + one-word reason (`dead` / `orphaned` / `unused-import`). This is a hard L3c
> done-criterion (see `003-l3c-plan.md`). Do not leave the log empty if L3c left anything behind.

| # | `path:symbol` | kind | left by | delete-at |
|---|---------------|------|---------|-----------|
| 1 | `apps/worker/src/agents/agent-decision-handler.ts:import { submitDecisionForExecution, DecisionContextHashMismatchError, validatePerTradeLevels } from '@herobids/engine'` | unused-import | L3c (engine call replaced by boundary invoke+poll; per-trade validation relocated behind boundary) | L3d |
| 2 | `apps/worker/src/agents/agent-decision-handler.ts:import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine'` | unused-import | L3c (intake pipeline replaced by boundary payload build) | L3d |
| 3 | `apps/worker/src/agents/agent-decision-handler.ts:DecisionIntakeResolver` + `_intakeResolver` ctor param | dead | L3c (engine-backed intake — getIntakeDeps/getDecisionContext/getPosition no longer called on the rewired direct path; retained as unused positional ctor param for composition-root/ApprovalService compat; approval-snapshot venueAccountId now from the connection grant) | L3d |
| 3b | `apps/worker/src/agents/agent-decision-handler.ts:actorsWithSuccessfulContext` | dead | L3c (removed — the no_context startup-vs-persistent tracking belonged to the engine intake path) | L3d (already removed in L3c) |
| 4 | `apps/worker/src/agents/agent-decision-handler.ts:validatePerTradeLevels usage + POSITION_GROWING_INTENTS/formatLevelValidationMessage per-trade block` | relocated | L3c (per-trade stopLoss/takeProfit validation moved behind the boundary — Traderton owns mark-price-dependent validation) | L3d |
| 5 | `apps/worker/src/agents/agent-decision-handler.ts:equity-snapshot publish (intakeDeps.equityTracker / publishEquitySnapshot)` | relocated | L3c (equity/drawdown snapshot depended on engine-sourced equityTracker; moves behind the boundary) | L3d |
| 6 | `apps/worker/src/agents/agent-message-broker.ts:imports venueTypeFromProvider + BotConfigSchema (removed in L3c); mergeBotConfig + configsEqual functions (removed in L3c)` | unused-import/dead | L3c (venue-stamp + local bot-config validate/merge/compare moved behind the boundary — already removed in L3c) | L3d (already removed) |
| 7 | `apps/worker/src/agents/agent-message-broker.ts:BotLimitCheckCallback + botLimitCheck ctor param` | dead | L3c (maxBots enforcement removed — Traderton owns the limit) | L3d |
| 8 | `apps/worker/src/agents/agent-message-broker.ts:BotStartCallback/BotStopCallback/BotRestartCallback + botStart/botStop/botRestart ctor params` | dead | L3c (lifecycle enqueue→actor kickoff replaced by boundary invoke) | L3d |
| 9 | `apps/worker/src/agents/agent-message-broker.ts:botRepo write calls in handleManageBot (getResolvedVenueAccount/tryCreateBotWithLimit/tryMarkBotRunningWithLimit/markBotRunning/markBotStopped/updateBotConfig/restoreBot*)` | orphaned | L3c (bots-table writes removed from the rewired lifecycle path — herobids owns no bot state) | L3d |
| 10 | `apps/worker/src/index.ts:botLimitCheckCallback (maxBots plan cap)` | dead | L3c (no longer passed to the broker) | L3d |
| 11 | `apps/worker/src/index.ts:botStartCallback/botStopCallback/botRestartCallback (enqueueLifecycle wrappers)` | dead | L3c (broker no longer drives the lifecycle queue for agent bots) | L3d |
| 12 | `apps/api/src/routes/bots.ts:imports checkBotLimit + BotConfigSchema + agents (removed in L3c)` | unused-import/dead | L3c (maxBots dropped from POST /bots + start; trading-config validation moved behind boundary — already removed in L3c) | L3d (already removed) |
| 13 | `apps/api/src/routes/bots.ts:_agentRiskDefaults param + POST /bots/:id/start agent maxBots block` | dead | L3c (maxBots enforcement removed — Traderton owns the limit; param retained unused for signature/test compat) | L3d |
| 13b | `apps/api/src/routes/bots.ts:PATCH /bots/:id/config db.update(bots) write + local ownership reads on POST/start/stop/PATCH` | orphaned | L3c (write path rewired to the boundary; the local bots-table reads/writes on the rewired endpoints are DELETE-side — see §D) | L3d |
| 13c | `apps/api/src/routes/bots.ts:validateExecutionCapability/venueTypeFromProvider (still used by PATCH /bots/:id/config capability check)` | orphaned | L3c (the capability check on the rewired write endpoints was removed; PATCH-config still uses it locally — a DELETE-side reader per §D) | L3d |
| 14 | `apps/api/src/plan-guards.ts:checkBotLimit` | dead | L3c (last caller removed from routes/bots.ts) | L3d |
| 15 | `apps/api/src/agents/agent-create-normalization.ts:maxBots resolution (~:368–390) + AgentCreateParams.maxBots/normalized maxBots` | dead | L3c investigation (#4 — herobids owns no bot cap; recorded, not touched in L3c) | L3d |

## §D — Consumer audit (from L3c; must be complete before deleting)

L3c's `bots`-table + trading-repo consumer audit lands here — every reader/writer of the DELETE-set,
confirmed either (a) trading-path/deletable or (b) re-pointed at a boundary read tool
(`list_bots`/`get_bot_status`). **L3d does not delete a table/module until its consumers are all in this
list as (a) or (b).**

**Legend:** disposition (a) = trading-path/deletable at L3d; (b) = must be re-pointed at a boundary read tool
(`list_bots`/`get_bot_status`) or an equivalent boundary surface before deletion. L3c rewired only the
side-effecting write path (`create_bot`/`start_bot`/`stop_bot`/`adjust_bot_config` in broker + API, and
`submit_decision`); every remaining `bots`-table READER below is left in place by L3c and dispositioned here
for L3d.

> **Actor/container-slice readers are covered by §A wholesale.** In-container / actor-runtime-slice `bots`
> readers that are deleted as part of §A's worker execution slices — e.g.
> `apps/worker/src/startup-context.ts:resolveBotStartupContext`, the `agent.ts` `toolBotRepo` binding, and
> `apps/worker/src/tools/resolvers.ts` (bot-name resolver) — are NOT individually re-listed below; they are
> all disposition (a), deleted with the actor/runtime slice, and none is a side-effecting engine path. The
> table below enumerates the platform-adjacent + API readers that need an explicit per-consumer decision.

### `bots`-table + trading-repo consumers

| consumer (`path:symbol`) | of | disposition | notes |
|--------------------------|----|-------------|-------|
| `apps/worker/src/agents/agent-message-broker.ts:handleManageBot` | bots write + maxBots + venue-stamp | (a) | REWIRED in L3c to boundary invoke; residual dead write/limit calls logged in §C #6–#9 |
| `apps/worker/src/agents/agent-message-broker.ts:handleBotQuery (list_bots/get_bot_status/get_analytics)` | bots read via botRepo | (b) | agent bot-query path; re-point at `list_bots`/`get_bot_status`/`get_analytics` boundary tools (L3b rewired the tool-facing reads; this broker query path is a parallel reader still on botRepo) |
| `apps/worker/src/tools/bots.ts:list_bots/get_bot_status` | bots read (fallback branch) | (b) | L3b already routes to boundary when configured; the direct-DB fallback branch is deletable once fallback removed |
| `apps/worker/src/tools/bots.ts:stop_bot/adjust_bot_config/start_bot/create_bot` | bots read/write | (a) | REWIRED in L3c to route side effects through the boundary; local botRepo pre-checks/writes deletable |
| `apps/worker/src/index.ts:cascadeStopAgentBots (getBotsByCreator)` | bots read + stop enqueue | (a) | agent-crash cascade stop; trading lifecycle — deletable with the actor/runtime slice |
| `apps/worker/src/index.ts:botLimitCheckCallback / botStart*/botStop*/botRestart* / reclaim (from bots where status=running)` | bots read/write + lifecycle | (a) | trading lifecycle wiring — deletable with runtime.ts/WorkerRuntime |
| `apps/worker/src/index.ts:onInstanceCrashed/onInstanceStopped userId/creator lookups` | bots read | (a) | trading event fan-out — deletable with the actor/runtime slice |
| `apps/worker/src/market-intelligence/assessment-identity-resolver.ts:resolve (venueAccountId from bots)` | bots read | (a) | resolves the agent's venue account from a bot row for market-assessment identity; trading-path — deletable (Traderton resolves venue accounts) |
| `apps/api/src/routes/bots.ts:POST /bots, POST /bots/:id/start, POST /bots/:id/stop, PATCH /bots/:id/config` | bots write + lifecycle enqueue + maxBots | (a) | REWIRED in L3c write path to boundary; reporting reads below are (b) |
| `apps/api/src/routes/bots.ts:GET /bots, GET /bots/:id, GET /bots/:id/costs, /sessions, /events, /journal, /journal/summary` | bots + fills + journalEvents read | (b) | reporting-read endpoints over DELETE-side tables; re-point at boundary read tools (or a new reporting surface) before deleting the tables. Not rewired in L3c per plan §4. |
| `apps/api/src/routes/bots.ts:DELETE /bots/:id` | bots delete + queue.getJobs | (a) | bot deletion; trading-path — deletable |
| `apps/api/src/routes/bots.ts:POST /bots/:id/blueprints` | bots read (project to blueprint) | (b) | reads a bot's config to seed a blueprint; needs a boundary read (`get_bot_status` config) or blueprint-from-bot removal |
| `apps/api/src/routes/reconciliation.ts` | bots read (ownership + venueAccountId) | (a) | reconciliation is a trading concern — deletable with reconciliation-events |
| `apps/api/src/routes/accounts.ts` | bots read (blocking/concurrent bots on venue account) | (a) | venue-account teardown guard; trading-path — deletable (venue_accounts move to Traderton at L3-P1) |
| `apps/api/src/routes/connections.ts` | bots read (blocking/concurrent bots on connection) | (b) | connection teardown guard — connections are KEEP (platform); re-point the "has running bots?" guard at a boundary `list_bots` query |
| `apps/api/src/routes/exports.ts` | bots + fills read (data export) | (b) | user data export spans platform + trading; re-point trading slices at boundary reads or scope export to platform data |
| `apps/api/src/routes/billing.ts` | bots read (resolve bot IDs for fills/ledger) | (b) | billing ledger resolves bot→fills; re-point at a boundary reporting read (fills are DELETE-side) |
| `apps/api/src/routes/dashboard.ts` | bots read (dashboard counts + venue accounts) | (b) | dashboard summary; re-point at boundary `list_bots`/analytics |
| `apps/api/src/routes/capabilities/trading.ts` | bots read (bots on connections) | (b) | trading-capability readiness; re-point at boundary `list_bots` scoped by connection |
| `apps/api/src/routes/actor-health.ts` | bots read (status) | (b) | bot health endpoint; re-point at boundary `get_bot_status` |
| `apps/api/src/routes/admin.ts` | bots count | (a) | admin metric count over the bots table; deletable (or re-point at a boundary count) |
| `apps/api/src/services/blueprint-performance-scorer.ts` | bots read (agent's bots) | (b) | scores blueprint performance from a bot's fills; re-point at boundary analytics/reporting |
| `apps/api/src/routes/credentials.ts:PATCH credential → restart running instances (queue.add restart-instance)` | lifecycle enqueue (third path) | (a) | THIRD `trading-instance-lifecycle` enqueuing site (see investigation item 3) — credential-rotation restart; trading lifecycle — deletable with runtime.ts. NOT in L3c's five-tool scope; flagged for L3d. |
| `apps/api/src/index.ts:lifecycleQueue (new Queue 'trading-instance-lifecycle')` + `apps/worker/src/runtime.ts:WorkerRuntime consumer` | lifecycle queue | (a) | the queue itself + its consumer; deletable once no enqueuing site remains (broker done in L3c; API bots route done in L3c; credentials.ts + credentials restart remain → L3d) |
| `apps/api/src/agents/agent-create-normalization.ts:maxBots resolution` | maxBots policy | (a) | #4 legal-isolation closer — herobids owns no bot cap; deletable (recorded §C #15) |
| `apps/api/src/plan-guards.ts:checkBotLimit` | maxBots policy | (a) | #4 closer — last caller removed in L3c (§C #14) |
| `apps/worker/src/services/approval-service.ts:ApprovalService.executeApproval (submitDecisionForExecution)` | engine submit (post-approve execute) | (b) | **SEAM/GAP:** the human-approve → execute path (D3 "on approve, call submit_decision as a plain execute") still drives the in-process engine. NOT in L3c's listed fusion points (plan §1 scopes only `handleDecisionSubmit`), so L3c did NOT rewire it. Must be re-pointed at the boundary `submit_decision` invoke (same payload build as the handler) BEFORE `@herobids/engine` is deleted — L3d prerequisite or a dedicated follow-slice. Flagged here so it is not lost. |

## §E — Execution order (L3d)

1. Confirm §D is complete (no un-audited consumers).
2. Delete §B first (maxBots + `bots` — the legal closers), verify build/suite green.
3. **Rewire the remaining in-process engine drivers to the boundary BEFORE deleting `@herobids/engine` (step 5).** These are live in-process trading paths L3c did not touch (not in its `handleDecisionSubmit`/bot-lifecycle scope) — deleting the engine without rewiring them would break execution, and leaving them would survive cutover as an in-process trading path (the exact leak the split closes):
   - `apps/worker/src/services/approval-service.ts:ApprovalService.executeApproval` → replace `submitDecisionForExecution` with the boundary `submit_decision` invoke (reuse `buildSubmitDecisionPayload` + the handler's invoke+poll mapping); the human-approve→execute path must go through the boundary. (Recorded in §D as the SEAM/GAP.)
   - `apps/api/src/routes/credentials.ts` credential-rotation restart + any other `trading-instance-lifecycle` enqueuer (§D) → boundary or removed with the runtime slice.
   Verify build/suite green after this step.
4. Delete §C's logged items.
5. Delete §A (packages, worker exec slices, trading DB) leaf-first; build + suite green after each.
6. Delete `venue_accounts`/`user_credentials` only AFTER L3-P1 (Traderton provisioning) is live.
7. Full herobids build/lint/suite green; run the L3e differential. Pause for human.

## Done criteria (L3d)

- §B, §C, §A all deleted; no `@herobids/{engine,venues,market-data,strategy,backtesting}` import remains in
  the platform code; no `bots` table; no maxBots logic anywhere in herobids.
- Build + lint + full suite green. Do NOT commit — the coordinator commits. Pause for human before L3e.
