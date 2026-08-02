# 005 — Wake-Driven Cost Reduction Test Plan

**Status:** Done  
**Created:** 2026-07-08  
**Implements:** `docs/features/2026/07/08/005-wake-driven-cost-reduction/001-plan.md`

## Goal

Validate the two least-covered parts of 005 before rollout:

1. **Runtime integration (B2-B4)**
   - pending market context storage
   - prompt rendering
   - market-event digest integration with the tick gate
   - post-consumption hash behavior
2. **Redis projection and recipient resolution (C3-C4)**
   - active-session tracking
   - wake-preference projection
   - recipient filtering for monitor-owned sources
   - immediate effect of API updates without runtime restart
3. **Staging smoke test**
   - one end-to-end path that exercises agent creation, preference updates, Redis state, and observable worker/monitor behavior

This plan deliberately focuses on the highest-risk, lowest-automated surfaces added by 005. Source-scoped cooldowns and monitor mode-selection already have direct unit coverage and are not the primary gap.

## Scope

### In scope

- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/tick-gates.ts`
- `apps/worker/src/tick-gate-state.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/market-intelligence/monitor.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/api/src/routes/agents.ts`

### Out of scope

- Full UI browser UAT beyond confirming `wakePreferences` can be edited
- Non-monitor wake producers (`reminder`, `scanner`) beyond verifying they are not broken by the new subscription filter
- Cost benchmarking against production traffic volumes

## Test Strategy

Run validation in three layers, in this order:

1. **Targeted worker integration tests** for B2-B4
2. **Targeted worker/API integration tests** for C3-C4
3. **Staging smoke test** using real Redis, worker, and API processes

The expected outcome is not just “tests pass,” but “we can prove the new wake policy changes are visible in runtime state, Redis state, and worker logs.”

## Part 1 — Runtime Integration Tests (B2-B4)

### Purpose

Verify that context-only market events survive the trip from the outbound stream into runtime state, affect skip decisions correctly, appear in the prompt exactly once, and are cleared safely after use.

### Primary code seams

- `applyRuntimeMessage()` in `apps/worker/src/runtime-composition.ts`
- `computeMarketEventDigest()` in `apps/worker/src/runtime-composition.ts`
- `buildTickUserContext()` in `apps/worker/src/runtime-composition.ts`
- `buildTickGateState()` in `apps/worker/src/tick-gate-state.ts`
- `computeDecisionContextHash()` and `shouldSkipTick()` in `apps/worker/src/tick-gates.ts`
- `runTick()` hash persistence path in `apps/worker/src/agent.ts`

### Recommended test file layout

- Extend `apps/worker/src/runtime-composition.test.ts` if present; otherwise add it
- Extend `apps/worker/src/tick-gates.test.ts` if present; otherwise add focused cases there
- Add a narrow worker integration test around `runTick()` only if the existing test harness already supports it

### Required test cases

#### B2.1 Stores context-only market events as structured pending context

**Setup**

- Create a fresh `RuntimeCompositionState`
- Apply one `market.discovery.detected` message
- Apply one `market.regime.changed` message

**Assertions**

- `state.metrics.pendingMarketContext.length === 2`
- Each entry contains `eventId`, `type`, `receivedAt`, and typed payload data
- Neither event sets `currentMarketWake`

#### B2.2 Deduplicates by `eventId`

**Setup**

- Apply the same `market.discovery.detected` message twice

**Assertions**

- Only one pending event remains
- The digest is stable across repeated duplicate deliveries

#### B2.3 Caps pending context at 50 events

**Setup**

- Apply 51 distinct context-only market events

**Assertions**

- Buffer length is 50
- Oldest entry is dropped
- Newest event remains present

#### B2.4 Does not duplicate prompt context when wake and market event arrive in the same tick

**Setup**

- Apply `agent.wake` with `source: 'discovery_delta'`
- Apply matching `market.discovery.detected`
- Build tick user context

**Assertions**

- Prompt includes discovery context once, not twice
- `pendingMarketContext` is filtered correctly when the wake already owns the event

Repeat with reverse order:

- Apply `market.discovery.detected`
- Apply `agent.wake` with `source: 'discovery_delta'`
- Build tick user context

**Assertions**

- Same single-render guarantee holds

#### B3.1 Market-event digest is stable and changes only when event identity changes

**Setup**

- Compute digest for empty array
- Compute digest for one event
- Compute digest for the same event repeated
- Compute digest for a different `eventId`

**Assertions**

- Empty buffer returns `'__none__'`
- Same logical set produces the same digest
- Different `eventId` changes the digest

#### B3.2 Context hash changes when market-event digest changes

**Setup**

- Build two `TickGateState` inputs that differ only in `marketEventDigest`

**Assertions**

- `computeDecisionContextHash()` output differs

#### B3.3 New context-only events prevent `context_unchanged` skip

**Setup**

- First tick: build a gate state with `marketEventDigest: '__none__'` and persist the resulting `previousContextHash`
- Second tick: same market/position inputs, but `marketEventDigest` now reflects a pending discovery or regime event

**Assertions**

- `shouldSkipTick()` returns `skip: false`
- The non-skip reason is the changed context hash, not a wake signal

#### B4.1 Post-consumption hash does not force one extra LLM tick

**Setup**

- Simulate a tick where `marketEventDigest !== '__none__'`
- Run the prompt-building path so `buildTickUserContext()` clears `pendingMarketContext`
- Persist the recomputed post-consumption hash the same way `agent.ts` does
- Build the next tick with no new events and identical market state

**Assertions**

- The next tick is eligible for `context_unchanged` skip
- No artificial hash drift remains after consumption

#### B4.2 Pending market context is cleared after the tick

**Setup**

- Queue one context-only event
- Build tick user context

**Assertions**

- `pendingMarketContext` is empty after the tick
- `currentReminder` and `currentMarketWake` cleanup behavior remains unchanged

### Exit criteria for Part 1

- All required B2-B4 cases exist as automated tests
- No assertion relies on log text for correctness
- At least one test proves the post-consumption hash fix in `agent.ts`

## Part 2 — Redis Projection and Recipient Resolution Tests (C3-C4)

### Purpose

Verify that the worker and API maintain the Redis projection correctly and that the market monitor reads that projection correctly for all monitor-owned sources.

### Primary code seams

- `registerSurvivedSessions()` in `apps/worker/src/agents/agent-session-manager.ts`
- `handleHeartbeat()` in `apps/worker/src/agents/agent-session-manager.ts`
- `stopSession()` and `handleRuntimeSessionEnd()` in `apps/worker/src/agents/agent-session-manager.ts`
- PATCH update flow in `apps/api/src/routes/agents.ts`
- `getSubscribedAgentIds()` in `apps/worker/src/market-intelligence/monitor.ts`
- watch-threshold gating path in `evaluateWatches()`

### Recommended test file layout

- Extend `apps/worker/src/agents/agent-session-manager.test.ts` if present; otherwise add focused coverage there
- Extend `apps/worker/src/market-intelligence/monitor.test.ts`
- Add or extend API route tests for `apps/api/src/routes/agents.ts`

### Required test cases

#### C3.1 First activation creates Redis projection for a new session

**Setup**

- Fresh Redis mock
- Start one agent session with explicit `wakePreferences`
- Trigger the first heartbeat path that marks the session active

**Assertions**

- `agent:sessions:count:{agentId}` is `1`
- `agent:sessions:active` contains the agent ID
- `agent:wake:prefs:{agentId}` contains serialized `wakePreferences`

#### C3.2 Multiple concurrent sessions ref-count correctly

**Setup**

- Activate two sessions for the same agent
- Stop one session
- Stop the second session

**Assertions**

- Count increments to `2`
- After the first stop, active membership remains and prefs key remains
- After the final stop, active membership and keys are removed

#### C3.3 Restart recovery rebuilds projection from survived sessions without double increment

**Setup**

- Seed survived `running` sessions in the repository layer
- Run `registerSurvivedSessions()`
- Then process recovery heartbeats for those sessions

**Assertions**

- Count is set from DB state during rebuild
- Recovery heartbeat does not increment again
- `agent:sessions:active` membership remains correct

#### C3.4 PATCH update syncs wake preferences into Redis without restart

**Setup**

- Agent is active and already present in Redis
- Send PATCH with `wakePreferences: { subscribedSources: ['watch_threshold'] }`
- Then send PATCH with `wakePreferences: null`

**Assertions**

- First PATCH updates `agent:wake:prefs:{agentId}` immediately
- Second PATCH deletes the prefs key immediately
- No runtime restart path is involved

#### C4.1 `getSubscribedAgentIds()` returns active agents with no prefs key

**Setup**

- Add active agents to `agent:sessions:active`
- Leave prefs keys absent

**Assertions**

- All active agents are returned for `discovery_delta` and `regime_change`

#### C4.2 `getSubscribedAgentIds()` filters correctly when prefs are restricted

**Setup**

- Three active agents:
  - one with no prefs
  - one with `['watch_threshold']`
  - one with `['discovery_delta', 'regime_change']`

**Assertions**

- `getSubscribedAgentIds('discovery_delta')` returns agents 1 and 3
- `getSubscribedAgentIds('regime_change')` returns agents 1 and 3
- `getSubscribedAgentIds('watch_threshold')` is not used for discovery/regime, but watch-threshold gating separately honors the same policy

#### C4.3 `evaluateWatches()` excludes stopped agents even if stale watch keys remain

**Setup**

- Leave an `agent:watches:{agentId}` key present
- Ensure the agent is not in `agent:sessions:active`

**Assertions**

- No watch event emitted
- No wake enqueued

#### C4.4 `evaluateWatches()` checks prefs once per agent per evaluation cycle

**Setup**

- One agent with multiple triggered watches
- Spy on `redis.get('agent:wake:prefs:{agentId}')`

**Assertions**

- Preferences are fetched once for that agent in that evaluation cycle
- Trigger count does not multiply Redis lookups

#### C4.5 Malformed prefs JSON fails open, not closed

**Setup**

- Active agent with malformed JSON in `agent:wake:prefs:{agentId}`

**Assertions**

- Agent is treated as subscribed to all monitor-owned sources
- Warning path is observable if logging is already covered

### Exit criteria for Part 2

- Automated coverage proves the Redis projection is accurate through start, stop, restart, and PATCH-update flows
- At least one test proves `evaluateWatches()` respects both active-session state and subscription filtering
- At least one test proves `getSubscribedAgentIds()` is no longer watch-key based

## Part 3 — Staging Smoke Test

### Purpose

Exercise the end-to-end path with the real control plane, real Redis, real worker logs, and real API updates before production rollout.

### Pre-requisites

- Base staging stack is green
- Nomad staging orchestration prerequisites from `docs/features/2026/07/08/004-orchestration/004-staging-runbook.md` are met
- Worker is healthy and connected to Redis/Postgres
- One staging connection exists so an agent can be created

### Test data

- One dedicated staging agent, e.g. `wake-smoke-<date>`
- One trading-capable connection
- One watch owned by that agent for `watch_threshold` verification

### Evidence to capture

- API request/response bodies for create and PATCH operations
- Redis key snapshots before and after PATCH
- Worker logs showing watch/discovery/regime routing decisions
- Agent outbound stream evidence or worker-side lifecycle logs

### Step-by-step smoke path

#### Step 1 — Create a staging agent with default wake behavior

Create an agent through API or web UI with no `wakePreferences` field.

**Verify**

- Agent starts successfully
- Redis contains:
  - membership in `agent:sessions:active`
  - `agent:sessions:count:{agentId} = 1`
  - no `agent:wake:prefs:{agentId}` key

**Suggested commands**

```bash
redis-cli SMEMBERS agent:sessions:active
redis-cli GET agent:sessions:count:<agentId>
redis-cli GET agent:wake:prefs:<agentId>
```

Expected result: no prefs key means “all monitor-owned sources.”

#### Step 2 — Restrict the agent to `watch_threshold`

PATCH the agent:

```json
{
  "wakePreferences": {
    "subscribedSources": ["watch_threshold"]
  }
}
```

**Verify immediately**

- Redis key `agent:wake:prefs:{agentId}` appears without restart
- Worker remains healthy; no agent restart occurs

**Suggested commands**

```bash
redis-cli GET agent:wake:prefs:<agentId>
docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=100 worker
```

#### Step 3 — Confirm discovery/regime no longer target the agent

Allow the market monitor to run long enough to process at least one discovery or regime cycle.

**Verify**

- Discovery/regime logs no longer show the agent ID as a selected recipient
- No new `agent.wake` or outbound market-monitor events are emitted for that agent from those sources

**Evidence options**

- worker logs filtered by agent ID and `discovery_delta` / `regime_change`
- outbound stream inspection if needed

**Suggested commands**

```bash
docker compose -f docker-compose.yaml -f docker-compose.staging.yaml logs --tail=300 worker | grep -E '<agentId>|discovery_delta|regime_change|watch_threshold'
redis-cli XRANGE agent:outbound:<agentId> - + COUNT 50
```

#### Step 4 — Confirm watch-threshold still reaches the agent

Trigger or wait for a known watch-threshold event owned by that agent.

**Verify**

- `market.watch.triggered` is emitted for the agent
- A `watch_threshold` wake is enqueued or emitted according to current mode
- Worker/agent logs show the event path

This proves the subscription filter is selective, not globally muting the agent.

#### Step 5 — Clear `wakePreferences` back to default

PATCH the agent:

```json
{
  "wakePreferences": null
}
```

**Verify immediately**

- `agent:wake:prefs:{agentId}` is deleted
- Agent remains in `agent:sessions:active`
- Discovery/regime can target the agent again on subsequent monitor cycles

#### Step 6 — Stop the agent and verify projection cleanup

Stop the agent normally.

**Verify**

- agent ID removed from `agent:sessions:active`
- `agent:sessions:count:{agentId}` removed or decremented to zero then removed
- `agent:wake:prefs:{agentId}` removed

This confirms no stale routing state survives agent shutdown.

### Optional high-confidence staging extension for `context` mode

The default config validates `batched` and `wake` behavior, but does **not** prove the context-only runtime path in a live environment because `discovery_delta` and `regime_change` default to `batched`.

If you want maximum confidence before production rollout, perform a temporary staging-only override:

```yaml
marketIntelligence:
  wakePolicy:
    discovery_delta:
      mode: context
      cooldownMs: 300000
```

Then verify:

- `market.discovery.detected` still appears in the outbound stream
- no `agent.wake` is emitted for that source
- the next scheduled tick is not skipped as `context_unchanged`
- prompt/log evidence shows pending market context was consumed once

Revert the override after the smoke test.

## Execution Order

1. Add and pass Part 1 automated tests
2. Add and pass Part 2 automated tests
3. Run the Part 3 staging smoke test on a fresh staging agent
4. Attach evidence to the rollout thread or feature notes

## Sign-off Criteria

005 is ready for production rollout when all of the following are true:

- B2-B4 automated coverage exists and passes
- C3-C4 automated coverage exists and passes
- Staging smoke test proves:
  - Redis projection updates on create, PATCH, and stop
  - watch-threshold still routes when subscribed
  - discovery/regime stop routing when unsubscribed
  - clearing `wakePreferences` restores default routing
- Optional but recommended: one live staging pass of `context` mode behavior is completed and documented

## Open Risks To Track Separately

- Theoretical Redis projection race windows during startup recovery remain low-severity follow-ups
- `computeMarketEventDigest()` ordering stability is a low-severity follow-up
- The root `pnpm lint` project-reference gap remains a separate repo-level issue