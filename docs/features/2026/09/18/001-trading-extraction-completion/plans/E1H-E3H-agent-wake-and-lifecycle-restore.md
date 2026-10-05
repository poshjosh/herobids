# Plan E1H-E3H: Restore agent-actor lifecycle + scanner wake delivery (herobids consumer halves)

- **Task:** Execute the two GATED herobids ("H") halves of traderton's Wave-E extraction so hybrid/scanner_gated agents actually trade again: (E1-H) send scan config with the trading profile and drive the agent-actor lifecycle from the session manager; (E3-H) build the herobids relay that carries traderton's `agent_wake` notifications back onto the agent runtime's wake stream. Then add the cross-boundary end-to-end test that would have caught the regression.
- **Repo:** herobids (the traderton "T" side is already DONE and live — do not modify traderton unless a parity bug is found; see "Traderton side is already done").
- **Status:** NOT STARTED. Both halves are human-gated in the traderton plans; this plan is the authorization to execute them.
- **Branch note:** This restores behaviour that existed in-process before the extraction and was removed by traderton commit `45271d28` (`L3d-5 — delete in-process actor/runtime slice`). The removed herobids callbacks are the thing you are rebuilding — now as boundary calls instead of in-process construction.

---

## 0. Background an implementer needs before touching code

**What the system does.** herobids runs AI agents. Trading was extracted out of herobids into a separate service, **traderton**, reached over an HMAC-signed REST "boundary" (base URL `TRADERTON_BOUNDARY_URL`, consumer id `herobids`). An agent "ticks" (runs its LLM, which can then call the `submit_decision` tool) only when its runtime decides to. For a `hybrid` + `scanner_gated` agent, that decision is driven by a **wake signal**: a background **technical scanner** finds trade candidates and emits an `agent.wake`, which forces an LLM tick. Without wake signals a scanner_gated agent never trades.

**The regression (symptom).** Two local agents are deployed: `thyper` (hybrid/scanner_gated) and `tintel` (intelligence). `thyper` has never submitted a decision; it logs `Hybrid agent: timer tick without wake signal — skipping LLM dispatch` on every tick. The scanner never runs and no wake ever reaches it.

**Root cause (three linked gaps, all on the herobids side).** The extraction built the entire traderton half but left the herobids half unbuilt (it is explicitly "GATED — awaiting human go" in the traderton plans). Concretely:

1. **No scan config is sent to traderton.** herobids never sends the agent's `scanMode`/strategy to traderton's `set_agent_trading_profile`, so `agent_trading_profiles.scan_mode` is NULL for every agent. Traderton's actor only starts a scan loop when `scan_mode` is non-null, so the scanner can never start.
2. **The actor is never eagerly started.** Traderton's actor (and its scan loop) is only constructed lazily on an agent's first `submit_decision`. A scanner_gated agent never issues one (it is waiting for a scan wake that only a running scanner can produce) → chicken-and-egg. The fix traderton built is a consumer-only boundary tool `start_agent_actor` that herobids is supposed to call on session activation. herobids never calls it.
3. **The scanner wake can't get back to herobids.** When the scanner does emit a wake, traderton writes an `agent_wake` row into its `consumer_notifications` outbox table (readable over the boundary via the `scan_consumer_notifications` tool). herobids was supposed to run a polling relay that reads that outbox and republishes the wake onto the agent's Redis stream. That relay was never built.

Gaps 1 and 2 are the same handshake ("make the actor exist and run a scan loop at session start"); gap 3 is the downstream transport ("carry the wake home"). This plan fixes all three plus a test.

**Why grouped this way.** Gap 3 (the relay) is untestable until gaps 1+2 produce `agent_wake` rows. So implement Part A (lifecycle + config) first, confirm `agent_wake` rows appear in traderton's outbox, then Part B (relay), then Part C (e2e test).

---

## 1. Authoritative design sources (read these first)

These confirm the intended design. Follow them; this plan summarises and makes them self-contained, but if anything here conflicts with them, raise it rather than guessing.

