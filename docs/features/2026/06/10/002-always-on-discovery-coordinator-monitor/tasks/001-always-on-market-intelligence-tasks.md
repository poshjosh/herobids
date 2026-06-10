# Always On Market Intelligence Task List

**Epic:** 001 (Always-on discovery, coordinator, monitor)
**Depends on:**
- [000-epic.md](../000-epic.md)
- [001-q-and-a.md](../001-q-and-a.md)
- [event-and-wakeup-contract.md](../references/event-and-wakeup-contract.md)
- [shared-market-state.md](../references/shared-market-state.md)
- [monitor-rules.md](../references/monitor-rules.md)

**Goal:** Build the worker-embedded always-on market intelligence loop that maintains shared market state, evaluates monitors outside agent ticks, and emits durable market events plus bounded wakeups.

---

## Tasks

### T1: Extend protocol for market events and wake requests

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** None

Extend the worker-to-agent protocol and publisher path so the runtime can deliver durable market-monitor facts and bounded wake requests through the existing outbound stream.

Scope:
- add protocol message types for market-monitor events and wake requests
- extend the outbound publisher with helpers for these message families
- define the minimal payload types and validation shape in code
- keep the transport on the existing `agent:outbound:{agentId}` path

**Files:** `packages/domain/src/agent-protocol.ts`, `apps/worker/src/agents/instance-event-publisher.ts`, nearby protocol tests if present
**Acceptance:** The codebase has canonical typed message definitions for market events and wake requests, and the worker can publish them through the existing outbound stream path without introducing a second transport.

---

### T2: Teach the agent scheduler to honor bounded wake requests

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T1

Update the runtime scheduler so an agent can run earlier than its normal interval when a wake request is pending, without creating concurrent ticks or uncontrolled interrupts.

