# L3d Plan — delete the in-tree trading code (the deletion register)

**Status:** LIVE register (authored 2026-09-08; L3d scope confirmed 2026-09-10). **L3c APPENDED its
deferred deletions here**; L3d executes it **in dependency order across a few passes** (see §F — this is the
honest shape of the work, not scope creep). **Branch:** `consume-traderton` ONLY. **Do NOT edit the sibling
`traderton` repo.** **Depends on:** L3c committed + reviewed. **Authority for decisions:**
`traderton/docs/CANONICAL-STATE.md` §3.1/§3.2.

## §F — L3d scope decision (CONFIRMED 2026-09-10, human) — path (B): closers now, re-points/deletes deferred

L3d is NOT one big delete. The register's §D audit + the current code show three dependencies that make a
single-pass "delete the trading DB + packages" impossible without either stranding platform surface or
producing an unreviewable slice with hidden cross-repo dependencies. **Confirmed decision: path (B) — land
the legally-urgent closers now (the #4 leak: maxBots policy + the in-process engine-drive paths), and carry
the rest as tracked, dependency-ordered follow-slices.**

**THIS L3d pass DOES (the legal-isolation closers + safe deletions):**
- **L3d-1** — rewire the remaining in-process engine drivers to the boundary (§E step 3: `ApprovalService.executeApproval` + `credentials.ts` credential-rotation restart) AND **relocate the credential event-builders out of `@herobids/engine`** (see below).
- **L3d-3** — delete §B maxBots enforcement/policy + the `bots` **WRITE** path (the #4 closers). **NOT the `bots` table.**
- **L3d-4** — delete §C's logged dead code.
- **L3d-5** — delete §A worker execution slices + the trading-only packages that have **no KEEP-side reader**, leaf-first.

**THIS L3d pass EXPLICITLY DOES NOT (out of scope — tracked as follow-slices):**
- **`venue_accounts` / `user_credentials` deletion** — BLOCKED. herobids does not yet call Traderton's
  `provision_venue_account` (verified: no reference in `apps/`), and these tables are live platform surface
  (`routes/accounts.ts`, `routes/credentials.ts`, `plan-guards.ts`, `trading-provisioner.ts`,
  `credential-dependents.ts`). Deleting now strands credential/venue-account management. Gated on **L3-P1b**.
- **The `bots` TABLE deletion** — its §D disposition-(b) readers (reporting/teardown/dashboard/etc.) are not
  yet re-pointed. Deferred to **L3d-reporting** (then the table drop).
- **The §D (b) reporting re-points** — substantial behavioral work with a POSSIBLE second cross-repo
  dependency (boundary reporting-read surfaces for fills/journal/blueprint-from-bot may not exist yet).
  Deferred to **L3d-reporting**.

**INTERIM STATE after L3d-3 (record + accept):** the **`bots` table becomes a READ-ONLY VESTIGE** — nothing
in herobids writes it (new bots live only in Traderton), but the §D (b) reporting endpoints still READ it, so
they serve **increasingly stale bot data** until L3d-reporting re-points them. This is a **known, tracked
interim condition, not a silent correctness bug.** Deleted after L3d-reporting + L3-P1b.

**Engine-deletion prerequisite (add to §E):** `apps/api/src/routes/credentials.ts` (a KEEP platform route)
imports `credentialCreatedEvent` / `credentialRotatedEvent` / `credentialDeletedEvent` from
`@herobids/engine`. These are **platform** audit events (`userId`-shaped; the traderton side dropped them as
platform-owned) → **relocate them to `@herobids/domain` (or a platform module), do NOT delete**, BEFORE
`@herobids/engine` is deleted. (Consistent: they stay in herobids, just not inside the engine package.)

> **DONE (L3d-1):** `credentialCreatedEvent`/`credentialRotatedEvent`/`credentialDeletedEvent` + their payload
> types (`CredentialCreatedPayload`/`CredentialRotatedPayload`/`CredentialDeletedPayload`) were relocated to
> `@herobids/domain` (`packages/domain/src/platform.ts`, returning a `PlatformAuditEntry` structurally
> compatible with `PgJournal.append`) and REMOVED from `packages/engine/src/journal.ts` + its `index.ts`
> exports — the route (`apps/api/src/routes/credentials.ts`) now imports them from `@herobids/domain`, so **no
> KEEP-side platform code imports these from `@herobids/engine`.** Their unit tests moved to
> `packages/domain/src/platform.test.ts`. `credentialDecryptedEvent`/`credentialUsedEvent` were NOT moved:
> their only callers are DELETE-side §A engine slices — they stay in the engine and are deleted with it (§C #16).

**New tracked follow-slices (each its own investigate→propose→pause; sequenced):**
1. **L3d-reporting** — re-point the §D (b) consumers at boundary reads; then drop the `bots` table.
   Gated on confirming the needed boundary read surfaces exist (a possible cross-repo dependency to surface
   BEFORE starting, not discover mid-delete).
2. **L3-P1b** — herobids collects venue secrets and calls Traderton's `provision_venue_account`, then updates
   its own `connections.resolvedVenueAccountId` (the mirror of the `trading-provisioner` seam;
   credential-handling on the herobids side). L3-P1 (the traderton tool) is done; L3-P1b is herobids' work,
   yet-to-be-planned.
3. **The `venue_accounts` / `user_credentials` deletion** — only AFTER L3-P1b is live.

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
| 1 | `apps/worker/src/agents/agent-decision-handler.ts:import { submitDecisionForExecution, DecisionContextHashMismatchError, validatePerTradeLevels } from '@herobids/engine'` | unused-import | L3c (engine call replaced by boundary invoke+poll; per-trade validation relocated behind boundary) | ~~L3d~~ **DONE (L3d-4):** verified already removed in L3c — the import no longer exists in the file (only a descriptive comment referenced it). Nothing to delete. |
| 2 | `apps/worker/src/agents/agent-decision-handler.ts:import type { DecisionIntakeDeps, DecisionContext, PositionState } from '@herobids/engine'` | unused-import | L3c (intake pipeline replaced by boundary payload build) | ~~L3d~~ **PARTIAL (L3d-4):** `DecisionIntakeDeps` already gone. `DecisionContext`/`PositionState` REMAIN — they type the `DecisionIntakeResolver` interface which is deferred to L3d-5 (see #3). This engine type import is deleted with the resolver in the L3d-5 composition-root restructure. |
| 3 | `apps/worker/src/agents/agent-decision-handler.ts:DecisionIntakeResolver` + `_intakeResolver` ctor param | dead | L3c (engine-backed intake — getIntakeDeps/getDecisionContext/getPosition no longer called on the rewired direct path; retained as unused positional ctor param for composition-root/ApprovalService compat; approval-snapshot venueAccountId now from the connection grant) | ~~L3d~~ **DEFERRED → L3d-5 (composition-root restructure) (decided L3d-4):** entangled with L3d-5 delete-side code — the composition-root `intakeResolver` object (`apps/worker/src/index.ts`) is built from `AgentIntakeResolver` + `actorRegistry` + `execution-actor.ts`'s `IntakeResult` + `@herobids/engine` `DecisionContext`/`PositionState`, all §A/L3d-5; and `agent-native-decision.integration.test.ts` is a full in-process-engine pipeline test (`AgentIntakeResolver`→`AgentTradingActor`→`PaperExecutor`) deleted with §A in L3d-5. Removing the resolver + its `_intakeResolver` positional now would force editing L3d-5-doomed code/tests. Ctor signature kept stable. |
| 3b | `apps/worker/src/agents/agent-decision-handler.ts:actorsWithSuccessfulContext` | dead | L3c (removed — the no_context startup-vs-persistent tracking belonged to the engine intake path) | L3d (already removed in L3c) |
| 4 | `apps/worker/src/agents/agent-decision-handler.ts:validatePerTradeLevels usage + POSITION_GROWING_INTENTS/formatLevelValidationMessage per-trade block` | relocated | L3c (per-trade stopLoss/takeProfit validation moved behind the boundary — Traderton owns mark-price-dependent validation) | ~~L3d~~ **DONE (L3d-4):** verified the per-trade block + all `validatePerTradeLevels`/`POSITION_GROWING_INTENTS`/`formatLevelValidationMessage` usage are already gone from the file (removed in L3c). Nothing to delete. |
| 5 | `apps/worker/src/agents/agent-decision-handler.ts:equity-snapshot publish (intakeDeps.equityTracker / publishEquitySnapshot)` | relocated | L3c (equity/drawdown snapshot depended on engine-sourced equityTracker; moves behind the boundary) | ~~L3d~~ **DONE (L3d-4):** verified the equity-snapshot publish (`equityTracker`/`publishEquitySnapshot`) is already gone from the file (removed in L3c). Nothing to delete. |
| 6 | `apps/worker/src/agents/agent-message-broker.ts:imports venueTypeFromProvider + BotConfigSchema (removed in L3c); mergeBotConfig + configsEqual functions (removed in L3c)` | unused-import/dead | L3c (venue-stamp + local bot-config validate/merge/compare moved behind the boundary — already removed in L3c) | L3d (already removed) |
| 7 | `apps/worker/src/agents/agent-message-broker.ts:BotLimitCheckCallback + botLimitCheck ctor param` | dead | L3c (maxBots enforcement removed — Traderton owns the limit) | ~~L3d~~ **DEFERRED → L3d-5 (composition-root restructure) (decided L3d-4):** the `_botLimitCheck` positional is a dead ctor param interleaved with the LIVE `botLiveCheck` param and several other dead positionals (#8, `_agentRiskDefaults`). Removing it (and its `BotLimitCheckCallback` type) now shifts every following positional and forces edits across the composition root + ~5 broker test files with dozens of inline positional constructions. Kept stable; the whole dead-positional set + types go together in the L3d-5 restructure. |
| 8 | `apps/worker/src/agents/agent-message-broker.ts:BotStartCallback/BotStopCallback/BotRestartCallback + botStart/botStop/botRestart ctor params` | dead | L3c (lifecycle enqueue→actor kickoff replaced by boundary invoke) | ~~L3d~~ **DEFERRED → L3d-5 (composition-root restructure) (decided L3d-4):** same churn/interleave rationale as #7 — the `_botStart`/`_botStop`/`_botRestart` dead positionals + their callback types are removed as one coordinated set with #7 in the L3d-5 restructure. **NOTE:** the composition-root callback *definitions* that fed these positionals (`botStartCallback`/`botStopCallback`/`botRestartCallback` in `index.ts`, §C #11) WERE deleted in L3d-4 — the broker call site now passes `undefined` at these slots (mirrors the L3d-3 `_botLimitCheck` treatment). Only the dead ctor params + types remain, deferred here. |
| 9 | `apps/worker/src/agents/agent-message-broker.ts:botRepo write calls in handleManageBot (getResolvedVenueAccount/tryCreateBotWithLimit/tryMarkBotRunningWithLimit/markBotRunning/markBotStopped/updateBotConfig/restoreBot*)` | orphaned | L3c (bots-table writes removed from the rewired lifecycle path — herobids owns no bot state) | ~~L3d~~ **DONE (L3d-4):** verified all listed `botRepo` write calls are already gone from `handleManageBot` (removed in L3c — only a descriptive comment referencing the removed venue-stamp remains). Nothing to delete. The KEEP ownership READ (`isConnectionOwnedBy`) is platform authz (D2), left intact. |
| 10 | `apps/worker/src/index.ts:botLimitCheckCallback (maxBots plan cap)` | dead | L3c (no longer passed to the broker) | ~~L3d~~ **DONE (L3d-3):** callback definition deleted; broker call site now passes `undefined` for the `_botLimitCheck` positional (broker signature kept stable — the positional stays as a dead param alongside the other dead positionals, per §B lower-risk guidance) |
| 11 | `apps/worker/src/index.ts:botStartCallback/botStopCallback/botRestartCallback (enqueueLifecycle wrappers)` | dead | L3c (broker no longer drives the lifecycle queue for agent bots) | ~~L3d~~ **DONE (L3d-4):** verified unused after L3d-3 — the broker's `_botStart`/`_botStop`/`_botRestart` positionals are dead (never invoked), so these `lifecycleQueue.add(...)` wrapper definitions were only *passed*, never *called*. Deleted the three callback definitions; the broker call site now passes `undefined` at those slots (mirrors the L3d-3 `_botLimitCheck` treatment). `lifecycleQueue` itself KEPT — still consumed by the `WorkerRuntime` (§A, deleted in L3d-5) + closed on shutdown; §D disposition (a), deletable in L3d-5 once the runtime consumer goes. `botLiveCheckCallback` KEPT (live plan-gate param). |
| 12 | `apps/api/src/routes/bots.ts:imports checkBotLimit + BotConfigSchema + agents (removed in L3c)` | unused-import/dead | L3c (maxBots dropped from POST /bots + start; trading-config validation moved behind boundary — already removed in L3c) | L3d (already removed) |
| 13 | `apps/api/src/routes/bots.ts:_agentRiskDefaults param + POST /bots/:id/start agent maxBots block` | dead | L3c (maxBots enforcement removed — Traderton owns the limit; param retained unused for signature/test compat) | ~~L3d~~ **DONE (L3d-4):** deleted the dead `_agentRiskDefaults` param from the `botRoutes` signature + the now-unused `AgentRiskDefaultsConfig` import. Updated the production call site (`apps/api/src/index.ts` — dropped `appConfig.agentRiskDefaults`) + all test call sites (`bots.test.ts`, `blueprints.test.ts` — dropped the `undefined` slot before `tradertonClient`). The `POST /bots/:id/start` maxBots block was already removed in L3c (only the KEPT live-mode plan gate + the #13b ownership READ remain — both left intact per scope). |
| 13b | `apps/api/src/routes/bots.ts:PATCH /bots/:id/config db.update(bots) write + local ownership reads on POST/start/stop/PATCH` | orphaned | L3c (write path rewired to the boundary; the local bots-table reads/writes on the rewired endpoints are DELETE-side — see §D) | L3d |
| 13c | `apps/api/src/routes/bots.ts:validateExecutionCapability/venueTypeFromProvider (still used by PATCH /bots/:id/config capability check)` | orphaned | L3c (the capability check on the rewired write endpoints was removed; PATCH-config still uses it locally — a DELETE-side reader per §D) | L3d |
| 14 | `apps/api/src/plan-guards.ts:checkBotLimit` | dead | L3c (last caller removed from routes/bots.ts) | ~~L3d~~ **DONE (L3d-3):** `checkBotLimit` + the `checkTradingInstanceLimit` alias deleted; the now-orphaned `bots` import dropped from `plan-guards.ts` |
| 15 | `apps/api/src/agents/agent-create-normalization.ts:maxBots resolution (~:368–390) + AgentCreateParams.maxBots/normalized maxBots` | ~~dead~~ **RECLASSIFIED (L3d-3): NOT enforcement — informational** | L3c investigation (#4 — recorded, not touched in L3c) | **MOVED → informational-maxBots follow-slice (row #17).** L3d-3 found this resolution is not an enforcement/limit throw: it *clamps then persists* the informational `agents.maxBots` column (consumed by `agent-session-manager.ts`'s guardrail capability descriptor + defaulted for `chat.ts` agent create). Deleting it would break the informational maxBots field, which L3d-3 scope explicitly leaves intact. Deferred with the rest of the informational surface. |
| 16 | `packages/engine/src/journal.ts:credentialDecryptedEvent/credentialUsedEvent + CredentialDecryptedPayload/CredentialUsedPayload` | orphaned-once-engine-callers-gone | L3d-1 (their ONLY callers are DELETE-side §A engine slices — `venue-adapter-factory.ts`, `trading-actor.ts`, `agent-trading-actor.ts`; kept in the engine so those slices still compile until §A deletion. The platform-owned created/rotated/deleted builders were relocated to `@herobids/domain` — NOT these two, which have no KEEP-side consumer.) | L3d-5 (deleted with `packages/engine`) |
| 17 | **informational `maxBots` surface** — `agents.maxBots` DB column; the agent create/edit schema (`routes/agents.ts` create `maxBots` + PATCH `maxBots`, `routes/chat.ts` agent create) + their plan-clamp; the resolution in `agent-create-normalization.ts` (§C #15) that populates the column; the guardrail capability descriptor (`agent-session-manager.ts` `maxBots` in the runtime/capability payload → `runtime-composition.ts` prompt lines); evaluation reads (`evidence-assembler.ts`, `platform-docs-data.ts`); exports/connections read-through (`routes/exports.ts`, `routes/connections.ts`); the web client field | not-enforcement (informational/config guardrail) | L3d-3 (found while deleting §B enforcement — this is NOT a bot-cap throw; it is an informational per-agent guardrail number surfaced to the agent + UI. Removing it is a larger frontend + DB-schema change beyond §B; left entirely intact per L3d-3 scope) | **dedicated maxBots-field-cleanup follow-slice** (own investigate→propose→pause: drop the `agents.maxBots` column + migration, the create/edit schema field, the capability-descriptor guardrail line, docs, and the web UI together) |

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
| `apps/api/src/routes/credentials.ts:PATCH credential → restart running instances (queue.add restart-instance)` | lifecycle enqueue (third path) | (a) | **DONE (L3d-1):** the `queue.add('restart-instance', …)` enqueue was REMOVED, not rerouted — no boundary "restart bot" surface exists (verified: no restart tool in `@herobids/domain/traderton`) and Traderton owns bot lifecycle, so herobids must not drive in-process bot restarts on credential rotation (§F). The `queue`/`LifecycleJob` param was dropped from `credentialRoutes` (composition root `apps/api/src/index.ts` + functional test helper updated). **Behavioural change (accepted):** a credential rotation no longer force-restarts running bots from herobids; the route still surfaces the dependent running-instance IDs (informational, best-effort) via `dependentBotIds` (+ `dependentLookupError` on lookup failure), dropping the old `restartedBotIds`/`restartErrorCode`/`restartError` fields. Running bots continue on their prior credential until Traderton (which owns lifecycle) restarts/reloads them. |
| `apps/api/src/index.ts:lifecycleQueue (new Queue 'trading-instance-lifecycle')` + `apps/worker/src/runtime.ts:WorkerRuntime consumer` | lifecycle queue | (a) | the queue itself + its consumer; deletable once no enqueuing site remains (broker done in L3c; API bots route done in L3c; credentials.ts + credentials restart remain → L3d) |
| `apps/api/src/agents/agent-create-normalization.ts:maxBots resolution` | maxBots policy | (a) | #4 legal-isolation closer — herobids owns no bot cap; deletable (recorded §C #15) |
| `apps/api/src/plan-guards.ts:checkBotLimit` | maxBots policy | (a) | #4 closer — last caller removed in L3c (§C #14) |
| `apps/worker/src/services/approval-service.ts:ApprovalService.executeApproval (submitDecisionForExecution)` | engine submit (post-approve execute) | (b) | **DONE (L3d-1):** REWIRED to the boundary `submit_decision` invoke+poll, reusing the L3c helpers `buildSubmitDecisionPayload` + `mapBoundaryResultToDecisionOutcome` (`decision-boundary-mapping.ts`) and `TradertonSideEffectBoundary.invokeAndAwait`. Subject built as `{ ownerId: userId, actor: { type: approval.actorType, id: approval.actorId } }` — `ownerId`+`actor` ONLY, no `venueAccountId` (Traderton resolves it, D2). All platform gates/bookkeeping kept (`findById`, ownership, double-execution guard, pending-only, expiry+`updateExpired`, pending→approved `updateStatus`, `recordExecutionResult`, `recordResolutionAttempt`). Per-trade `validatePerTradeLevels` REMOVED (moved behind the boundary — Traderton owns mark-price-dependent validation). No-fallback: an unconfigured boundary returns a typed `error`/`precondition.not_ready` WITHOUT consuming the approval; the engine is NEVER invoked. `submitDecisionForExecution`/`DecisionContextHashMismatchError`/`validatePerTradeLevels` engine imports + the `intakeResolver`/`isIntakeRejection` execute-path usage were removed from this file (the `intakeResolver` dep was also dropped from `ApprovalServiceDeps` + the composition root). On `accepted` only `emitDecisionAccepted` is emitted (the boundary owns the plan/execution lifecycle and returns no order/fill/position detail synchronously, so plan-status/execution-result events are not fabricated here — mirrors the L3c direct path). **No in-process engine-drive path remains.** |

## §E — Execution order (L3d — path (B), per §F)

**This-pass steps (the closers + safe deletions):**
1. Confirm §D is complete (no un-audited consumers) + §F scope recorded.
2. **Engine-deletion prerequisites — rewire/relocate BEFORE any `@herobids/engine` deletion (step 6):**
   - `apps/worker/src/services/approval-service.ts:ApprovalService.executeApproval` → replace `submitDecisionForExecution` with the boundary `submit_decision` invoke (reuse `buildSubmitDecisionPayload` + the handler's invoke+poll mapping); the human-approve→execute path must go through the boundary. (§D SEAM/GAP.)
   - `apps/api/src/routes/credentials.ts` credential-rotation restart + any other `trading-instance-lifecycle` enqueuer (§D) → boundary or removed with the runtime slice.
   - **Relocate** `credentialCreatedEvent`/`credentialRotatedEvent`/`credentialDeletedEvent` from `@herobids/engine` → `@herobids/domain` (or a platform module); update `credentials.ts` import. (Platform audit events; do NOT delete.)
   Verify build/suite green.
3. Delete §B — maxBots enforcement/policy + the `bots` **WRITE** path (the #4 closers). **Leave the `bots` table + repo READ surface in place** (read-only vestige, §F). Verify build/suite green.
4. Delete §C's logged items.
5. Delete §A worker execution slices + the trading-only packages **with no KEEP-side reader**, leaf-first; build + suite green after each. A package still imported by a KEEP route stays until its tendril (step 2 relocation) clears.
6. Full herobids build/lint/suite green. Do NOT commit — the coordinator commits per sub-slice. Pause for human before L3e.

**Deferred to follow-slices (NOT this pass — see §F):**
7. **L3d-reporting:** re-point the §D (b) consumers at boundary reads (gated on confirming boundary read surfaces exist); THEN delete the `bots` table + repo.
8. **L3-P1b:** herobids calls Traderton `provision_venue_account`.
9. Delete `venue_accounts`/`user_credentials` — only AFTER L3-P1b is live.

## Done criteria (L3d this pass, path (B))

- §E steps 2–5 done: no in-process engine-drive path remains (ApprovalService + credential-rotation rewired);
  credential event-builders relocated out of `@herobids/engine`; §B maxBots policy + `bots` WRITE path gone;
  §C dead code gone; §A worker exec slices + no-KEEP-reader trading packages gone.
- The `bots` table remains as a read-only vestige (tracked, §F); `venue_accounts`/`user_credentials` remain
  (gated on L3-P1b). Any `@herobids/{engine,…}` package still imported by a KEEP route is recorded as a
  remaining tendril for its follow-slice.
- Build + lint + full suite green. Do NOT commit — the coordinator commits. Pause for human before L3e.


## §G — L3d sub-slice progress + review findings

### L3d-4 — delete §C's logged dead code — DONE (implemented; not yet committed — coordinator commits)
Landed §E step 4. Removed the unambiguously-dead §C code L3c left behind, and made a deliberate defer
decision on the churn-risky ctor-positional params.

**Acted on (deleted / verified-gone):**
- **#1** (engine `submitDecisionForExecution`/`DecisionContextHashMismatchError`/`validatePerTradeLevels`
  import) — verified already removed in L3c; nothing to delete.
- **#2** (`DecisionIntakeDeps` engine import) — `DecisionIntakeDeps` already gone; `DecisionContext`/
  `PositionState` REMAIN (they type the deferred `DecisionIntakeResolver`, see #3) — deleted with the resolver
  in L3d-5.
- **#3b, #4, #5, #6, #9, #12** — verified already removed in L3c (per-trade validation block, equity-snapshot
  publish, `actorsWithSuccessfulContext`, broker venue-stamp/config-merge imports, `handleManageBot` `botRepo`
  write calls, and the `routes/bots.ts` `checkBotLimit`/`BotConfigSchema`/`agents` imports). Only descriptive
  comments remained; trimmed one dangling breadcrumb (`mergeBotConfig + configsEqual`) in the broker.
- **#11** (`index.ts` `botStartCallback`/`botStopCallback`/`botRestartCallback`) — deleted the three
  lifecycle-enqueue wrapper definitions; broker call site passes `undefined` at the `_botStart`/`_botStop`/
  `_botRestart` positionals (mirrors the L3d-3 `_botLimitCheck` treatment). `lifecycleQueue` KEPT (still the
  `WorkerRuntime` consumer + shutdown `.close()`; goes with the runtime slice in L3d-5). `botLiveCheckCallback`
  KEPT (live plan gate).
- **#13** (`routes/bots.ts` dead `_agentRiskDefaults` param) — deleted the param + the now-unused
  `AgentRiskDefaultsConfig` import; updated the production call site (`apps/api/src/index.ts`) + all test call
  sites (`bots.test.ts`, `blueprints.test.ts`). The `/bots/:id/start` maxBots block was already L3c-removed;
  the #13b ownership READ + live-mode plan gate left intact.

**Ctor-positional-param decision — DEFERRED #3, #7, #8 → L3d-5 (composition-root restructure).** The plan
allowed either removing these dead positionals as a clean coordinated set OR deferring them if removal is
churn-risky / entangled with L3d-5. Chose to **defer, for a cleaner reviewable slice:**
- **#3** (`DecisionIntakeResolver`/`_intakeResolver`) is *entangled with L3d-5 delete-side code*: the
  composition-root `intakeResolver` object is built from `AgentIntakeResolver` + `actorRegistry` +
  `execution-actor.ts`'s `IntakeResult` + `@herobids/engine` types (all §A/L3d-5), and
  `agent-native-decision.integration.test.ts` is a full in-process-engine pipeline test deleted with §A.
  Removing #3 now forces touching L3d-5-doomed code + tests.
- **#7/#8** (broker `_botLimitCheck`/`_botStart`/`_botStop`/`_botRestart` + callback types) are dead positionals
  *interleaved with the LIVE `botLiveCheck` param*; removing them shifts every following positional and forces
  edits across the composition root + ~5 broker test files with dozens of inline positional constructions. The
  composition root is restructured in L3d-5 anyway.
  All ctor SIGNATURES kept stable; the type re-exports in `agents/index.ts` (`BotStartCallback`,
  `BotLimitCheckCallback`, `DecisionIntakeResolver`) left in place for the deferred set. §C rows #3/#7/#8
  updated with delete-at → L3d-5 + reason.

**Scope honoured (untouched):** the `bots` table + repo + all `bots` READ surface (#13b read-only vestige),
the informational `maxBots` surface (#17), `@herobids/engine` + all §A packages/worker-slices (incl. #16
engine credential builders → L3d-5), `venue_accounts`/`user_credentials`.

**Files changed:** `apps/worker/src/index.ts` (#11 callbacks + broker call site), `apps/worker/src/agents/
agent-message-broker.ts` (trimmed dangling comment), `apps/api/src/routes/bots.ts` (#13 param + import),
`apps/api/src/index.ts` (#13 call site), `apps/api/src/routes/bots.test.ts` + `apps/api/src/routes/
blueprints.test.ts` (#13 test call sites), `docs/.../004-l3d-plan.md` (§C rows + this entry).

**Verification:** `pnpm build` ✓, `pnpm lint` ✓. Suites green: api 1386 passed / 267 skipped, worker 3436
passed / 21 skipped, domain 1004 passed (the known-flaky `packages/domain/src/config/presets.test.ts` ENOENT
fixture passed this run). No production code path changed — only dead-code removal + test call-site arity fixes.

**Seam for L3d-5:** the composition-root restructure must remove, as one coordinated set, the deferred dead
ctor positionals + types (#3 `DecisionIntakeResolver`/`_intakeResolver`, #7 `BotLimitCheckCallback`/
`_botLimitCheck`, #8 `BotStart/Stop/RestartCallback`/`_botStart`/`_botStop`/`_botRestart`), the broker
`_agentRiskDefaults` positional, the `agents/index.ts` type re-exports, and every constructing test — alongside
deleting `execution-actor.ts`/`agent-intake-resolver.ts`/`agent-trading-actor.ts` + `lifecycleQueue`/
`WorkerRuntime` + the `agent-native-decision.integration.test.ts` pipeline test.

### L3d-3 — maxBots enforcement + residual non-lifecycle `bots` WRITE deletion — DONE (implemented; not yet committed — coordinator commits)
Landed §E step 3 (the #4 closers). Deleted the remaining maxBots **enforcement** from herobids:
- `apps/api/src/plan-guards.ts` — deleted `checkBotLimit` + the `checkTradingInstanceLimit` alias (§C #14); dropped the now-orphaned `bots` import (its only use).
- `apps/worker/src/index.ts` — deleted the `botLimitCheckCallback` definition (the maxBots plan-cap that read `bots` and threw) (§C #10); the `AgentMessageBroker` call site now passes `undefined` for the `_botLimitCheck` positional.

**Broker ctor positional-param decision (per §B lower-risk guidance):** the broker signature was **kept stable**.
L3c already reduced `_botLimitCheck` to an unused positional param sitting among several other dead positionals
(`_botStart`/`_botStop`/`_botRestart`/`_agentRiskDefaults`). Deleting one positional would shift all following
positions and force edits across every call site + test. So L3d-3 only deleted the *callback definition* and
passes `undefined`; the dead positional is removed wholesale later when the surrounding dead positionals go.
No broker call sites or tests changed. Build + lint + api/worker suites green (no test referenced the deleted
enforcement).

**Scope decision — informational maxBots LEFT intact (§C #15 reclassified → #17):** while deleting §B
enforcement, L3d-3 found the `agent-create-normalization.ts` maxBots resolution (§C #15) is **not** an
enforcement throw — it clamps + persists the **informational** `agents.maxBots` column, which feeds the agent's
guardrail capability descriptor (`agent-session-manager.ts`) and the `chat.ts` create default. Deleting it would
break the informational maxBots field, which L3d-3 scope explicitly leaves intact. Recorded the whole
informational surface as new tracked item **§C #17** (dedicated maxBots-field-cleanup follow-slice) and left it
untouched. The `bots` **table + repo READ surface** were also left intact (read-only vestige, §F) — L3d-3 removed
no `bots` read; the runtime/actor-lifecycle `bots` writes (`tryMarkBotRunningWithLimit` on API start,
`markBotRunning`/`markBotStopped`) are LEFT for wholesale deletion with the runtime slice in L3d-5.

**Verification:** `pnpm build` + `pnpm lint` green; api suite 1386 passed, worker suite 3436 passed, domain
995 passed (only the KNOWN-unrelated `packages/domain/src/config/presets.test.ts` ENOENT fixture failure).

### L3d-1 — engine-driver rewires + credential-event relocation — DONE (committed; reviewed PASS)
Landed §E step 2. `ApprovalService.executeApproval` rewired to the boundary (`submit_decision` invoke+poll,
reusing the L3c `buildSubmitDecisionPayload`/`mapBoundaryResultToDecisionOutcome` + `sideEffectBoundary`);
`credentials.ts` credential-rotation restart-enqueue removed; credential event-builders relocated
`@herobids/engine` → `@herobids/domain` (`platform.ts`). Code review: no CRITICAL/HIGH.

**Accepted deviations (both judged sound in review — recorded, no rework):**
- **Credential rotation no longer force-restarts running bots.** No boundary "restart bot" surface exists and
  Traderton owns lifecycle (§F), so the in-process `restart-instance` enqueue was removed, not reinvented.
  Running bots continue on the prior credential until Traderton reloads them (old secret not leaked; it stays
  in use by an already-running bot). Response shape changed: dropped `restartedBotIds`/`restartErrorCode`/
  `restartError`; added `dependentBotIds` (informational) + `dependentLookupError`.
- **Approve path emits only `decision.accepted`** (not `plan.status`/`execution.result`) — identical to the
  L3c direct-decision handler; the boundary returns no synchronous plan/fill/position detail and Traderton
  owns the execution event stream. Parity is with L3c and it holds; not a gap.

**LOW findings (non-blocking):**
- **LOW-1:** `platform.ts` credential builders carry a pre-existing `as unknown as Record<string,unknown>`
  double-cast (behaviour-preserving copy from the engine). Follow-up: type the builders to return
  `{ type; payload: CredentialXPayload }` or add an explicit mapper to drop the cast.
- **LOW-2:** `emitPlanStatus`/`emitExecutionResult` on `InstanceEventPublisher` are now dead production
  surface (no production caller after L3c + L3d-1). Sweep with the deferred `@herobids/engine`/event-publisher
  cleanup.
- **LOW-3 (FIXED):** stale `credentials.test.ts` header comment corrected to reflect no-restart behaviour.

**§C addition from L3d-1:** #16 — engine `credentialDecryptedEvent`/`credentialUsedEvent` + payload types
(callers are DELETE-side §A slices only) → deleted with `packages/engine` at L3d-5.


### L3d-5 — dependency map (investigation complete; deletion PENDING human decision on scope)

A full trading-package + worker-slice dependency map was produced before deleting. **Decisive finding: all
five §A packages are BLOCKED this pass** — each has a SURVIVING (KEEP/platform) importer. L3d-5's actual
deletable surface is the **actor/runtime worker slice + the composition-root restructure only** (the deferred
#3/#7/#8 positionals), NOT the packages.

**Pivotal fact:** `apps/worker/src/market-intelligence/*` is PLATFORM and SURVIVES (wired live in the
composition root), and it value-imports `@herobids/market-data` (`evidence-adapters.ts:evaluateRegime`,
`getRequiredRegimeCandleCount`) and `@herobids/strategy` (`preset-scorecard-runner.ts:scoreCandidate`). So
those two packages cannot be deleted while market-intelligence needs them.

**Per-package BLOCKED verdicts + clearing follow-slice:**
- **`venues`** — API wallet-gen (`api/index.ts`, `routes/chat.ts`, `routes/setup.ts` `generateWallet`/
  `deriveSolanaAddress`) → **L3-P1b**; venue adapters in `routes/accounts.ts` (`HyperliquidAdapter`/
  `JupiterSwapAdapter`/`OneInchSwapAdapter`) → **L3-P1b / venue_accounts deletion**; worker `PublicStreamPool`/
  mark-sources (`index.ts`, `public-stream-routing.ts`) + `BrowserlessAdapter` (`agent.ts`) + scanner-candle-
  fetcher → **unscheduled platform re-home (OPEN)**.
- **`backtesting`** — live `/backtests` route (`routes/backtests.ts:parseCsvToFrames`) + surviving
  `BacktestRuntime` (`index.ts:2279`) + `MarketDataRecorder` → **needs a backtesting scope DECISION (OPEN)**;
  transitively blocks `engine` (backtesting value-imports engine internally).
- **`market-data`** + **`strategy`** — surviving market-intelligence assessor + scanner surface →
  **market-intelligence refactor (unscheduled, OPEN)**.
- **`engine`** — mark-source wiring (`index.ts:createFillFirstMarkSource`/`MarkSelector`),
  `AgentIntakeResolver` (`agent-intake-resolver.ts`, the #3 knot), ops script `backfill-realized-pnl-delta.ts`,
  + transitive via backtesting → **composition-root restructure (partial) + backtesting decision**.

**DELETABLE-NOW (the L3d-5 this-pass surface):** the actor/runtime worker slice as one coordinated
composition-root restructure — delete `__tests__/integration/agent-native-decision.integration.test.ts`;
remove the `intakeResolver` object + `AgentIntakeResolver` + `actorRegistry`/`ActorStateOwner` + TradingActor
factory + `WorkerRuntime` + `lifecycleQueue` wiring + the deferred broker dead positionals (#3/#7/#8 +
`_agentRiskDefaults`) + `agents/index.ts` type re-exports + ~5 broker test files' inline constructions; then
delete the now-unimported slices leaf-first: `agent-trading-actor.ts` → `trading-actor.ts` →
`execution-actor.ts` → `runtime.ts` → `venue-adapter-factory.ts` → `agent-intake-resolver.ts` (+
`venue-instrument-cache.ts` after confirming `validate-trade-instrument.ts` survivorship;
`technical-phase.ts`/`complete-technical-scan.ts` only if no surviving reader remains). **KEEP** the scanner
candle/candidate/pre-filter helpers + `tick-gates.ts` (surviving assessor + agent).
**Watch-out:** the surviving `agentDecisionHandler` (boundary path) must be confirmed to no longer exercise
`intakeResolver`'s grant-fallback (`index.ts` ~:843–861) before #3 removal — verify it's dead post-L3c.

**OPEN QUESTIONS (need a human/cross-repo decision — surfaced, not assumed):**
1. **Backtesting disposition** — §A lists `backtesting` for deletion, but `BacktestRuntime` + the `/backtests`
   route are LIVE and never dispositioned in §D. Keep / move behind boundary / delete the feature? Gates
   `backtesting` + (transitively) `engine`.
2. **market-intelligence → market-data/strategy** — is a re-home slice planned, or do those packages stay as
   market-intelligence deps indefinitely?
3. **venues public-stream + BrowserlessAdapter** — surviving platform uses not covered by L3-P1b; what clears
   them?

**Net:** L3d "the big subtraction" reduces, this pass, to the worker actor/runtime slice + composition-root
restructure. The five package deletions are all carry-forward, gated on the follow-slices/decisions above.


## §H — Deferred (REQUIRED FOR CUTOVER) — the blocked package deletions + follow-slices

**These are NOT optional cleanup.** Each blocked package is held alive by a surviving *platform* importer,
and each such importer is an in-process **trading-in-platform coupling** — the exact leak the split exists to
close. **Cross-reference the merge gate (CANONICAL-STATE §4 invariant 5): cutover to `main` CANNOT pass while
any of these survive.** Confirmed 2026-09-10 (human): classify all as `Deferred (required for cutover)`.

### Blocked §A package deletions — each `Deferred (required for cutover)`
| package | blocking surviving PLATFORM importer(s) | clearing follow-slice |
|---|---|---|
| `@herobids/venues` | API wallet-gen (`api/index.ts`, `routes/chat.ts`, `routes/setup.ts`); venue adapters (`routes/accounts.ts`); worker `PublicStreamPool`/mark-sources (`index.ts`, `public-stream-routing.ts`); `BrowserlessAdapter` (`agent.ts`) | L3-P1b (wallet-gen + adapters) + Q3 venues-platform-rehome (public-stream + browserless) |
| `@herobids/backtesting` | `/backtests` route (`routes/backtests.ts`); `BacktestRuntime` (`index.ts`); `MarketDataRecorder` | Q1 backtesting slice |
| `@herobids/market-data` | `market-intelligence` assessor (`evidence-adapters.ts`) + scanner surface | Q2 market-intelligence re-home |
| `@herobids/strategy` | `market-intelligence` scorecard (`preset-scorecard-runner.ts`); worker strategy construction; `BacktestRuntime` | Q2 + Q1 |
| `@herobids/engine` | mark-source wiring (`index.ts`); `AgentIntakeResolver`; ops script `backfill-realized-pnl-delta.ts`; transitive via `backtesting` | composition-root restructure (partial, L3d-5) + Q1 |

### Follow-slices — each its own investigate→propose→pause; each `Deferred (required for cutover)`
- **Q1 — Backtesting.** Provisional disposition: **trading → belongs BEHIND THE BOUNDARY** (NOT deleted from
  herobids until a Traderton-side backtesting capability exists; its own slice). Deferred-required. **FLAG for
  the human:** the alternative is to DROP backtesting from the consumer entirely — that is a capability
  decision for the human, NOT an assumption to be made here.
- **Q2 — market-intelligence → market-data/strategy.** Own investigation: classify the actual usage of
  `evaluateRegime`/`getRequiredRegimeCandleCount`/`scoreCandidate` as boundary-read vs stays-in-platform. Do
  NOT resolve inside L3d-5.
- **Q3 — venues public-stream + BrowserlessAdapter.** Own investigation: per-use classification of the
  surviving `venues` uses; trading parts are Deferred-required.

### L3d-5 restructure — survivorship facts VERIFIED (2026-09-10, before deletion)
- **`agentDecisionHandler` does NOT use `intakeResolver`** — `_intakeResolver` is a dead unused positional
  (prefixed `_`, referenced only in comments); the rewired boundary path never calls
  `getIntakeDeps`/`getDecisionContext`/`getPosition`. Removing #3 changes NO live behaviour. ✓
- **`actorRegistry`/`WorkerRuntime`/`lifecycleQueue` consumers are all actor/runtime-slice** (intakeResolver,
  snapshotResolver, the broker `applyPendingConfigUpdate` closure, `healthRefreshInterval` iteration, the
  TradingActor factory, shutdown `.close()`) — deleted together in the restructure.
- **`cascadeStopAgentBots` (§D crash fan-out / cascade-stop)** — reads `botRepo.getBotsByCreator` + enqueues
  stops; wired into `onAgentCrashed`, `onSessionStopped`, `AgentHealthMonitor.onTerminalSessionCleanup`. This
  is dead in-process bot-lifecycle wiring (Traderton owns lifecycle) → removed/neutralised in L3d-5 (it reads
  the vestige `bots` table + drives the deleted lifecycle path). Its `bots` READ is a §D (b)/vestige concern;
  the cascade-stop ACTION is trading-lifecycle → goes now.