- **traderton** `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/003-e1-agent-scan-loop-plan.md` — section **"E1-H — herobids (GATED)"** is Part A of this plan (tasks H1, H2).
- **traderton** `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/002-e3-consumer-event-channel-plan.md` — section **"E3-H — herobids relay (GATED)"** is Part B of this plan (tasks H1, H2, H3).
- **herobids** `docs/tech/agents/wake-signal-and-technical-scan.md` — how the agent runtime consumes wakes (the two Redis consumer groups, the buffered-wake race). You are feeding this existing machinery; do not change it.
- **herobids** source commit `45271d28^` (the commit *before* the deletion) `apps/worker/src/index.ts` — the original in-process `onSessionActive` / `onSessionStopped` / crash wiring and the `cascadeStopAgentBots` call sites you are restoring as boundary calls. View with: `git show 45271d28^:apps/worker/src/index.ts`.

**Design rule that overrides the naive approach (important).** The trading-profile contract splits strategy ownership (traderton E1 plan, T1 "Ownership rule"):

- herobids sends **creator inputs only**: `scanMode` and `creatorStrategy`.
- herobids must **NEVER** send `active_strategy` — traderton derives and owns it.
- `creatorStrategy` is exactly one of: `{ presetKey, styleTier }` (creator picked a preset) or `{ customTechnical: TechnicalConfig }` (creator authored the technical config directly).
- Sending `scanMode: null`/absent means "no scan loop" (correct for intelligence agents).

---

## 2. The traderton side is already DONE (verified) — do not rebuild it

Confirmed present and live in traderton (and in the running `traderton_xstack` docker stack):

- `agent_trading_profiles` has columns `scan_mode`, `creator_strategy`, `active_strategy` (migration applied; verified in the live DB).
- `set_agent_trading_profile` accepts `scanMode` + `creatorStrategy` and derives `active_strategy` itself. `get_agent_trading_profile` returns `active_strategy`.
- Lifecycle tools `start_agent_actor` / `stop_agent_actor` exist (`packages/worker/src/tools/agent-lifecycle.ts`), are **consumer-only** (registered in the boundary registry but absent from every skill tool set, so agents never see them), and are backed by `agent_actor_runs` (table exists; currently 0 rows because herobids never calls them).
- The scan loop, `discover-candidates`, scan candidate/metric persistence, and the `consumer_notifications` outbox + `scan_consumer_notifications` read tool all exist.

So every boundary endpoint this plan calls already exists on the traderton side. If a call fails, suspect the herobids request shape or subject, not a missing traderton tool. The one place you may need to touch traderton is the preset-resolution **parity** check (see Part A, task A1, "Parity"), and only to fix drift.

---

## PART A — Lifecycle + scan-config handshake (fixes gaps 1, 2)

### A1. Send scan configuration with the trading profile  *(fixes gap 1)*

**Where:** `apps/api/src/agents/trading-profile-reconciliation-saga.ts` and `apps/api/src/agents/trading-profile-reconciliation.ts`, plus the agents route that builds the profile (`apps/api/src/routes/agents.ts`) and the go-live path (`apps/api/src/services/agent-go-live-service.ts`). The go-live path builds the planner input in `preparePlannerInput`.

**What to change:**
1. Extend the profile configuration type that becomes the `set_agent_trading_profile` payload (`TradingProfileConfiguration` / `TypedTradingProfile` in `trading-profile-reconciliation.ts`) to carry two new optional creator-input fields: `scanMode: 'scanner_gated' | 'mixed' | null` and `creatorStrategy: { presetKey: string; styleTier: string } | { customTechnical: TechnicalConfig } | null`.
2. Populate them when building the profile snapshot for an agent, derived from the agent's `unified_config`:
   - `scanMode`: if `capabilityMode === 'hybrid'` and `hybridMode` is `'scanner_gated'` or `'mixed'`, send that `hybridMode` value; otherwise send `null` (intelligence agents send `null`).
   - `creatorStrategy`: if the creator selected a preset (look where the agent records its chosen preset — `unified_config.metadata.strategyPreset` and/or `strategy.type` + style tier), send `{ presetKey, styleTier }`. If the creator authored `unified_config.technical` directly, send `{ customTechnical: <that TechnicalConfig> }`. If neither applies (intelligence agent), send `null`.
   - **Never** send `active_strategy` (that field must not exist in the payload at all).