Scope:
- read and classify wake messages at tick start
- add `wakePending` state or equivalent scheduler state
- allow an early next tick when the runtime is idle
- enforce a hard minimum wake interval and preserve the existing no-concurrent-ticks guarantee

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/agents/outbound-message-reader.ts` or nearby message-consumption code, targeted scheduler tests if present
**Acceptance:** A wake request can pull the next tick earlier than the normal interval, but the runtime never runs two ticks concurrently and repeated wakes are bounded by cooldown logic.

---

### T3: Move watch evaluation onto the event-driven path

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T1, T2

Implement the fastest user-visible slice first by moving watch threshold evaluation out of the purely pull-based tool path and into a worker-driven monitor path.

Scope:
- reuse existing watch storage definitions from `watch.ts`
- evaluate watch thresholds in the worker outside normal agent ticks
- emit one durable `market.watch.triggered` event per crossing
- request a bounded wake when a watch fires
- preserve edge-trigger semantics so staying above or below the threshold does not spam events

**Files:** `apps/worker/src/tools/watch.ts`, new or nearby worker monitor module, `apps/worker/src/agent.ts` if scheduler integration is needed, tests around watch behavior
**Acceptance:** A watch crossing produces exactly one monitor event per crossing and can cause an earlier bounded tick. Existing `check_watches` behavior remains usable as a fallback rather than becoming the primary trigger path.

---

### T4: Add worker leader election and coordinator lifecycle

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** None

Introduce a single active market-intelligence leader inside the worker so shared-state refresh and monitor evaluation do not run on every worker instance at once.

Scope:
- add Redis lease acquisition and renewal for market intelligence leadership
- start and stop coordinator loops based on lease ownership
- make non-leader workers passive readers only
- fail closed if lease renewal is lost

**Files:** `apps/worker/src/runtime.ts`, `apps/worker/src/index.ts`, new leader/coordinator module under `apps/worker/src/`, Redis lifecycle tests if present
**Acceptance:** Only one worker instance acts as the coordinator leader at a time in normal operation, and leadership is relinquished promptly if lease renewal fails.

---

### T5: Build shared discovery snapshots and freshness metadata

**Status:** not-started
**Approach:** End-to-end
**Effort:** Large (1-2 sessions)
**Depends on:** T4

Create the deployment-wide shared discovery state layer backed by Redis using the existing provider registry and discovery primitives.

Scope:
- poll discovery sources on a fixed cadence from the leader
- write merged discovery snapshots and metadata to Redis
- track freshness state explicitly as `fresh`, `stale`, or `unavailable`
- expose the snapshot id and source-health metadata needed by monitors and readers

**Files:** `packages/market-data/src/discovery.ts`, `packages/market-data/src/provider-registry.ts`, new worker coordinator/shared-state module, targeted tests around snapshot freshness if present
**Acceptance:** Discovery state refreshes continuously without agent tool calls, shared snapshots exist in Redis with explicit freshness metadata, and provider failure marks the state stale or unavailable instead of silently fresh.

---

### T6: Add anti-staleness and shared monitor state storage

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T5

Store the shared hot state needed for repeat suppression, novelty ranking, dedupe, and wake coalescing.

Scope:
- persist anti-staleness tracking for recently surfaced discovery candidates
- persist dedupe keys for monitor events
- persist per-agent wake coalescing state
- keep Redis structures small, explicit, and safe to rebuild after failover

**Files:** new worker coordinator/shared-state modules, Redis helper code near the worker runtime, tests for dedupe and anti-staleness state if present
**Acceptance:** The coordinator can suppress duplicate discovery or monitor emissions using shared Redis state, and the system can resume safely after leader failover without depending on in-memory counters for correctness.

---

### T7: Add discovery delta monitor events

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T5, T6

Expand the monitor beyond threshold watches so the platform can surface new discovery opportunities from shared snapshots.

Scope:
- compare previous and current discovery snapshots
- emit discovery delta reasons such as `entered_top_set`, `reappeared_after_cooldown`, and `multi_vector_confirmation`
- apply dedupe and cooldown windows from the monitor rules spec
- wake the relevant agents using coalesced wake requests

**Files:** new worker monitor module, shared-state module, `apps/worker/src/agents/instance-event-publisher.ts` if payload helpers expand, tests around discovery deltas
**Acceptance:** Discovery delta events fire once per relevant transition window, do not repeat every poll while the state is steady, and can schedule a bounded earlier tick for subscribed agents.

---

### T8: Add regime-change monitor events

**Status:** not-started
**Approach:** Vertical slice
**Effort:** Medium (1 session)
**Depends on:** T5, T6

Add shared regime monitoring for a small set of benchmark symbols so agents can react faster to meaningful market-state flips.

Scope:
- refresh and store shared regime snapshots for configured benchmarks
- detect meaningful state changes rather than re-emitting steady-state results
- emit regime-change events with cooldown protection
- wake relevant agents through the same bounded wake path

**Files:** worker coordinator and monitor modules, existing regime evaluation integration points in market-data, tests around regime change triggers
**Acceptance:** Meaningful regime flips produce one event per change direction within the configured cooldown window, and steady-state reevaluation does not create duplicate notifications.

---

### T9: Add wake coalescing, rate limits, and overflow handling

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T2, T3, T6

Harden the wake path so noisy markets do not turn monitor activity into runaway LLM usage.

Scope:
- coalesce multiple nearby event ids into one wake request per agent
- enforce per-agent wake cooldowns
- cap event burst rates by monitor family
- emit summary or suppression telemetry when limits are hit

**Files:** worker monitor and wake-coalescing modules, `apps/worker/src/agent.ts`, observability code near the worker runtime, tests around wake suppression
**Acceptance:** Multiple nearby triggers can produce one wake request, repeated wakes are rate-limited, and overflow behavior suppresses wake spam while preserving durable market events when possible.

---

### T10: Add observability, degraded-mode behavior, and rollout controls

**Status:** not-started
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T3, T4, T5, T9

Complete the rollout-safe version of the feature so failures are explicit, diagnosable, and reversible.

Scope:
- add metrics and structured logs for leader health, snapshot freshness, dedupe, wake suppression, and publish failures
- make monitor families independently disableable if needed
- preserve tick-based discovery and `check_watches` as fallback paths when monitor-driven wakeups are unavailable
- document any required operator flags or config knobs

**Files:** worker runtime/coordinator/monitor modules, config schema if feature flags are added, relevant docs if rollout flags need documentation
**Acceptance:** The feature has explicit health and failure signals, degraded operation is visible rather than silent, and the existing tick-based behavior remains a fallback if the always-on path is unavailable.

---

## Parallelization Notes

- **T1** and **T4** can start in parallel.
- **T2** depends on **T1**.
- **T3** depends on **T1** and **T2** because watch events need the protocol and wake path.
- **T5** depends on **T4** because shared snapshot refresh needs a leader-owned lifecycle.
- **T6** depends on **T5**.
- **T7** and **T8** can proceed in parallel after **T5** and **T6** are done.
- **T9** should land after the first wake-driven slices exist so the limits are shaped by real event flow.
- **T10** should be the final hardening pass.

```text
T1 (protocol + publisher) → T2 (wake scheduling) → T3 (watch notifications) ──┐
                                                                               ├→ T9 (coalescing + rate limits) → T10 (hardening)
T4 (leader election) → T5 (shared snapshots) → T6 (shared monitor state) ─────┤
                                                                               ├→ T7 (discovery deltas)
                                                                               └→ T8 (regime changes)
```

---

## Recommended First Slice

Start with **T1 + T2 + T3**.

That sequence validates the most important architectural question first:
- can the worker emit durable monitor facts
- can the runtime schedule an earlier bounded tick safely
- can a real watch crossing move from pull-only behavior to event-driven behavior

If that slice works, the rest of the coordinator and shared-state work expands from a proven path rather than a speculative one.