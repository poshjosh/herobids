# 04 Assumptions and Limitations

**Status:** Draft v0.1
**Last reviewed:** 2026-11-11
**Purpose:** make beliefs explicit, graded and checkable. Most bad decisions rest on an assumption nobody wrote down.

## Evidence grades

| Grade | Meaning | May a decision rest on it? |
|---|---|---|
| **V** | Verified: observed in the repo or the running system, with a path or command | Yes |
| **P** | Primary source: official documentation or specification | Yes, note the date |
| **O** | Owner statement or estimate | Yes for intent and targets. Not as proof of a technical fact |
| **T** | Third-party source (blog, review, community) | Only for reversible decisions. Verify before committing money or architecture |
| **I** | Inferred from evidence, not directly observed | Only for reversible decisions, with a named check |
| **G** | Guess | Never alone. Convert to an experiment |

Rule: an R2 or R3 decision (see [06-decision-method.md](./06-decision-method.md)) cannot rest on grade T, I or G alone. Name the cheapest check that upgrades it.

## Assumptions

`Used by` lists the open decisions or records that rely on the assumption. `If wrong` is the consequence.

| ID | Assumption | Grade | Source | How to verify | If wrong | Used by |
|---|---|---|---|---|---|---|
| A-01 | About 10,000 agent containers are up at once at the 100k-user envelope | O | Owner, 2026-11-11 | Observe after launch; model from signups | Node count and cost scale linearly | OD-01, OD-03, OD-04 |
| A-02 | About 200 agents are actively working at one instant (30 minute average session; about 2% of resident). This is a point-in-time share, not a duty cycle: agents that tick every 15 minutes are inside a tick for part of every hour | O | Owner; E13 in D-2026-001 | Measure the share of agent-hours spent inside a tick after launch (Plan 005 recording approach) | Node sizing and the cost per active agent-hour change | OD-07, OD-09 |
| A-03 | At most 200 concurrent browser sessions | O | Owner (replaces 1,000 to 3,000) | Recording in Plan 005 Phase 1 | Browser tier cost scales with it | OD-01, Plan 005 |
| A-04 | One browser session uses about 1 GB | G | Comment in `infra/nomad/browser-pool.nomad.hcl` | Staging load test (Plan 005 Phase 1b) | 2x memory means 2x nodes and cost | Plan 005, OD-01 |
| A-05 | Agent memory actual is 64 to 128 MB; reserve up to 256 MB (free/starter), 1024 MB (pro) | O / V | Owner; `config/default.yaml` resource profiles | Nomad allocation stats | Reservation sets node count, not actual use | OD-07 |
| A-06 | About 5,000 agents trade (half of 10,000), each with its own venue account | O (count) / I (account) | Owner | Query connection model; ask Traderton team | Venue limits (A-07) bite harder or later | OD-02 |
| A-07 | Hyperliquid limits per IP: REST 1,200 weight a minute; 1,000 websocket subscriptions | T | Third-party summaries | Official Hyperliquid docs | Per-IP cell size changes | OD-02 |
| A-08 | A Hetzner private network holds about 100 servers. Our staging subnet is a `/24` | G / V | Believed; `private_subnet` in tfvars | Hetzner limits docs; `hcloud` | Large fleets need several networks | OD-01, OD-07 |
| A-09 | Server prices (`fsn1`, gross, Hetzner API `GET /v1/server_types`): cx23 EUR 6.53/mo (0.0105/hr), cx33 10.10, cx43 19.03, cx53 35.09/mo (0.0563/hr). **Verified 2026-11-13, this plan** (scale-path task 0.3); supersedes the earlier third-party June-2026 estimate | V | Hetzner API, 2026-11-13 (plan task 0.3 evidence table) | `hcloud server-type describe` / API | Cost tables shift | OD-01, OD-07 |
| A-10 | New node is ready in minutes (boot, join, image pull) | I | Staging experience | Measure create to registered to healthy | Free-session floor must rise | Plan 005 Phase 5 |
| A-11 | **Falsified as stated (2026-11-11).** "Agents must stay resident because of continuity". P-03 does not say that: it accepts brief pauses. Residency is now a decision for a different reason: wake latency (C-12, SE-1) | Falsified | D-2026-001 premise P6 | n/a | n/a | OD-03 (closed) |
| A-12 | We have no demand data: pre-launch, test users only | V | Owner | n/a | Autoscaling thresholds are provisional | OD-01 |
| A-13 | Traderton keeps trading actors in one in-process registry. No cross-instance ownership mechanism found | I | `packages/worker/src/composition/create-trading-runtime.ts`; grep of boundary files, files not read | Read boundary files `agent-actor-*.ts`, `agent-orphan-sweep.ts` | Cells design needs less or more work | OD-02 |
| A-14 | Hetzner offers no managed Postgres | G | Memory | Hetzner product list | Central DB must be self-run | OD-02, OD-04 |
| A-15 | A TCP load balancer works for Browserless if each session is one WebSocket | G | Spike not done | Plan 005 spike S1 to S8 | Fall back to Option A (OD-05) | OD-05 |
| A-16 | The control plane is one VM running API, worker, web, Postgres, Redis and a single Nomad server (`bootstrap_expect = 1`) | V | `infra/hetzner/main.tf`, orchestration plan | n/a | n/a | OD-04 |
| A-17 | Production is pre-launch and can be rebuilt | O / I | Handover and learnings notes | Owner confirm | Production changes need migration care | Plan 005 Phase 8 |
| A-18 | The agent autoscaler was designed for 200 to 2,000+ agents | V | Orchestration plan | n/a | Review trigger of P-01 | OD-04 |
| A-19 | Nomad Autoscaler with the hcloud plugin is a viable alternative | T / G | Plugin repo shows last visible activity Dec 2024 | Short spike on staging | Rule out or adopt for Nomad tiers | OD-01 |
| A-20 | Engineering capacity is small (a few people or agents) | I | Observed | Owner confirm | Effort estimates and choice of "build vs adopt" shift | All |
| A-21 | The agent-node autoscaler's logic is mostly generic: about 34 of 44 functions in `scale-common.sh` are not agent-specific by name | I | Skim of function names | Read bodies; run a parameterisation spike | Extraction costs more | OD-01 |
| A-22 | Time for an agent to reach running. The owner's earlier figure of 45 to 90 s was a best guess and was withdrawn on 2026-11-11 in favour of the measurement. **Staging measurement (2026-11-11, read-only SELECT):** median 6.4 s, p90 20.0 s, worst 333.5 s; 3 of 59 sessions over 60 s. Of 97 sessions, 9 failed to start (6 `boot_deadline`, 2 `start_timeout`, 1 `queue_deadline`). The slow tail lines up with waits for capacity (placement delays of 92 to 328 s), not with container boot | V | Method: `skill_usage_events` `session_started` minus `agent_runtime_sessions.started_at`, 59 sessions that have skills, staging only, capacity-aware start on, images mostly warm | Repeat on production when it has real traffic; separate cold-image and capacity-wait cases | Production allows 60 s for the whole start (`config/default.yaml:351-355`), so about 5% of the staging sample would have failed there | OD-04, OD-12, SE-1 |
| A-23 | A cx23 holds about 14 agent slots by memory; CPU reservation binds next at 15; the scheduler uses the smaller. **Verified 2026-11-13, this plan:** live cx23 agent nodes report 3,819 MB / 4,000 MHz allocatable (reserved 0) on both staging and production — the Terraform template defaults match the live node, confirming ~14 free-profile slots | V | Live `nomad node status` on staging + production cx23 nodes, 2026-11-13 (scale-path 1.5 / 7.2) | n/a (verified live) | Node counts shift | OD-07 |
| A-24 | At 10,000 residents the per-agent control-plane load is high: about 2,000 heartbeats a second (5 s beat), 2 Redis clients per agent, Postgres connections per agent. **Partially mitigated 2026-11-13, this plan (3.3/3.4 live):** the agent Postgres pool is capped at `max: 2` (was library-default ~10), and Redis `maxclients` raised to 10,000 with `nofile` 11,000. Postgres `max_connections` stays 100 (documented). Redis at 2 clients/agent still caps ~5,000 agents per Redis (L-10) | V (config, live) / I (effect at 10k) | scale-path 3.1/3.3/3.4 live on staging + production; D-2026-001 E8, E9, W1 | `pg_stat_activity` / Redis `CLIENT LIST` at higher agent counts | Redis client cap (L-10) becomes the wall around ~5,000 agents per Redis; Postgres pool cap keeps connections bounded | OD-14, OD-04 |