3. Thread these fields through `set_agent_trading_profile`'s payload in `applyForward` (the `set` action payload in the saga). The traderton tool already accepts them; they will be stripped if not declared, so make sure they are included in the forwarded snapshot.

**Parity (do this before relying on preset resolution):** traderton resolves `creatorStrategy` → `TechnicalConfig` using its own copy of the preset catalog + `applyPresetToAgent`. herobids resolves the same today in `apps/api/src/agents/strategy-preset-resolver.ts`. Confirm traderton's resolution produces the identical `TechnicalConfig` for each preset × styleTier (the traderton E1 plan says a parity fixture already exists under traderton `__fixtures__/herobids-preset-resolution.json`). If herobids' catalog has drifted from traderton's since that fixture was captured, fix the drift in the source of truth before shipping, and note it.

**Tests (herobids):** add to the saga/route test suite:
- "sends the creator's preset (presetKey+styleTier), not a resolved technical config"
- "sends customTechnical for a creator-authored technical config"
- "sends scanMode=null (and no creatorStrategy) for an intelligence agent"
- "never includes an active_strategy field in the set_agent_trading_profile payload"

**Verify after A1:** re-provision/update `thyper`'s profile (e.g. via the normal profile write path or go-live), then check the live traderton DB:
```
docker exec traderton_xstack-postgres-1 psql -U traderton -d traderton -c \
  "SELECT actor_id, scan_mode, creator_strategy, active_strategy FROM agent_trading_profiles;"
```
`scan_mode` must now be `scanner_gated` for `thyper`, and `active_strategy` must be populated (traderton-derived). This is a prerequisite for A2 to actually start a scan loop.

### A2. Drive the agent-actor lifecycle from the session manager  *(fixes gap 2, and gap-2's chicken-and-egg)*

**Where:** `apps/worker/src/index.ts` (the worker composition root that wires the `AgentSessionManager` callbacks) and `apps/worker/src/agents/agent-session-manager.ts` (which already defines `onSessionActive` / `onSessionStopped` callback hooks — see the pre-extraction version at `git show 45271d28^:apps/worker/src/index.ts`). Also the agent-delete cleanup path and the `AgentHealthMonitor` terminal-cleanup hook.

