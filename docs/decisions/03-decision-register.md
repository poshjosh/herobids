# 03 Decision Register

**Status:** Draft v0.1. Index only: it summarises and links, it does not replace the source.
**Last reviewed:** 2026-11-11
**How to use:** scan the "What it constrains" column. Open the source only for rows that touch your problem. Never rely on a row's summary for a detail that matters: read the source.

**Status values:** `Accepted`, `Proposed` (written, not ratified), `Superseded`, `Review-triggered` (a trigger named in the row has fired), `Draft` (plan or proposal).
**ID scheme:** `ADR-<yyyy>-<mm>-<nnn>` for ADRs (ADR numbers repeat across months and once within a month, so the path is the identity). `P-nn` platform and feature-level decisions. `C-nn` decisions taken in the 2026-11-11 design conversation. `T-nn` Traderton decisions (read from headings of its decision log; open the log before relying). New decisions use `D-<yyyy>-<nnn>` and get a record in `records/`.

## A. Platform and feature-level decisions (infrastructure, runtime)

| ID | Date | Decision | Status | What it constrains | Review trigger | Source |
|---|---|---|---|---|---|---|
| P-01 | 2026-07-08 | Agents run as Nomad jobs on Hetzner; Terraform provisions nodes; autoscaling by script (flock plus Terraform), with a safety net and nightly scale-in. Non-goals: Kubernetes, HA multi-region, millions of agents. Design envelope: 200 to 2,000+ agents "before a future platform transition". Single Nomad server, no HA quorum yet. | **Review-triggered** | Envelope is now 10,000 resident agents (strategy section 4), so the control plane, Nomad quorum and node count need re-examination (OD-04) | Agents exceed about 2,000 | [orchestration plan](../features/2026/07/08/004-orchestration/002-implementation-plan.md), [trigger comparison](../features/2026/07/08/004-orchestration/001-autoscaling-trigger-comparison.md) |
| P-02 | 2026-07-08 | Separate staging and production environments, each with its own control plane, domain, secrets and deploy flow | Accepted | Environments never share state or credentials beyond what is documented. (Hetzner project and token sharing is noted in the drift note.) | | [staging setup](../features/2026/07/08/003-staging-environment-setup/001-plan.md) |
| P-03 | 2026-10-30 | Agent continuity and safe capacity. Retain Nomad scheduling and Terraform ownership. Autoscaler mutation guard is unconditional; scale-out applies a checked create-only plan; accept a brief pause but do not lose acknowledged work or duplicate external actions | Accepted (direction) | Any capacity automation must be fail-closed, plan-checked, drift-aware (INV-O6, INV-S1, INV-S2). Direct Hetzner provisioning and Nomad Autoscaler were deferred | Measured controller limits | [objectives](../features/2026/10/30/001-agent-continuity-and-safe-capacity/010-objectives.md), [roadmap](../features/2026/10/30/001-agent-continuity-and-safe-capacity/000-roadmap.md), [scale-out options](../features/2026/10/30/001-agent-continuity-and-safe-capacity/011-scale-out-options.md), [drift note](../features/2026/10/30/001-agent-continuity-and-safe-capacity/012-agent-node-drift-note.md) |
| P-04 | 2026-11-08 | Browser pool registers on the private network (host network `private`), static port 3100, with agent-node firewall rules. Update block added. | Accepted | Pool is private-only (INV-X2). One instance per node while the port is static | | [bug 2026/11/08 001](../bug-reports/2026/11/08/001-browser-pool-registered-on-public-address-blocked-by-ufw.md), [browser-pool.md](../tech/architecture/browser-pool.md) |
| P-05 | 2026-11-09 | Sandbox egress by UID rules replaces the network-namespace sandbox. Only `NET_ADMIN` needed. Nine recorded design decisions. | Draft (code written, not deployed) | Agent image, caps nodes and the pool address interact. Browser pool address must be allowlisted by IP | | [plan](../features/pending/000-sandbox-uid-egress/001-plan.md), [bug 2026/11/09 001](../bug-reports/2026/11/09/001-sandbox-mount-blocked-by-apparmor-on-nomad.md) |
| P-06 | 2026-11-09 | Agent runtime rollout principles: node config before job; ship dark; prove on one target; read state from source; fast rollback; reversible steps first | Accepted | Becomes INV-O3 to INV-O8 | | [guide](../tech/agents/agent-runtime-rollout-guide.md) |
| P-08 | 2026-11 | Product policy: full agent runtime is a paid capability. Unpaid users keep no full reasoning. Exposure may survive suspension only through pre-armed, user-authored protective exits (for example venue-native reduce-only orders). The platform creates no exits the user did not arm | Policy document (status not recorded) | Constrains C-13 for trading agents with open positions | | [policy](../product/agent-runtime-billing-and-protective-exits.md) |
| P-07 | 2026-11-11 | Dedicated, auto-scaled browser tier: system job, one instance per node, front-door load balancer, measure first | Draft | See C-01 to C-06 | Spike result, measured memory per session | [Plan 005](../features/pending/005-browser-pool-dedicated-tier/001-plan.md) |

