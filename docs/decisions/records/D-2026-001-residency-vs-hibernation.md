# Decision Record D-2026-001: Agent residency versus hibernation

**Status:** Ratified by the owner (C-12, C-13), 2026-11-11. Revision 2: challenger changes and owner answers applied.
**Date:** 2026-11-11
**Brief:** [briefs/002-residency-vs-hibernation.md](../briefs/002-residency-vs-hibernation.md)
**Decision agent:** Kiro, fresh session, read-only (revision 2 applied by the executor)
**Challenger:** fresh agent; result in section 14 and [D-2026-001-challenger-result.md](./D-2026-001-challenger-result.md)
**Tier:** T2 (TR2, TR3, TR5, TR8)
**Reversibility:** right-sizing and measurements R1. Stopping agents over the hard billing limit (C-13) is customer-visible, so R2 for that stage.
**Code state read:** `herobids` `c2526680` plus 40 uncommitted paths (none touch the cited files, per the challenger); `traderton` `0ea5654`. Config read for staging and production.
**Supersedes:** none. **Superseded by ADR:** [ADR-2026-11-019](../../tech/architecture/adrs/2026/11/019-agents-stay-resident-no-hibernation.md) states the outcome.

## 1. Decision

**Agents stay resident. Hibernation is not implemented.** Cost is handled by right-sizing and by cutting per-agent overhead, after we measure the per-resident limits (Postgres connections first). Agents whose account exceeds its hard billing limit are stopped (C-13); mechanics go to OD-12.

