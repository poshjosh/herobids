# Decision Brief 002: Agent residency versus hibernation

> **Closed 2026-11-11.** Decided by the owner (C-12, C-13). See [D-2026-001](../records/D-2026-001-residency-vs-hibernation.md). Kept as the record of what was asked. Its section 6 ("What I could not determine") predates framework v0.2 and would now fail the readiness checklist: U2, U5 and U6 were owner facts to ask up front, and U3 and U4 were code-checkable.

**Brief ID:** 002
**Requester:** framework author (neutral brief; no option is preferred here)
**Date:** 2026-11-11
**Tier (best guess):** T2 (TR2 may touch P-03 and ADR-2026-06-003; TR3 R2; TR5 recurring cost; TR8 may change the product promise)
**Cost of delay:** Low for the next weeks: nothing is built on either answer yet. It rises once node sizing (OD-07), control-plane scale (OD-04) and the autoscaling kit (OD-01) are decided, because all three assume a count of resident agents.
**Decision needed by:** before OD-07 and OD-04 are decided
**Open dependency:** OD-09 (unit-economics targets) is not yet set by the owner.

## 1. Problem (plain language)

At the target scale we expect about 10,000 agent containers to be up at once, while the owner estimates only about 200 are actively working at any moment. Each resident agent reserves up to 256 MB, so the idle majority drives most of the infrastructure bill. We could keep every agent resident (today's behaviour), or stop idle agents' containers and start them again when something needs them. Hibernating saves money but must not lose an agent's context, drop wake-ups, or break what users were told they were buying.

## 2. The question

Should agents stay resident at all times, or should some or all idle agents be hibernated (container stopped, state kept) and woken on demand, and under what conditions?

## 3. Context the requester knows applies

| Kind | IDs |
|---|---|
| Strategic objectives | SO-1 (affordable), SO-2 (reliable long-running agents), SO-3 (scale without linear effort) |
| Invariants | INV-S1, INV-S2 (no lost or duplicated work), INV-S4 (agent mode purity), INV-E8 (abstract only when proven) |
| Register rows | P-01 (review-triggered), P-03 (brief pauses acceptable), ADR-2026-06-002 (Redis Streams transport, at-least-once), ADR-2026-06-003 (one container per agent runtime) |
| Assumptions | A-01, A-02, A-05, A-11, A-12 |
| Limitations | L-09 (starting an agent takes time) |
| Open decisions | OD-03 (this), depends on OD-09. Feeds OD-04, OD-07, OD-01 |

## 4. Grounded facts

| # | Fact | Source | Grade |
|---|---|---|---|
| F1 | Target envelope: about 10,000 agent containers up at once, about 200 actively working at once (30 minute average session), 256 MB reserved per agent (actual 64 to 128 MB) | [01-strategy.md](../01-strategy.md) section 4, A-01, A-02, A-05 | O |
| F2 | Runtime model: one container per agent. On staging each agent is a Nomad job in namespace `herobids-agents`. Eight agents ran on 2026-11-10 | ADR-2026-06-003; live `nomad job status` on staging, 2026-11-10 | V |
| F3 | **Billing is by resident wall-clock time.** `UsageBillingService` charges `agent.runtime_ms` in windows measured from the session start until the session is closed, regardless of ticks or tool use. Rate: 100 micro-USD per 60,000 ms, which is $0.0001 per minute, about $4.32 per 30-day month per resident agent | `apps/worker/src/usage-billing-service.ts:61,380-396,446-465`; `config/default.yaml:960-963` | V (mechanism) / derived (monthly figure) |
| F4 | Internal cost note: cx23 is about $5 a month (marked up), actual agent use "max 128 MB", "cx23 can take 5 agents (each with a max of 256 MB)", target contribution $1 per agent per month, runtime price set to $0.0001 per minute. The note's "5 agents per node" disagrees with 4 GB / 256 MB (about 14 slots) used in the scheduler arithmetic | `docs/product/cost.md` | V (doc exists) / O (its figures) |
| F5 | Scheduling reservation: free and starter agents reserve 256 MB (soft `MemoryMB`) with a hard `MemoryMaxMB` ceiling; pro agents reserve 1,024 MB | `apps/worker/src/agents/nomad-runtime-adapter.ts:274-275`; `config/default.yaml` resource profiles (lines ~611-626) | V |
| F6 | Idle behaviour: each agent runs a tick loop. Default LLM tick interval is 15 minutes (`llm.tickIntervalMs: 900000`); non-trading agents default to 24 hours (`nonTradingDefaults.tickIntervalMs: 86400000`); skills suggest 5 to 15 minutes. Heartbeat every 5 seconds. Tick gates can skip the LLM call (context unchanged, outside active hours, unfavourable regime) | `config/default.yaml:327-329,697`; `packages/domain/src/skills.ts` (`suggestedTickIntervalMs`); `apps/worker/src/tick-gates.ts` | V |
| F7 | Early wake-ups exist: user messages run the next tick immediately; wake signals and price watches can pull a tick forward subject to a minimum interval | `apps/worker/src/agent-wake-scheduler.ts` | V |
| F8 | The market-intelligence monitor is described as an "always-on discovery coordinator and monitor" that wakes agents. Whether wake detection lives wholly outside agent containers was not fully read | `config/default.yaml:699-700` | V (comment) / I (placement) |
| F9 | **State today:** the agent's conversation timeline lives in container memory and is lost on restart; only `answeredUpToTs` is persisted in Redis. Hydration on start (Phase 2) is planned, not started, estimated 1 to 3 days. The local workspace lasts for the container's lifetime | `docs/features/pending/000-agent-conversation-hydration/001-plan.md`; [010-objectives.md](../../features/2026/10/30/001-agent-continuity-and-safe-capacity/010-objectives.md) section 1 | V |
| F10 | Accepted direction (P-03): brief automatic pauses are acceptable; live in-memory migration is not promised. Conversation context, explicit memory, settings, durable files and pending work must each have a defined recovery owner. Trading positions and execution state stay authoritative in Traderton; the agent restores context rather than owning it. Recovery deadlines were not yet measured or approved | 010-objectives.md section 2 (O1) | V |
| F11 | Start path: the worker places a Nomad job; the agent must connect within a 120 second boot window (`placedStartTimeoutMs`) or the worker purges the job. Cold image pulls can exhaust it. Mass restarts are spaced 30 seconds apart. Typical warm start time has not been measured | [rollout guide](../../tech/agents/agent-runtime-rollout-guide.md) section 3; `infra/hetzner/scripts/maintenance-restart.sh` | V (limits) / not measured (typical) |
| F12 | Product policy: full agent runtime is a paid capability. Hard billing limits currently skip ticks. Protective exits that survive suspension must be user-authored and pre-armed, for example venue-native reduce-only orders | `docs/product/agent-runtime-billing-and-protective-exits.md` | V |
| F13 | Vision wording: "long-running AI agents affordable and simple enough to live and work alongside you"; "should remain in contact" (users reach an agent through messaging apps or email) | [vision.md](../../vision.md) | V |
| F14 | Sizing arithmetic at the envelope: 10,000 x 256 MB is about 2.5 TB reserved. At about 14 slots per cx23 that is about 700 nodes; at about 120 slots per cx53 about 85 nodes. How many agents could be hibernated depends on tick intervals and watches, which are unknown (U1) | strategy section 4; A-09 | I |
| F15 | The agent autoscaler was designed for 200 to 2,000+ agents (P-01, review-triggered) | [orchestration plan](../../features/2026/07/08/004-orchestration/002-implementation-plan.md) | V |

## 5. Candidate options (not ranked)

- **Option A: Keep every agent resident.** Status quo. Rely on node sizing, reservation tuning and autoscaling for cost.
- **Option B: Hibernate idle agents generally.** After a period with no work, stop the container and keep durable state. Wake on user message, reminder, watch or scheduled tick by starting a new container.
- **Option C: Tiered residency.** Resident for agents that need low latency or frequent ticks (for example trading agents, short tick intervals, active watches). Hibernate agents with long tick intervals or only occasional triggers.
- **Option D: Lower the per-agent footprint instead.** Keep agents resident but reduce what each costs, for example a lower soft reservation, or hosting several agents per container. Hosting several agents per container would reopen ADR-2026-06-003.
- **Option E: Defer.** Keep agents resident now. Build prerequisites (conversation hydration, wake-signal placement, measurements) and decide with real demand data.

The decision agent may derive a better option and must include a baseline.

## 6. What I could not determine

| # | Unknown | How to find out |
|---|---|---|
| U1 | The real distribution of tick intervals, tick duration and active share per agent, and how many agents hold watches or reminders | Query staging `agents` and usage tables; once real users exist, the Plan 005 recording approach applies |
| U2 | Typical warm and cold start time of an agent container | Time `agent_runtime_sessions` from `starting` to `running` on staging; check worker logs |
| U3 | What else exists only in container memory: workspace files, in-flight tool state, reminders, schedule state | Read `apps/worker/src/agent.ts` state handling and `agent-session-manager.ts` |
| U4 | Where wake signals, watches and reminders are evaluated and stored (platform side or inside the container) | Read the watch system, market-intelligence monitor and reminder code |
| U5 | Pricing policy while hibernated: is the time billed, at what rate, and is the change acceptable to users | Owner product decision (links to OD-09) |
| U6 | Acceptable wake latency for chat and for time-sensitive tasks | Owner or product input; compare with the 120 second boot window |
| U7 | Actual cost per resident agent versus the `cost.md` assumption of 5 per node | Nomad allocation stats; scheduler slot arithmetic |
| U8 | Whether container checkpoint and restore is a workable alternative | Not investigated |
| U9 | Whether trading agents need a resident process for any protective behaviour beyond venue-native orders | Read Traderton tick and watch paths; check with the trading owner |

## 7. Constraints specific to this decision

- No duplicated or lost external actions, and acknowledged work is not lost (INV-S1, INV-S2). Hibernation must define the wake handover and the recovery owner of each kind of state.
- Billing is by resident wall-clock time today (F3). Any change to what is billed is a product and legal-adjacent decision for the owner.
- Agent mode purity (INV-S4): the platform must not impose hidden constraints on how an agent behaves because of residency.
- Staging has eight paper-mode agents only, so scale behaviour cannot be observed there (L-03).

## 8. Out of scope

- Autoscaling mechanics (OD-01) and node sizing (OD-07).
- The specific price to charge (OD-09).
- Implementing hibernation or conversation hydration.