## Limitations (things we cannot change quickly)

| ID | Limitation | Source | Effect |
|---|---|---|---|
| L-01 | Cloud-init applies only on first boot. `user_data` is ignored after that, so template edits do not reach existing nodes | `infra/hetzner/main.tf`, rollout guide | Node config changes need new nodes or manual patches |
| L-02 | Hetzner account quotas (servers, load balancers, IPs) are unknown | A-08 | Hard cap on fleet size until raised |
| L-03 | Staging has 4 Nomad nodes. Scale behaviour at 100s of nodes cannot be tested there | Verified 2026-11-10 | Large-scale behaviour is inferred, not proven. Use synthetic tests |
| L-04 | Trading must stay legally separable (REST-only today) | INV-L1 | Rules out merging Traderton into the platform process |
| L-05 | The autoscaler is about 5,000 lines of shell with a strong test suite | `infra/hetzner/scripts` | Rewriting is costly and risky; extraction is cheaper |
| L-06 | Browserless has no authentication | INV-X2 | Network isolation is the only control |
| L-07 | Nomad versions differ on staging (2.1.1 on one node, 1.9.7 elsewhere) | Verified 2026-11-10 | Behaviour may differ between nodes |
| L-08 | Pre-launch: no revenue, no real demand curve | A-12 | Cost ceilings and targets are unset (OD-09) |
| L-09 | Start timeouts differ by environment. **Staging:** capacity wait up to 600 s plus 120 s after placement (`capacityAwareStart.enabled: true`). **Production:** the whole start must finish in 60 s (`config/default.yaml:351-355`, `config/staging.yaml:137-139`). Typical start time is 45 to 90 s (A-22) | [rollout guide](../tech/agents/agent-runtime-rollout-guide.md) section 3; the config files | Starting an agent is slow, which is why agents stay resident (C-12, SE-1). Verify production headroom against A-22 |
| L-10 | Redis default `maxclients` is 10,000; the compose files set no override | Redis docs; `docker-compose.yaml:23-37` | Limits the number of agents per Redis at 2 clients each (about 5,000 agents) |
| L-11 | Redis runs with `maxmemory 512mb` and `allkeys-lru` and no data volume, so it may evict any key, including agent memory and reminders | `docker-compose.yaml:23-37` | State that must survive loss of a container is not safe in Redis today. Candidate invariant INV-N4 (owner decides) |
| L-12 | The runtime billing meter runs inside the agent container; a stopped container stops metering | `apps/worker/src/agent.ts:951-966,2611,4615` | Any change to when containers run changes revenue (relevant to C-13) |
| L-13 | Stopping an agent session also stops its Traderton trading actor and running bots | T-09 | Stopping trading agents (C-13) needs a Traderton-side decision (OD-13) |
| L-14 | herobids and Traderton use the **same Hetzner project** today (owner, 2026-11-11). Their resources are told apart by labels: herobids servers carry `app=herobids`, Traderton's carry `app=traderton` | Owner; Traderton `infra/hetzner/main.tf:84,95,103`; herobids `capacity-inventory.sh:87` | Any shared autoscaling tool must select servers by those labels and never act on a server without the right `app` label. Project-level quotas and the account are shared. Whether the shared project is acceptable for legal separation (INV-L3) is the owner's call |

## Maintenance

- Add an assumption whenever a recommendation relies on a number or belief that is not in this table.
- When evidence changes, change the grade and the row, then list the decisions in `Used by` for review.
- Never delete a wrong assumption. Mark it `Falsified` with the date and what replaced it.
