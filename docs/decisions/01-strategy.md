# 01 Strategy

**Status:** Draft v0.1. Items marked **[PROPOSED]** need owner confirmation. Items marked **[OWNER]** were stated by the owner (2026-11-11).
**Last reviewed:** 2026-11-11
**Purpose:** the "why" every decision is tested against. If a recommendation does not serve something here, say so.

## 1. What we are

OpenAIdom offers AI agents as a service. Users describe what they want and an agent does it, continuously, within limits the user sets. Source: [vision.md](../vision.md).

- **Vision:** a world where everyone can benefit from AI agents.
- **Mission:** make long-running AI agents affordable and simple enough to live and work alongside you.
- **Tag line:** affordable AI agents that get the job done.

Trading is one capability. It is built and run by **Traderton**, a separate system, because trading must stay separately deployable and isolable (legal posture). Source: Traderton `docs/features/initial/000-vision.md`, [ADR 010](../tech/architecture/adrs/2026/09/010-traderton-owned-trading-profile.md), [ADR 011](../tech/architecture/adrs/2026/09/011-split-trading-authority-by-responsibility.md).

## 2. Strategic objectives (the long-term "why")

| ID | Objective | Why it matters | How we will know (targets are set by the owner) |
|---|---|---|---|
| SO-1 | **Affordable.** Unit cost per agent stays low enough to price "affordable". | It is the tag line and the moat | Cost per resident agent per month; cost per active agent-hour; cost per browser session. Targets: **TBD [OWNER]** |
| SO-2 | **Reliable long-running agents.** Agents keep working, keep context, and never repeat external actions by accident. | "Long-running" is the product | Agents lost or duplicated per month (target zero); mean time to recover; continuity incidents |
| SO-3 | **Scale without linear operator effort.** Capacity for users, agents and sessions grows by automation, not by hand. | 100k users is not reachable by manual operations | Manual capacity interventions per month; time from demand signal to capacity ready |
| SO-4 | **Safe by construction.** Trading stays isolated. Secrets stay secret. Nothing unauthenticated is exposed. Agents cannot harm users or the platform. | One incident can end the business, and payment rails restrict trading | Open HARD-invariant violations (target zero); security findings |
| SO-5 | **Learn fast before launch.** We ship dark, measure, and decide on evidence, not belief. | We are pre-launch with no demand data | Share of T2 decisions whose key assumptions are verified (grade V or P) before commitment |

**[PROPOSED]** SO-1 to SO-5 are derived from the vision and from how decisions have been made so far. The owner should confirm, reword or add.

## 3. Current phase objective

**Phase:** pre-launch. External test users on staging only. Production is pre-launch and can be rebuilt.

**Phase objective (PO-1) [PROPOSED]:** reach an architecture and an operating model that can serve the scale envelope in section 4 without redesign, and prove it on staging, before launch.

Immediate work under PO-1 (see [05-open-decisions.md](./05-open-decisions.md)):

1. Capacity automation for three tiers: agent nodes, browser pool, Traderton.
2. A control plane that survives the envelope.
3. A cost model per unit, so SO-1 can be measured.
4. Measured, not assumed, numbers (memory per session, demand shape).

**Launch date:** unknown **[OWNER]**. Without it, time-to-value is weighed by effort and risk of delay, not by a date.

## 4. Scale envelope (the sizing target)

Stated by the owner on 2026-11-11. Grade O (owner estimate). No demand data exists yet.

| Quantity | Target | Notes |
|---|---|---|
| Registered users | 100,000 | |
| Agent containers up at once | about 10,000 | Resident, mostly idle |
| Agents actively working at once | about 200 | 30 minute average session. About 2% of resident |
| Concurrent browser sessions | up to 200 | Supersedes the earlier 1,000 to 3,000 guess |
| Agents that trade | about 5,000 (half) | Through Traderton |
| Memory reserved per agent | up to 256 MB | Actual 64 to 128 MB. Pro tier reserves 1024 MB |

Review this envelope when real data arrives, and whenever a decision's design envelope is exceeded (see Review-triggered rows in the register).

## 5. Value hierarchy (the trade-off order)

**[PROPOSED]** When two good things conflict, this order decides. Levels 1 to 3 are gates: a higher level is never traded for a lower one. Levels 4 to 7 are weighed.

| Level | Value | Meaning |
|---|---|---|
| 1 | **Legal and isolation** | Trading stays separable. No trading logic in the platform process. No coupling that endangers payment rails |
| 2 | **Safety of users, funds and data** | No duplicated or lost external actions. No exposure of secrets or unauthenticated services |
| 3 | **Integrity of running agents** | Continuity. No silent loss of acknowledged work. Safe states instead of blind replay |
| 4 | **Reliability and availability** | The service keeps working, recovers, and degrades gracefully |
| 5 | **Unit cost** | Cost per resident agent, active agent-hour, browser session |
| 6 | **Time to value** | Speed of delivery, effort, risk of delay |
| 7 | **Elegance, reuse, optionality** | Clean design, shared code, future flexibility. Valuable, never at the cost of 1 to 6 |

How to use it: an option that wins on level 6 or 7 but loses on level 1 to 3 is rejected. Between options equal on 1 to 4, prefer lower cost, then faster, then cleaner.

## 6. Unit-economics measures

Define once so that every cost argument uses the same units. Targets are **TBD [OWNER]**.

| Measure | Definition |
|---|---|
| Cost per resident agent per month | (agent-node cost + share of control plane) / resident agents |
| Cost per active agent-hour | Same cost allocated over active hours only. Exposes the cost of idle residency |
| Cost per browser session | (browser-node cost + load balancer) / sessions served |
| Capacity headroom | Free slots or sessions / demand. Too low risks outages, too high wastes money |

## 7. Explicit non-goals

- Optimising for millions of concurrent agents (design envelope is section 4). **Phase-scoped**: carried from the orchestration plan, which targeted 200 to 2,000+ agents. The envelope has since grown, so re-check this one.
- Multi-region active/active. Not needed before launch.
- Replacing Nomad or Terraform ownership. Settled by the agent-continuity decision ([register](./03-decision-register.md), row P-03). Reopen only through a recorded decision.
- Features for production before staging gates pass.
- Hibernating idle agents to save cost. Decided against on 2026-11-11, mainly because wake latency is unacceptable (C-12, SE-1).

## 8. Service expectations (owner requirements)

Requirements the owner has stated about how the service must behave. They are gates when a decision is evaluated (06 section 7, G1), not criteria. Each entry records who stated it and when. Scope can be tightened by the owner.

| ID | Expectation | Stated | Notes |
|---|---|---|---|
| SE-1 | **Latency.** Waiting tens of seconds for an agent to respond or wake is not acceptable. | Owner, 2026-11-11 | Scope: any interaction a user or a time-sensitive trigger could cause (messages, watches, reminders). Owner to refine. A staging measurement on 2026-11-11 shows start times of a median 6.4 s, p90 20.0 s and worst 333.5 s (A-22). The long tail means wake latency is not reliably small. **The wording "tens of seconds" is not yet quantified**: the owner may give a number (for example a 95th-percentile limit for user-visible wakes) so decisions can be tested against it. Until then agents must already be running when something needs them. Exception: agents that are stopped by the owner or by billing limits (C-13) |

## 9. How strategy changes

Only the owner changes this file. An agent that believes an objective is wrong, stale or missing writes that in its Decision Record under "Strategy conflicts" and does not edit this file.