**What the boundary tools do (so you call them correctly):**
- `start_agent_actor` — consumer-only, agent-subject (`subject.actor = { type:'agent', id: agentId }`), owner-scoped, **venue-resolving** (so the boundary resolves the agent's venue account and the ensure constructs + starts the actor *before* the tool body runs). It records `desiredState='running'` in `agent_actor_runs`. Empty params `{}`. Idempotent.
- `stop_agent_actor` — consumer-only, agent-subject, `ownerScopedNoVenue` (no venue resolution needed). Stops + deregisters the actor, evicts the ensure cache, marks the run stopped, and cascade-stops the agent's running bots. Empty params `{}`. Idempotent. Returns `{ stoppedBots }`.

Both are invoked over the **side-effecting write boundary** the worker already has wired for `submit_decision` (`apps/worker/src/external-backend/write-adapter.ts` → `ExternalBackendWriteBoundary`). Use the same boundary + subject-construction path that `agent-decision-handler.ts` uses for `submit_decision`; just change `toolName`.

**What to change:**
1. In the worker composition (`index.ts`), wire the session manager's `onSessionActive(agentId, sessionId)` callback to invoke `start_agent_actor` over the write boundary with subject `{ ownerId: <agent.userId>, actor: { type:'agent', id: agentId } }` and empty payload. Resolve `ownerId` the same way the decision handler does (the agent's owner/user id).
2. Wire `onSessionStopped(agentId, sessionId)`, the crash/`onAgentCrashed` path, the `AgentHealthMonitor` terminal-cleanup hook, and the agent-delete cleanup (`DELETE /agents/:id`) to invoke `stop_agent_actor`.
3. **Best-effort, non-blocking:** a failure of either call must log and must NOT block the session transition (this matches the pre-extraction behaviour — the callbacks were best-effort). Do not throw out of the session lifecycle on a boundary error.
4. **Only for trading-capable agents:** gate the calls so you only start/stop an actor for agents that actually have a trading connection/venue account (an intelligence agent with no venue account would get `precondition.not_ready` from the venue-resolving `start_agent_actor`). Reuse the same readiness/venue-account resolution the decision handler already performs (`resolveGrantVenueAccountId` / the runtime capability descriptor's `trading` family). If an agent has no ready trading connection, skip the call (log at debug).

**Idempotency / races to respect (from the traderton plan's residual notes):** `start_agent_actor` is idempotent (repeated calls upsert the same running row; the actor is ensured once). Do not add your own dedup. The session manager must not call `onSessionActive` twice for the same already-activated session (the pre-extraction code guarded this with an `activatedSessions` set — preserve that guard so you don't double-start).

**Tests (herobids):**
- "starts the traderton agent actor when a trading agent's session activates"
- "does not call start_agent_actor for an agent with no ready trading connection"
- "stops the traderton agent actor (and cascades its bots) when the session stops"
- "stops the actor on agent crash and on agent delete"
- "a start_agent_actor boundary failure logs and does not block session activation"

**Verify after A2 (this is the gap-2 proof):** activate `thyper`'s session (restart the agent or its session), then:
```
# run row recorded:
docker exec traderton_xstack-postgres-1 psql -U traderton -d traderton -c \
  "SELECT actor_id, desired_state FROM agent_actor_runs;"
# scan loop running + wakes being produced into the outbox:
docker exec traderton_xstack-postgres-1 psql -U traderton -d traderton -c \
  "SELECT type, count(*) FROM consumer_notifications GROUP BY type;"
```
After A1+A2, `agent_actor_runs` should have a `running` row for `thyper`, and (once the scanner finds signals) `consumer_notifications` should start accumulating `agent_wake` rows. If `agent_wake` rows appear, gaps 1+2 are fixed; proceed to Part B to deliver them.

---

## PART B — The wake relay (fixes gap 3)

Build the herobids relay that reads traderton's `consumer_notifications` outbox and republishes onto the agent runtime's existing wake stream. Model it closely on the existing `apps/worker/src/alerting/alert-dispatcher.ts` (same Redis-lease singleton + poll-loop + reschedule-on-failure shape) and on `apps/worker/src/alerting/boundary-trade-event-feed.ts` (the existing boundary-read adapter pattern).

### B1. The relay

**New file:** `apps/worker/src/agents/actor-event-relay.ts`.

**Behaviour:**
- Singleton via Redis lease `lease:actor-event-relay` (copy the lease acquire/renew/release logic from `alert-dispatcher.ts`).
- Poll loop at `actorEventRelay.pollIntervalMs`; reschedule on failure (AGENTS rule: every async loop reschedules itself).
- Reads notifications through a small port backed by the `scan_consumer_notifications` boundary tool, over a **system** read boundary with subject id `actor-event-relay` (construct it exactly like the trade-event feed is constructed in `index.ts` — search for `createBoundaryTradeEventFeed`). `scan_consumer_notifications` is system-subject-only and takes `{ cursor?, types?, limit }` (limit max 500).
- **Cursor persisted in Redis** at key `actor-event-relay:cursor` (NOT in-memory — unlike AlertDispatcher, which replays on restart; replaying wakes is unacceptable). When absent, initialise the cursor to "now". Advance the cursor only AFTER a batch is successfully republished. The cursor shape mirrors the outbox scan: `{ createdAt, seenIds }` (ascending `createdAt`, then `id`).
- For each notification row, republish per the vocabulary (traderton E3 plan "Event vocabulary" table) using the existing `InstanceEventPublisher`:
  | row `type` | republish via |
  |---|---|
  | `agent_wake` | `eventPublisher.emitAgentWake(agentId, payload.wake)` |
  | `scan_completed` | `eventPublisher.emitTechnicalScanCompleted(agentId, payload.scan)` |
  | `journal_event` | `eventPublisher.emitJournalEvent(agentId, { journalType, detail })` |
  | `bot_status` | agent set: `emitInstanceStatus(agentId, {...})`; always: `userEventPublisher.publishBotStatus(ownerId, botId, status)` |
  | `agent_status` | look up the agent's active session; call `sessionManager.handleRuntimeFailure(activeSessionId, agentId, ownerId, error)`; if there is no active session, log and skip |
  - For the minimum viable fix (restoring trading), `agent_wake` and `scan_completed` are the essential rows. Implement the full table for parity, but if scope must be cut, `agent_wake` is the one that unblocks trading.
- **Stale guard:** skip `agent_wake` / `scan_completed` older than `actorEventRelay.maxEventAgeMs`. NEVER skip `bot_status` / `agent_status` / `journal_event` (status truth must always be delivered).
- **Malformed rows:** Zod-validate each payload; log and skip a malformed row WITHOUT stalling the cursor.
- `emitAgentWake` already does `XADD agent:outbound:{agentId}` with the right envelope; the agent runtime's `agent-market-wake` consumer group already consumes it and forces a tick. You are not changing the runtime consumer — only producing onto the stream it already reads.

### B2. Config + wiring

**Where:** `config/default.yaml` + the domain config schema (operator config layer).
- Add an `actorEventRelay` block with: `enabled` (bool), `pollIntervalMs` (default 5000), `maxBatchSize` (default 100), `maxEventAgeMs` (default 600000). Add inline comments per the repo's config conventions (`docs/best-practices/configuration.md`).
- Validate at startup via Zod (fail fast).
- Construct the relay ONLY when a system read boundary is configured (mirror how `AlertDispatcher` is conditionally constructed). Start it and stop it in `apps/worker/src/index.ts` alongside the other long-lived loops.
- No new env vars are expected (the boundary creds already exist). If you do introduce one, add its `.env*.example` twin in the same change (AGENTS rule).

### B3. Tests

**New file:** `apps/worker/src/agents/actor-event-relay.test.ts` (use a fake notifications port + a fake `InstanceEventPublisher`, no live boundary):
- "republishes an agent_wake row onto the agent's outbound stream"
- "republishes a scan_completed to the agent's outbound stream"
- "republishes a bot halt as instance status with managed bots"
- "publishes user bot status for user-created bots"
- "starts from now when no cursor is stored"
- "does not advance the cursor when republishing fails"
- "skips stale wakes but always delivers stale status events"
- "fails the agent session on a crashed agent actor (agent_status)"
- "skips and logs a malformed payload without stalling the cursor"

**Verify after B:** with Part A running and producing `agent_wake` rows, start the relay and confirm the wake lands on the agent stream and wakes the agent:
```
docker exec herobids-redis-1 redis-cli XRANGE agent:outbound:<thyper-id> - + | grep -c '"type":"agent.wake"'
```
This should become non-zero, and `thyper`'s container log should stop showing only `timer tick without wake signal — skipping LLM dispatch` and begin dispatching the LLM on wakes.

---

## PART C — End-to-end cross-boundary test (fixes gap 5)

The regression went undetected because each side was unit-tested in isolation; nothing tested the producer→transport→consumer path across the boundary.

**Add one integration test** that spans the seam (place it where herobids integration tests live; use the `test:integration` suite that already talks to Postgres/Redis). It must assert the full chain:
1. A scan on the traderton side writes an `agent_wake` row into `consumer_notifications` (either drive the real traderton scan in the integration stack, or seed an `agent_wake` row directly via the outbox repository if a full traderton scan is impractical in CI — the critical hop to prove is outbox → herobids stream).
2. The herobids `actor-event-relay` reads it via `scan_consumer_notifications` and republishes it.
3. Assert an `agent.wake` envelope lands on `agent:outbound:{agentId}`.
4. Assert the tick gate sees it: `buildTickGateState(...)` returns `hasWakeSignal: true` for that message (reuse the existing `tick-gate-state` helper the runtime uses).

If a true cross-process test is out of scope for CI, at minimum write a herobids-side integration test from "row present in a fake/real outbox readable via the boundary port" through "`agent.wake` on the stream and `hasWakeSignal:true`", and open a follow-up for the full cross-stack leg. Document which legs are covered vs stubbed.

---

## Overall execution order & gates

1. **A1** (send scan config) → verify `scan_mode` + `active_strategy` populate in traderton for `thyper`.
2. **A2** (lifecycle calls) → verify `agent_actor_runs` has a `running` row and `agent_wake` rows start appearing in `consumer_notifications`.
3. **B1–B3** (relay) → verify `agent.wake` reaches `agent:outbound:{thyper}` and the agent dispatches its LLM.
4. **C** (e2e test) to lock the whole chain.

Do not start B before A is confirmed producing `agent_wake` rows (B is untestable without them).

## Verification (whole plan)

- `pnpm lint` (tsc, must pass) and `pnpm build` for both affected packages.
- Focused unit suites for each changed area (A1 saga/route tests, A2 session-manager tests, B3 relay tests).
- `pnpm test:integration` for Part C.
- Worker typecheck: `pnpm exec tsc --noEmit -p apps/worker/tsconfig.json`.
- Live cross-stack proof (the acceptance criterion): with the `herobids` + `traderton_xstack` docker stacks up, activate a `scanner_gated` agent's session and confirm, within ~2 scan intervals, that it receives `agent.wake` and dispatches an LLM tick; stop the session and confirm the actor stops, the run row flips to `stopped`, and an agent-created bot is cascade-stopped; restart traderton with a session active and confirm the actor is rehydrated from `agent_actor_runs`.
- Clean up any temporary rows/keys created during manual verification.

## Scope guards / do-nots

- Do NOT modify the traderton repo except to fix a confirmed preset-resolution parity drift (A1). Everything else on the traderton side is DONE.
- Do NOT change the agent runtime's wake consumer (`apps/worker/src/agent.ts` two-consumer-group logic) or the tick gates — you are feeding existing machinery.
- Do NOT send `active_strategy` from herobids (ownership rule). Send only `scanMode` + `creatorStrategy`.
- Do NOT make the lifecycle or relay calls block session transitions; both are best-effort with logging.
- Keep `start_agent_actor` / `stop_agent_actor` consumer-only; herobids calls them from the session manager, never an agent, and they must not appear in any agent tool surface (they already don't on the traderton side).
- Intelligence agents (no scanner) are out of scope here beyond sending `scanMode: null`; their wake behaviour (watch/discovery/regime/reminder/user-message) is unchanged and is by design.

## References

- traderton `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/003-e1-agent-scan-loop-plan.md` (E1-H = Part A; also the authoritative T1 ownership rule and the T5 lifecycle-tool contract)
- traderton `docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/002-e3-consumer-event-channel-plan.md` (E3-H = Part B; event vocabulary table + relay spec)
- herobids `docs/tech/agents/wake-signal-and-technical-scan.md` (the runtime wake consumer you feed)
- herobids `git show 45271d28^:apps/worker/src/index.ts` (the pre-extraction in-process lifecycle wiring being restored as boundary calls)
- herobids `apps/worker/src/alerting/alert-dispatcher.ts` (lease + poll-loop shape to copy for the relay)
- herobids `apps/worker/src/alerting/boundary-trade-event-feed.ts` (boundary-read adapter pattern to copy)
- herobids `apps/worker/src/agents/agent-decision-handler.ts` (how to construct the write-boundary subject + resolve the agent's venue account/owner — reuse for the lifecycle calls)
- herobids `apps/api/src/agents/trading-profile-reconciliation-saga.ts` + `trading-profile-reconciliation.ts` (the profile payload to extend in A1)