**Escalation gate result:** Settled by precedent (the owner's requirement SE-1 and decisions C-12 and C-13).
**Confidence:** High that hibernation should not be built (owner requirement plus code facts). Medium on the size of the right-sizing saving and on where the first scaling wall is, because both rest on derived figures (grade I).

## 2. Framing

- **Problem:** About 10,000 agent containers may be up at once, most of them waiting. We asked whether to stop the waiting ones and start them on demand to save cost.
- **Cost of delay:** Low. Nothing was built on either answer. The answer unblocks OD-04, OD-07 and OD-14.
- **Why the owner said no:** wake latency (SE-1: tens of seconds is unacceptable). The owner first estimated a start at 45 to 90 s, then withdrew that as a best guess and accepted the staging measurement: median 6.4 s, p90 20.0 s, worst 333.5 s, 3 of 59 sessions over 60 s (A-22). The latency case is therefore weaker than first stated: it rests on the tail and on SE-1, whose wording is not yet quantified. The other reasons (3 and 4 in section 6) still hold. The decision stands until the owner reopens it.
- **Premise check.** Facts in the brief that were false, stale or unworkable:

| # | Brief said | Source says | Grade |
|---|---|---|---|
| P1 | F9: conversation hydration "planned, not started" | Hydration from Postgres is implemented (v0.8.9, `agent.ts:1467-1490,2969-2973`, gated by the enriched prompt style and `conversation.enabled`). The pending plan is stale | V |
| P2 | F11, L-09: 120 s boot window | 120 s and the 600 s capacity wait are **staging only**. Production allows 60 s for the whole start (`config/default.yaml:351-355`, `config/staging.yaml:137-139`) | V |
| P3 | F3 billing by resident time | True, and the meter runs **inside the container**, so a stopped container stops billing (`agent.ts:951-966,2611,4615`) | V |
| P4 | F8 wake detection placement unread | Wake paths gate on agent status or session state, not container state (corrected E11, appendix) | V |
| P5 | U2 method: `starting` to `running` | Not stored. Proxy: `session_started` event at first heartbeat (one row per assigned skill) | V |
| P6 | A-11: P-03 requires residency | P-03 accepts brief pauses; it neither requires residency nor authorises hibernation | V |
| P7 | OD-03: "largest cost lever" | Not on the evidence: node cost ceiling is small next to control-plane work (appendix E6, E8 to E10) | I |
| P8 | F14: 14 slots per cx23 | Memory gives 14, CPU gives 15; halving memory alone gives 15 | V |

- **Requester gaps closed:** U3 and U4 were code-checkable and were answered (appendix E11, E14). U2, U5, U6 were owner facts that should have been asked up front; the owner has now answered (A-22, C-12 billing stance, SE-1). U1 remains kind C (no demand data exists).

## 3. Context used

| Kind | IDs |
|---|---|
| Strategic objectives | SO-1, SO-2, SO-3, SO-4 |
| Service expectations | SE-1 (gate) |
| Invariants | INV-S1, S2 (kept: no wake path is built that could lose or duplicate work), INV-L2 (kept: trading rules not decided here), INV-O3 to O6, INV-E8 |
| Register rows | P-01, P-03, P-08, T-09, ADR-2026-06-002, ADR-2026-06-003 |
| Assumptions | A-01, A-02 (reworded), A-05, A-11 (falsified), A-22, A-23, A-24 |
| Open decisions | OD-03 (closed), OD-04, OD-07, OD-09, OD-12, OD-13, OD-14 |

## 4. Key facts

Full evidence is in the Appendix.

| # | Fact | Source | Env | Grade |
|---|---|---|---|---|
| K1 | Runtime meter lives in the container; rate $0.0001 a minute, about $4.32 per resident agent per 30 days | E1, E2 | both | V |
| K2 | Staging measured start: median 6.4 s, p90 20.0 s, worst 333.5 s, 3 of 59 over 60 s (the owner's 45 to 90 s guess is withdrawn). Production allows 60 s for the whole start | A-22; E20 | staging / production | V |
| K3 | Wake paths (watches, reminders, messages) gate on agent status or session state; none starts a container | E11 (corrected) | both | V |
| K4 | Stopping a session stops the Traderton actor and running bots | E17, T-09 | both | V |
| K5 | Per-agent Postgres pool (up to 10) against default `max_connections` 100, no pooler found | E9 | staging config | V / I |
| K6 | At a hard billing limit the tick is skipped, the user is notified once, session start is blocked, **the container stays up** | E25 | both | V |
| K7 | Node cost ceiling at the envelope: about EUR 3.9k (715 cx23, infeasible) or about EUR 2.5k (about 85 cx53) | E6 | n/a | I |

## 5. Options

| ID | Option | Origin | Invariant and requirement gate |
|---|---|---|---|
| O0 | Baseline: keep every agent resident, change nothing | Agent | Pass |
| O1 | Hibernate idle agents generally | Requester | **Fails SE-1** (latency); fails INV-S2 today for wakes and INV-S1/L2 for trading agents |
| O2 | Tiered residency: hibernate only long-horizon agents | Requester | **Fails SE-1** for any message, watch or reminder wake |
| O3 | Stay resident; right-size reservation (memory and CPU together) and cut per-agent overhead (heartbeat rate, connections, pooler) | Requester / Agent | Pass |
| O4 | Defer: build prerequisites now, decide on demand data | Requester | Pass (INV-E8 risk) |
| O5 | Stop (not hibernate) agents over their hard billing limit and not trading | Challenger W2 | Pass for non-trading. Trading agents need OD-13 (T-09, P-08, INV-S1/S2) |

### Ratings against the baseline (-2 to +2)

| Criterion | O1 | O2 | O3 | O4 | O5 |
|---|---|---|---|---|---|
| C2 Risk and safety | -2 five paths lose wakes or stop bots | -1 same, smaller | 0 OOM risk if misjudged, measured first | 0 | -1 for trading agents until OD-13; 0 otherwise |
| C3 Reliability | -2 cold start 45 to 90 s exceeds production's 60 s window | -1 | +1 fewer connections and beats; Postgres wall removed early | 0 | +1 frees slots and beats |
| C4 Unit cost (range, grade I) | +1 up to about EUR 2.5k to 3.9k a month at the envelope; billing stance moot (hibernated agents billed) | +1 smaller | +1 up to about EUR 2k a month if both reservations halve | 0 | +1 depends on the hard-limited share (kind C, measurable) |
| C5 Time to value | -2 new state, wake API, UI, Traderton | -2 | +1 config and a week of evidence | -1 | 0 stop path exists; restart on top-up needs checking |
| C6 Simplicity | -2 | -2 | +1 | -1 unused code | 0 |
| C7 Reversibility | -1 | -1 | +1 | +1 | -1 customer-visible |
| C8 Strategic fit | -1 SO-2 and SE-1 harmed | 0 | +1 SO-1, SO-3 | 0 | +1 SO-1, SO-3 |

Deal-breakers: O1 and O2 fail SE-1. O1 and O2 for trading agents (T-09). Hosting several agents per container (brief D2) contradicts ADR-2026-06-003 and was not evaluated.

## 6. Reasons

1. The owner requires that agents answer without a wake delay of tens of seconds (SE-1). Staging p90 is 20 s with a tail of minutes, and production gives a start only 60 s. Hibernation cannot reliably meet SE-1 for a user message, watch or reminder. This reason is weaker than first stated, because the median start is about 6 s; reasons 3 and 4 carry real weight too.
2. Under today's billing, stopping a container also stops the meter. The owner would bill hibernated agents for now, so revenue is not the objection. Latency is.
3. Hibernation would need five existing safety paths changed, and trading agents cannot use the existing stop path because it stops their bots (T-09).
4. The real constraint at 10,000 residents is the control plane, not nodes: heartbeats, Redis clients and especially Postgres connections (K5). O3 addresses that cheaply.
5. Stopping agents that cannot act anyway (hard-limited accounts) frees slots without any latency cost, because their restart is user-initiated on top-up. The owner has decided this (C-13).

## 7. Stress tests

| Assumption | If wrong by 2x or false | Ranking changes? |
|---|---|---|
| SE-1 holds for every wake (A-22: median 6.4 s, p90 20.0 s) | If the owner relaxes or quantifies SE-1 (for example a p95 limit of N seconds), O2 reopens for long-cadence non-trading agents | Yes, but only after a new record |
| Postgres pool is up to 10 per agent (K5, I) | If real use is 1 to 2, the wall moves to hundreds of agents; if 10, it is at tens | No, O3 still first; it changes urgency of OD-14 |
| Share of hard-limited agents (kind C) | If tiny, O5 saves little but costs little | No |

**Pre-mortem:** (1) control plane fails at a few hundred residents, caught by experiment 1 and the stub test; (2) hard-limit stop cuts a trading agent with open exposure, caught by OD-13 before OD-12 ships; (3) production starts above 60 s are purged, caught by experiment 3.

## 8. Consequences

- **Becomes true:** agents stay resident; OD-04, OD-07, OD-14 size for the resident count; C-13 is carried by every plan that touches lifecycle, capacity or billing.
- **Blocked:** hibernation; any wake-on-demand path.
- **Unblocked:** OD-04 and OD-07 on a fixed assumption.
- **Cost and effort (grade G):** experiments 3 to 6 person-days; right-sizing saving up to about EUR 2k a month at the envelope and about EUR 200 at 10% (I).

## 9. What would change this

- The owner relaxes SE-1 for a class of agents.
- Resident cost stays unaffordable after right-sizing.
- A reliable sub-10 s start becomes possible (for example pre-warmed pools), and the owner reopens SE-1.

## 10. Cheapest experiment (read-only on shared systems)

1. **Postgres connections per agent** (`pg_stat_activity` by application) versus `max_connections`. First.
2. **Redis clients per agent** (`CLIENT LIST`), multiplied by 10,000.
3. **Start time p50 and p95:** `session_started` `occurredAt` minus `agent_runtime_sessions.startedAt`, per session, on staging; check against the 60 s production window.
4. **Share of resident agent-hours whose account is `hard_limited` or `suspended`** (billing accounts), for O5.
5. **Node facts:** `nomad node status` on one staging node (3,819 MB and 4,000 MHz are template defaults).
6. **Stub-runtime load test at 1,000, 2,000 and 5,000 residents on a local or isolated stack only** (it writes rows; INV-O2). Pass/fail (provisional, G): heartbeat-to-handled lag p95 above 15 s (half the 30 s stale timeout), or Postgres CPU above 70%. The stub does not open per-agent Redis or Postgres clients and sends no CPU telemetry, so extrapolate connections from experiments 1 and 2.

## 11. Review trigger

| Trigger | Threshold | Derivation | Effect |
|---|---|---|---|
| Resident agents | Above 1,500 | 75% of P-01's 2,000 envelope; provisional (G) | Review OD-04 and OD-14 |
| Postgres connections | Connections per agent times residents above 80% of `max_connections` | Experiment 1 | OD-14 first |
| Start time | p95 above 60 s on production, or any start purged at the window | A-22, config | OD-04 first |
| SE-1 | Owner changes or quantifies it | n/a | Reopen via a new record |
| Date | Phase boundary sweep, or 2026-12-31 | n/a | Sweep for fired triggers |

## 12. Owner questions

None. The facts the brief left open (A-22, billing stance, latency) were answered and recorded.

## 13. Register updates and gaps

**Applied on 2026-11-11:** `03` (C-12, C-13, D-2026-001, ADR-2026-11-019, P-08, T-09, "decisions every plan must carry"), `04` (A-02, A-11, A-22 to A-24, L-09 to L-13), `05` (OD-03 closed, OD-12 to OD-14, graph), ADR-2026-11-019, `01` (SE-1).

**Still to do:**

- [ ] OD-13: add a Traderton decision-log reference when that decision is taken.
- [ ] Fix the stale pending plan `docs/features/pending/000-agent-conversation-hydration/001-plan.md` (Phase 2 shipped in v0.8.9).
- [ ] The web thread filter (`AgentConversation.tsx:479,543`) still hides messages before the latest run start, which is now unnecessary since hydration shipped. An existing defect, separate from this decision.
- [ ] Owner may adopt candidate INV-N4: state that must survive container loss lives in Postgres, or in a Redis configured not to evict and to persist (L-11).
- [ ] A plan for OD-12 (C-13) is needed.

**Framework gaps found (applied in method v0.2 / contract v0.2):** unknowns must be checked or asked, three kinds of unknown, evidence access list, split-decision gate phrase, per-stage reversibility, code-state stamp, record length and ID rules, who applies register updates.

## 14. Challenger result

Verdict: **Stands with changes.** No HARD or FIRM invariant is broken. Changes and how they were handled:

| Item | Handling |
|---|---|
| B1: E11 misstated (reminders and messages gate on agent status, not container state) | Corrected (E11, K3, P4) |
| W1: Postgres connection wall | Added (K5, A-24, OD-14, experiment 1 first) |
| W2: stop agents over the hard billing limit | Adopted as O5 and decided by the owner (C-13) |
| W3, W4: cost ceiling for feasible nodes, $43k grade, break-even | Range shown (K7). The $43k figure is dropped as an argument: the owner bills hibernated agents, and hibernation is rejected on latency |
| W5: second gate line and owner direction before Stage 1 | Moot. No Stage 1 (hibernation not built). Two-line gate phrase added to the method |
| W6, W11: stub test coverage, pass/fail, derivations | Done in sections 10 and 11 |
| W7: node figures are template defaults | Experiment 5 |
| W8, W9: bundled ratings, O4 definition | O3 and the old O5 merged; O4 as in the brief |
| W10: `listActiveAgents` full-table read | Added to appendix E10 |
| W12: register updates | Applied (section 13) |
| INV-S1: single-flight wake | Moot for hibernation. Relevant to restart on top-up (OD-12) |
| INV-O2: stub test not read-only | Fixed (experiment 6) |

## 15. Owner ratification

2026-11-11: the owner decided not to implement hibernation, mainly because of latency (C-12), and decided to stop agents that exceed their hard billing limit (C-13). Billing stance noted: hibernated agents would have been billed.

---

## Appendix: evidence

| # | Fact | Source | Grade |
|---|---|---|---|
| E1 | The runtime meter is built and flushed inside the agent process (created at start, flushed on the heartbeat timer, closed on shutdown) | `apps/worker/src/agent.ts:951-966,2611,4615`; `usage-billing-service.ts:61,380-396` | V |
| E2 | Rate 100 micro-USD per 60,000 ms = $0.0001 a minute, about $4.32 per resident agent per 30 days | `config/default.yaml:959-962` | V / derived |
| E3 | Usage is deducted from prepaid credit. The only default plan is `free`: included credit 0, hard cap -100 cents, up to 10 agents. Ten residents burn $0.06 an hour, so a free account reaches its cap in about 17 hours without a top-up | `config/default.yaml:851-889,959-962` | V / derived |
| E4 | cx23 offers 3,819 MB and 4,000 MHz (Terraform defaults, not observed). A free or starter agent reserves 256 MB and 256 shares: memory gives 14 slots, CPU 15. Pro reserves 1,024 MB (3 per node) | `variables.tf:346-360`; `config/default.yaml:626-645`; `scripts/capacity-demand.sh:206-218` | V / I |
| E6 | Node cost ceiling at the envelope: 715 cx23 (infeasible per OD-07) is about EUR 3.9k a month; about 85 cx53 is about EUR 2.5k; with both reservations halved about EUR 1.9k to 2k. At 10% of the envelope about EUR 390. Prices from a third-party review (A-09). The $43k a month meter figure assumes every resident pays at the seed rate and is an upper bound | E4, A-09 | I |
| E7 | `cost.md` says 5 agents per node and a $1 contribution target; the scheduler arithmetic gives 14 | `docs/product/cost.md`; E4 | V / O |
| E8 | Heartbeat every 5 s per agent: a session read, at least one UPDATE, and a telemetry UPDATE when sent. At 10,000 residents about 2,000 beats a second and roughly 4,000 to 6,000 statements a second. Stale timeout 30 s | `agent.ts:134,4615-4618`; `agent-session-manager.ts:775-830`; `agent-health-monitor.ts:53`; `config/default.yaml:328` | V / I |
| E9 | Each agent opens 2 Redis connections (20,000 at 10,000 residents against default `maxclients` 10,000) and a Postgres pool (library default up to 10 connections; agents connect directly; `DATABASE_URL` is injected). The compose Postgres (`postgres:17-alpine`) has no `max_connections` override (default 100) and no pooler was found | `agent.ts:868-876,891`; `packages/db/src/index.ts:11-14`; `docker-agent-manager.ts:271-278`; `docker-compose.yaml:23-37` | V (config) / I (effect) |
| E10 | The reminder coordinator reads every active agent's reminder hash every 10 s from one lease holder (about 1,000 reads a second) and calls `listActiveAgents()` (`select *` from `agents`) every 10 s | `reminder-coordinator.ts:110-116`; `config/default.yaml:689` | V / derived |
| E11 (corrected) | Watches are evaluated for agents in the Redis set `agent:sessions:active`. Reminders fire for agents whose DB status is `active`. The message API returns 409 only for status `stopped` or `crashed`. Peer messages are refused when the receiving agent is not running. The gates read agent status or session state, not container state; none starts a container | `monitor.ts:260-265,936-941`; `reminder-coordinator.ts:14-24,110-116`; `agent-repository.ts:899-902`; `agent-interactivity.ts:511-515`; `en.ts:747` | V |
| E12 | Tick timing lives in the container; next-due time is in memory only | `agent.ts:2425-2441,2499-2565,3097-3101` | V |
| E13 | Tick range: presets 90, 30, 10 min; custom floor 5 min; non-trading default 24 h; skill suggestions 5 to 15 min; wake cooldown 15 s. The code allows very short and very long cadences, so cadence cannot be settled from code | `packages/domain/src/cost-profile.ts:32-36,44`; `config/default.yaml:327,510,690-697`; `skills.ts` | V |
| E14 | Survives a restart: conversation (Postgres, rehydrated), answered marker, memory hash, reminders (Redis). Lost: activity timeline, workspace files (no volume), breaker and backoff state, tick-gate state | `agent.ts:1467-1490,2917-2921,2950-2992`; `nomad-runtime-adapter.ts:255-300` | V |
| E15 | Redis runs `maxmemory 512mb` and `allkeys-lru`, no data volume; it may evict any key, including `agent:memory:*` and reminders | `docker-compose.yaml:23-37` | V / I |
| E16 | Streams are trimmed to about 1,000 entries; consumer groups persist; the wake group reads only new entries | `agent-protocol.ts:50`; `agent.ts:1751-1755` | V |
| E17 | Any session stop calls Traderton `stop_agent_actor`, which stops the trading actor and then the agent's running bots | `apps/worker/src/index.ts:894-896`; `agents/agent-actor-lifecycle.ts:55-77`; Traderton `agent-actor-lifecycle-ops.ts:131-178` | V |
| E18 | The Traderton agent actor is long-lived (reconciler, live-order timers, per-trade stop levels). The platform must not create exits the user did not arm | Traderton `agent-trading-actor.ts:231-268`; P-08 | V |
| E19 | Shutdown waits at most 8 s for an in-flight tick, then exits | `agent.ts:2574-2600` | V |
| E20 | Start bounds: production 60 s for the whole start (`startTimeoutMs`, capacity-aware start off); staging 600 s capacity wait plus 120 s after placement (capacity-aware start on, `config/staging.yaml:137-139`). A fixed 1 s sleep before the first heartbeat. Staging measured start: median 6.4 s, p90 20.0 s, worst 333.5 s (A-22) | `config/default.yaml:351-355`; `agent.ts:4606`; read-only SELECT on staging, 2026-11-11 | V |
| E21 | The web thread hides messages older than the latest run start | `AgentConversation.tsx:479,543` | V |
| E22 | Container checkpoint and restore is experimental in Docker; Nomad live migration is an open request | docker/cli docs; hashicorp/nomad#13785 | P / T |
| E23 | A stub runtime publishes synthetic heartbeats (no per-agent clients, no telemetry) | `agents/agent-runtime-launcher.ts:128-143,455` | V |
| E24 | Arbitrary shell, browser and direct HTTP writes are not duplicate-safe unless proven per path | continuity plan 002 lines 111-113 | V |
| E25 | **Hard billing limit today:** the billing gate skips the tick (`agent.ts:3878-3900`, `scout-gating.ts:11-12`); the user is notified once per status change by chat and email, with open positions in the message (`agent-message-broker.ts:372-390,1405-1470`); a new session start is blocked (`agent-session-manager.ts:~412`). The container is not stopped. Billing status is per account: `active`, `soft_limited`, `hard_limited`, `suspended` (`usage-billing-repository.ts:175`) | as cited | V (gate) / I (absence of a stop path) |
