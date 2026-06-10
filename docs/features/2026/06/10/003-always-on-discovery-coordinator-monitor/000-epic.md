# ALWAYS ON DISCOVER, COORDINATOR, MONITOR

**Related Documents**

- [Q&A](./001-q-and-a.md)
- [Event And Wakeup Contract](./references/event-and-wakeup-contract.md)
- [Shared Market State](./references/shared-market-state.md)
- [Monitor Rules](./references/monitor-rules.md)
- [Task List](./tasks/001-always-on-market-intelligence-tasks.md)

**Goal Statement**

Build an always-on market intelligence loop inside the worker that continuously refreshes shared market opportunity state, evaluates watch and monitor conditions outside agent ticks, and emits event-driven notifications or wakeups so agents can react faster and with fresher context.

**Scope**

In scope:

- Worker-embedded `MarketDataCoordinator` that continuously polls discovery and market-intelligence sources.
- Worker-embedded `MarketMonitor` that evaluates conditions such as watch thresholds and selected market triggers.
- Shared market memory/state in Redis for hot discovery snapshots, freshness, seen-token windows, and monitor outputs.
- Event-driven notification path from monitor results to agent runtime.
- Wakeup/coalescing logic so an agent can be prompted to reason earlier than its normal tick interval.
- Observability, leader election, duplication prevention, and degraded-mode behavior.

Out of scope for v1:

- Platform-owned trading decisions.
- Full standalone service split.
- Broad strategy redesign.
- Full historical analytics warehouse for market state.
- Every possible monitor type from day one.

**Subprojects**

1. Event-Driven Watch Notifications

Move watch evaluation out of the agent-only tool path in watch.ts and into a worker monitor loop. When a threshold crosses, emit a single event and optional wake signal for the owning agent. Keep edge-trigger semantics so the same watch does not fire repeatedly without a reset.

2. Shared Market State and Discovery Snapshotting

Build a coordinator that uses the existing discovery primitives in discovery.ts and registry in provider-registry.ts to maintain deployment-wide snapshots. This is where shared market memory lives: latest discovery candidates, freshness metadata, anti-staleness windows, and normalized opportunity records.

3. MarketMonitor Rules Engine

Add a monitor subsystem that consumes shared state and evaluates explicit rules. Initial rule families should be:
- price-watch thresholds
- discovery delta events such as new candidate entering the top set
- optional regime-change events for broad market state

This should stay declarative and event-oriented, not strategy-oriented.

4. Agent Wakeup and Event Delivery

Define how monitor events reach agents. The existing outbound stream pattern in instance-event-publisher.ts and message definitions in agent-protocol.ts are the natural starting point. The recommended model is:
- publish a structured market event to the agent stream
- emit a bounded wake signal so the agent runs early
- coalesce repeated signals to avoid thrash

5. Reliability and Leadership

Only one active coordinator/monitor leader should run at a time per deployment. If the leader dies, another worker takes over. Duplicate emissions must be suppressed or idempotent. Freshness and degraded states must be explicit.

**Acceptance Criteria**

- Discovery state is refreshed continuously without requiring an agent to call a tool first.
- A registered watch crossing its threshold produces exactly one monitor event per crossing.
- An agent can be woken before its next normal tick when a meaningful monitor event fires.
- Wakeups are coalesced and rate-limited so noisy markets do not create runaway reasoning loops.
- Shared discovery state is deployment-wide, not rebuilt independently by each agent as its primary source of opportunity awareness.
- If provider calls fail, state is marked stale or unavailable rather than silently treated as fresh.
- If the coordinator leader dies, another worker can take over without manual intervention.
- Duplicate worker leaders do not create duplicate notifications in normal operation.
- Agents remain the decision makers; the coordinator and monitor do not place trades or mutate strategy policy.
- Existing tick-based discovery still works as a fallback if monitor-driven wakeups are unavailable.

**Sequencing for Implementation**

1. Define event and wakeup contracts

Add the minimal protocol and Redis contract first. Decide what a “watch triggered” or “market opportunity detected” event looks like, how it is deduplicated, and how wakeup differs from a normal outbound message.

2. Implement event-driven watch notifications

This is the fastest user-visible slice and directly fixes today’s pull-only behavior. It also validates the wakeup architecture before broader coordinator work.

3. Add worker leader election and a coordinator skeleton

Introduce a single active coordinator loop inside the worker. Start with shared discovery snapshot refresh and freshness tracking only.

4. Add MarketMonitor over shared state

Once shared state exists, evaluate watch thresholds and selected market triggers from that state instead of re-querying everything ad hoc.

5. Wire agent wakeups and coalescing

Teach the agent runtime to react to wake signals without turning every market event into an uncontrolled immediate LLM call.

6. Expand monitor rule families carefully

After price watches work, add higher-value monitor classes like new discovery entrants and selected regime shifts.

7. Harden and roll out

Add observability, failover behavior, stale-state handling, rate protections, and rollout controls.

**Recommended Priority**

Recommended priority: medium-high, not absolute top priority.

If the current roadmap includes stronger direct P&L levers like DEX-safety or strategy-quality work, I would still do those first. But within infrastructure/system behavior work, this epic is one of the best next moves because it improves responsiveness, shared state, and platform quality without forcing a full new service boundary.