## B. Decisions taken in the design conversation (2026-11-11)

Owner statements are recorded as given. "Conditional" means the owner accepted subject to a stated condition.

| ID | Decision | Status | Basis and condition |
|---|---|---|---|
| C-01 | Keep static port 3100. No dynamic ports. | Accepted | Owner: agreed. One instance per machine makes it sufficient |
| C-02 | Browser instances run on their own auto-scaled node pool, one instance per node, many sessions per instance; job type `system` | Accepted, **conditional** | Owner: "yes if it simplifies things". Plan 005 Phase 0 and 4 verify the simplification |
| C-03 | Front door (load balancer) in front of the browser tier (Option B); fall back to instance lookup (Option A) if the spike fails | Accepted, **conditional** | Owner chose B "if it fits". Spike S1 to S8 decides go or no-go |
| C-04 | Move `browser-pool` to a caps node on staging now (stopgap), staging downtime accepted | Accepted | Owner: yes. Execution needs the capacity check in Plan 005 Phase 2 |
| C-05 | Starting the Oso agent was acceptable. No owner scoping on the restart script for now | Accepted | Owner statement |
| C-06 | Start on 4 GB machines and grow 4, 8, 16, 32 GB over time by replacing nodes, not resizing | Accepted | Owner: cost belief. Larger sizes gated on measured stability |
| C-07 | Shared autoscaling kit lives in a separate, versioned repository | Accepted | Owner: "Yes" (2026-11-11). Scope, language and sequencing are open (OD-01) |
| C-08 | Kit core language: TypeScript, shell actuators stay at first | **Proposed** | Owner asked for a view; not ratified |
| C-09 | Traderton scales out as worker "cells" (one VM, one public IP, bounded agents) on a central database, with leases and fencing | **Proposed** | Not ratified. Depends on measuring actors, subscriptions and venue limits (OD-02) |
| C-10 | Browser target is 200 concurrent sessions (replaces the 1,000 to 3,000 guess) | Accepted | Owner estimate (A-03) |
| C-11 | Adopt this decision framework | **Proposed** | Pending owner sign-off (OD-11) |
| C-12 | **Agents stay resident. We will not implement hibernation.** | Accepted | Owner, 2026-11-11. **Main reason: latency.** Waiting tens of seconds for an agent to wake is unacceptable (SE-1), and measured staging starts are a median of 6.4 s, p90 20.0 s and worst 333.5 s (A-22; the owner's earlier 45 to 90 s guess was withdrawn). **Review note:** with a median start of about 6 s the latency case is weaker than first stated. It rests on the long tail and on SE-1, whose wording ("tens of seconds") is not yet quantified. The decision stands until the owner reopens it, for example by giving SE-1 numbers. Supporting reasons from [D-2026-001](./records/D-2026-001-residency-vs-hibernation.md): hibernation would break existing wake paths and the stop path also stops Traderton bots (E17); the node saving is small next to the control-plane work at 10,000 residents. The earlier billing stance (bill hibernated agents) is now moot. Closes OD-03. ADR: [ADR-2026-11-019](../tech/architecture/adrs/2026/11/019-agents-stay-resident-no-hibernation.md) |
| C-13 | **Stop agents whose account exceeds its hard billing limit.** The container is stopped, not just its ticks skipped | Accepted (direction); mechanics open (OD-12) | Owner, 2026-11-11: "we should". The owner gave no further reason. Facts from code: today a hard-limited agent only has its ticks skipped by the billing gate, the user is notified once per status change, and starting a new session is blocked, but the container stays up and holds its slot (`apps/worker/src/agent.ts:3878-3900`, `agents/agent-message-broker.ts:372-390,1405-1470`, `agents/agent-session-manager.ts:~412`). No code path stops the container at the hard limit (grade V for the gate, I for the absence). **Binding on every plan that touches agent lifecycle, capacity, billing or node sizing: include this.** Restart on top-up is user-initiated, so SE-1 does not apply to it. Open details in OD-12 and OD-13: trading agents with open positions, grace period, notification, what the meter does after stop |

## B2. Decision Records (`docs/decisions/records/`)

| ID | Date | Title | Status | What it constrains | Review trigger | Source |
|---|---|---|---|---|---|---|
| D-2026-001 | 2026-11-11 | Agent residency versus hibernation | Ratified by owner decision C-12 (challenger result attached) | Production agents stay resident; OD-04 and OD-07 size for the resident count; hibernation is not built; right-size and de-chatter first | Resident agents exceed 1,500; control-plane limits reached (OD-14) | [record](./records/D-2026-001-residency-vs-hibernation.md), [challenger](./records/D-2026-001-challenger-result.md) |

## B3. Decisions every plan must carry

A plan that touches the area on the left must include the decision on the right, or state why it does not apply.

| Area | Include |
|---|---|
| Agent lifecycle, capacity, node sizing, billing | **C-13** (stop agents over their hard billing limit) and **C-12** (no hibernation, agents stay resident) |
| Anything that adds wake or start latency for an agent | **SE-1** (tens of seconds is not acceptable) |

## C. ADRs (herobids, `docs/tech/architecture/adrs/`)

Paths are `adrs/<yyyy>/<mm>/<file>`. Status is as written in the ADR.

| ID | Title | Status | What it constrains (one line, read the ADR before relying) | Tags |
|---|---|---|---|---|
| ADR-2026-06-001 | Actor-neutral agent protocol | Accepted | Boundary uses `actorType`/`actorId` and `originType`/`originId`; storage may use local names | protocol |
| ADR-2026-06-002 | Redis Streams agent transport | Accepted | Redis Streams, not bare pub/sub, for runtime and platform messages; at-least-once delivery | transport, reliability |
| ADR-2026-06-002 (i18n) | Web i18n contract and key strategy | Accepted | `react-intl`; stable dot-string keys; locale persisted in browser and profile | web |
| ADR-2026-06-003 | Single-container agent code execution | Accepted | One container per agent runtime; code runs inside it as a restricted subprocess; no second execution container in v1 | runtime, sandbox |
| ADR-2026-06-004 | Actor-executor separation | Proposed | Separates deciding actor from executor in the domain model | trading |
| ADR-2026-06-005 | Unified agent capabilities | Accepted (revised 2026-07-11) | Capabilities are two optional config sections, not distinct agent types | agents |
| ADR-2026-06-006 | Agent intelligence mandatory | Superseded | Replaced by the 2026-07-11 revision | agents |
| ADR-2026-06-007 | Hybrid agent single-shot prompt | Accepted (narrowed) | `scanner_gated` hybrid mode uses a single-shot structured-output prompt, no tools | agents, LLM |
| ADR-2026-06-008 | Bots single-instrument, agents multi-instrument | Proposed | Hard split between bots and agents | trading |
| ADR-2026-06-009 | Soft cap warns, never mutates | Accepted | Soft cap notifies only; hard cap may stop the reasoning loop | billing, agents |
| ADR-2026-06-010 | LLM pricing from DB, not hardcoded | Proposed | See 2026-07-001 | LLM, cost |
| ADR-2026-07-001 | Eliminate static LLM pricing | Proposed | Pricing lives in `llm_pricing_snapshots` | LLM, cost |
| ADR-2026-07-002 | Capability model and registry | Superseded | | capability |
| ADR-2026-07-003 | Agent core vs capability services | Superseded | | capability |
| ADR-2026-07-004 | Capability registry and tool exposure | Superseded | | capability |
| ADR-2026-08-001 | Blueprint is the marketplace asset | Accepted | Blueprints, not live agents, are browsed, published, forked, ranked | marketplace |
| ADR-2026-08-002 | Template vs instance boundary | Accepted | Blueprint holds template-eligible data only; private bindings supplied at instance creation | marketplace |
| ADR-2026-08-003 | Agent blueprint contract | Accepted | Blueprint payloads typed and validated in shared domain code | marketplace |
| ADR-2026-08-004 | Blueprint ranking and attribution | Accepted | Reuse the skills-marketplace pattern for v1 | marketplace |
| ADR-2026-08-005 | Onboarding chat agent runtime | Proposed | Per-message LLM call, not a resident runtime; billed per token | agents, billing |
| ADR-2026-08-006 | Spend caps operator-only | Accepted | Spend-cap inputs hidden from non-admin users | billing |
| ADR-2026-08-007 | Defence in depth for LLM surfaces | Accepted | Multiple independent layers, starting with Zod validation (INV-S6) | security |
| ADR-2026-08-008 | Native capabilities and external backends | Proposed | Two categories; external backends are separately deployable | capability, boundary |
| ADR-2026-08-009 | Automation as external backend | Proposed | Second external backend, repo-local first | capability |
| ADR-2026-09-010 | Traderton-owned trading profile | Accepted | Trading state is configured via the boundary and enforced in Traderton (INV-L2) | trading, boundary |
| ADR-2026-09-011 | Split trading authority | Accepted | Traderton is the sole authority for risk defaults and risk math (INV-L2) | trading |
| ADR-2026-09-012 | Capability-scoped LLM surface | Accepted | Trading-related tools only via trading-appropriate skills | trading, legal |
| ADR-2026-09-013 | Consolidate trading-profile write paths | Accepted | Shared pure helpers for profile validation and planning | trading |
| ADR-2026-09-014 | Capability-agnostic frontend | Accepted | Generic surfaces show lifecycle and readiness only | web |
| ADR-2026-09-015 | External backend skill registration | Accepted (parts superseded by 016, 017) | `ExternalBackendClient` is the generic runtime client | boundary |
| ADR-2026-10-016 | MCP as external backend transport | Accepted (decision 4 superseded by 017) | MCP is the target invocation transport; auth and idempotency requirements retained | boundary, MCP |
| ADR-2026-10-017 | Uniform skills.sh skills and MCP tool discovery | Accepted | Skills installed at agent start; tools discovered via MCP `tools/list`; calls stay REST | skills |
| ADR-2026-10-018 | Eliminate the parity-drift check | Accepted | No mirrored files; Traderton publishes `@poshjosh/contracts`, exact-version pin | trading, contracts |
| ADR-2026-11-019 | Agents stay resident; no hibernation | Accepted | Agents are not stopped to save cost; wake latency is a requirement (SE-1). Reasoning is in D-2026-001 | runtime, cost |

## D. Traderton decisions (read its log before relying)

Source: Traderton `docs/features/initial/004-decision-log.md`. Summarised from its section titles only.

| ID | Decision (from title) | Relevance here |
|---|---|---|
| T-01 | Traderton is multi-tenant but not the identity or billing authority | Who owns users and plans |
| T-02 | Trading is an isolable, REST-first-but-in-process-capable deployable (legal, not architectural) | INV-L1; keeps the in-process path alive |
| T-03 | The soft-reference rule | Cross-repo references |
| T-04 | Trading credentials are not mirrored into herobids (custody follows use) | Security, INV-L3 |
| T-05 | Bots are mechanical; Traderton does not own human approvals | Scope of Traderton |
| T-06 | Phase 10 infrastructure becomes a shared, versioned Terraform module library (`app-host/hcloud`, `nomad-autoscaler/hcloud`). Not confirmed started | Directly relevant to OD-01 and C-07 |
| T-07 | No pre-existing production data: greenfield cutover | Migration freedom before launch |
| T-08 | Decision process 008: decide by default; escalate only when a rule is violated, a decision contradicted or an objective undermined | Basis of this framework |
| T-09 | Behaviour read from source, not from the log: stopping an agent session calls `stop_agent_actor`, which marks the run stopped, tears down the trading actor and **stops the agent's running bots** (Traderton `packages/boundary/src/agent-actor-lifecycle-ops.ts:131-178`; herobids `apps/worker/src/agents/agent-actor-lifecycle.ts:55-77`) | Directly constrains C-13 for trading agents (OD-13) |

## E. Known conflicts and supersessions to resolve

| Item | Note |
|---|---|
| Plans 002, 003 and 004 (browser pool) | Partly superseded by Plan 005. Their status blocks say so |
| ADR numbering | Duplicate `002` in 2026/06 and numbering restarts monthly. Use the path as identity |
| Stale docs | `browser-pool.md` and bug 2026/11/08 001 still say the update block is "pending" or "not committed". It is live (Plan 005 Phase 0 fixes this) |
| P-01 envelope | Review-triggered. See OD-04 |
