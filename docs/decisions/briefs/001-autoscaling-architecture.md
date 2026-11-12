# Decision Brief 001: Autoscaling architecture for agent nodes, browser pool and Traderton

> **Homework partly done (2026-11-11).** The checkable gaps U1, U2, U3, U5 and U7 are closed in the program's [coupling analysis](../../features/2026/11/11/001-autoscaling-program/m1-shared-core/reference/autoscaler-coupling-analysis.md) (suite passes; about 34 of 44 `scale-common.sh` functions are generic; the Hetzner plugin provisions servers outside Terraform; no Node runtime on the control plane). The brief still needs: section 6 rewritten to the "Checked and open" form with these results, the new fact that staging scale-out is blocked by the ownership guard (F1.1), and the two owner facts (U4, U8), asked in the program inbox I-002. Original note follows. Not ready under framework v0.2 until then. Before this brief goes to a decision agent the requester must: (a) read the bodies of the `scale-common.sh`, `capacity-controller.sh` and `capacity-inventory.sh` functions and try the parameterisation on a branch (U1); (b) run `infra/hetzner/scripts/tests/run-all.sh` (U2); (c) check Traderton `CANONICAL-STATE.md` for the status of Phase 10 (U3); (d) read `cloud-init.yaml` and the control-plane resource budget (U7); (e) read the Hetzner plugin source (U5); and (f) ask the owner, in one batch with proposed answers, the owner facts: whether herobids and Traderton share a Hetzner project or token (U4), and engineering capacity (U8). Also record the decisions made since: C-12 (no hibernation) and C-13 (stop over-limit agents) reduce and shape the agent tier. Facts are verified against commit `c2526680`.

**Brief ID:** 001
**Requester:** framework author (neutral brief; no option is preferred here)
**Date:** 2026-11-11
**Tier (best guess):** T2 (TR3, TR4, TR5, TR10: shared abstraction, new repository, language choice, recurring infrastructure cost)
**Cost of delay:** Plan 005 Phases 0 to 4 do not depend on this and proceed. Phase 5 (browser autoscaler) waits. Without a decision, Phase 5 defaults to copying parts of the agent autoscaler by accident.
**Decision needed by:** before Plan 005 Phase 5 starts

## 1. Problem (plain language)

We need automatic capacity for three tiers before launch: agent nodes, the browser pool, and Traderton. The agent-node autoscaler exists as about 5,000 lines of shell, written for agent nodes only. Plan 005 adds a second, browser-pool autoscaler. Traderton has none and runs on one VM. The owner has accepted that the shared autoscaling capability lives in a separate, versioned repository (C-07). What is not decided is what it should contain, what language, in what order, and how much each tier uses.

## 2. The question

What should the shared autoscaling capability be (scope, language, sequencing relative to Plan 005 Phase 5, and level of adoption per tier), given C-07?

## 3. Context the requester knows applies

| Kind | IDs |
|---|---|
| Strategic objectives | SO-1, SO-3, SO-4, SO-5 |
| Invariants | INV-O6, INV-O1, INV-O2, INV-S1, INV-S3, INV-L3, INV-E8, INV-E1, INV-P3 |
| Register rows | P-01 (review-triggered), P-03, P-07, C-02, C-03, C-06, C-07, C-08, T-06, T-08 |
| Assumptions | A-01, A-03, A-04, A-06, A-12, A-13, A-16, A-19, A-20, A-21 |
| Open decisions | OD-01 (this), depends on OD-09, OD-03, OD-04, OD-07, OD-02. Blocks Plan 005 Phase 5 |

## 4. Grounded facts

| # | Fact | Source | Grade |
|---|---|---|---|
| F1 | The autoscaler scripts total about 5,160 lines across 12 files (`scale-common.sh` 877, `scale-out.sh` 764, `scale-in.sh` 608, `capacity-controller.sh` 423, `capacity-inventory.sh` 486, `capacity-demand.sh` 239, `check-nomad-capacity.sh` 267, `check-placement-failures.sh` 296, `alert-common.sh` 575, `render-autoscale-settings.sh` 195, `setup-autoscale-env.sh` 253, `scale-in-guard.sh` 177). There are about 30 test files in `infra/hetzner/scripts/tests/` with `run-all.sh` | `wc -l` and `ls` in `infra/hetzner/scripts`, 2026-11-11 | V |
| F2 | `scale-common.sh` defines 44 functions. By name, about 10 refer to agent specifics (`current_agent_node_count`, `write_node_count`, `sync_tfvars_node_count`, `max_agent_nodes`, `min_agent_nodes`, `list_eligible_agent_nodes`, capacity parsing, demand template validation). The rest are logging, locking, cooldown, Nomad API, Terraform runtime and drain helpers | `grep` of function definitions in `scale-common.sh` | V (names) / I (generic-ness; bodies not read) |
| F3 | Agent identity is hard-coded in several places: `NodeClass == "agent"` (`scale-common.sh:668`, `check-nomad-capacity.sh:137,162`); server names `<server>-agent-N` and Terraform addresses `hcloud_server.agent[i]` / `hcloud_server_network.agent[i]` in the plan allowlist (`capacity-controller.sh:199-220`); `agent_node_count` rewritten in tfvars (`scale-common.sh:336-360`); node pool from `NOMAD_AUTOSCALE_NODE_POOL` | the files and lines cited | V |
| F4 | The agent autoscaler needed many safety fixes: unplanned replacement, a scale-in that reversed itself, tfvars count drift, a stale firewall record, an ownership guard, the stop-path bug that left jobs running | [drift note](../../features/2026/10/30/001-agent-continuity-and-safe-capacity/012-agent-node-drift-note.md) | V |
| F5 | Plan 005 Phase 5 proposes new `browser-scale-out.sh` and `browser-scale-in.sh` that source `scale-common.sh` and `alert-common.sh`, and do not touch `capacity-*.sh`. It proposes a separate Terraform root module and state for the browser tier, `for_each` nodes, a signal from Browserless `/pressure`, and scale-in by load-balancer label drain | [Plan 005](../../features/pending/005-browser-pool-dedicated-tier/001-plan.md) Phase 5 and Design | V (it is a draft, not built) |
| F6 | Traderton runs on one VM with Docker Compose: postgres, redis, migrate, boundary, site, caddy. It has its own Terraform state and S3 backend. It does not use Nomad. Its plan-apply script says it mirrors herobids `provision.sh` | T: `infra/hetzner/compose.yaml`, `infra/hetzner/README.md` | V |
| F7 | Traderton keeps trading actors in one in-process registry. The boundary has rehydrate, orphan-sweep and shutdown code around it. No cross-instance ownership mechanism was found; several files matched a search for lock or instance terms but were not read | T: `packages/worker/src/composition/create-trading-runtime.ts:126-166`; `packages/boundary/src/agent-actor-*.ts`, `agent-orphan-sweep.ts` | V (registry) / I (no ownership) |
| F8 | Traderton's decision log says herobids' proven infrastructure becomes a standalone, versioned Terraform module library (`app-host/hcloud` and `nomad-autoscaler/hcloud`) consumed by pinned git ref, and warns against abstracting beyond a memory-driven single-pool autoscaler. Whether that work has started is not recorded | T: `docs/features/initial/004-decision-log.md` ("Why Phase 10 (infra) is a shared versioned module") | V (text) |
| F9 | The agent-continuity decision retained Nomad and Terraform ownership. Nomad Autoscaler plus a Hetzner plugin was marked "Defer; compare against measured controller limits" | [011-scale-out-options.md](../../features/2026/10/30/001-agent-continuity-and-safe-capacity/011-scale-out-options.md) | V |
| F10 | A community Nomad Autoscaler target plugin for Hetzner exists (AndrewChubatiuk/nomad-hcloud-autoscaler). Its last visible activity is about December 2024. Not assessed for compatibility with Terraform-owned servers | web search 2026-11-11 | T |
| F11 | Sizing at the envelope (derived): 10,000 agents at 256 MB reserved is about 2.5 TB, or about 700 cx23 nodes or about 85 cx53 nodes. 200 browser sessions at 1 GB is about 200 GB, or about 67 cx23 or about 7 cx53 | [01-strategy.md](../01-strategy.md), A-01, A-03, A-04, A-09 | I (inputs include G and T) |
| F12 | Staging has four Nomad nodes. Scale behaviour at hundreds of nodes cannot be reproduced there | L-03 | V |
| F13 | Accepted by the owner: a separate, versioned repo for the shared capability (C-07). Proposed, not ratified: TypeScript core with shell actuators at first (C-08); Traderton cells (C-09) | [03](../03-decision-register.md) | V |
| F14 | The sandbox UID egress rollout and the staging agent-node rollout are in progress and touch agent nodes | [plan](../../features/pending/000-sandbox-uid-egress/001-plan.md) | V |

## 5. Candidate options (not ranked)

- **Option A: No shared capability.** Keep the agent autoscaler as is. Copy and adapt it for the browser tier. Traderton stays manual. This contradicts C-07, so choosing it would reopen C-07.
- **Option B: Parameterise in place.** Make tier identity (node class, pool meta, label, name pattern, resource addresses, state and lock paths) configurable in the existing shell scripts, without a new repository yet. The browser tier becomes thin scripts over the shared functions.
- **Option C: New versioned repository, hybrid.** Shared repository with a TypeScript core for decision logic and typed ports (Nomad, Hetzner, Terraform runner), and the existing shell as actuators. Agent controller moved behind it later, with parity tests. Traderton adopts only the provisioning and safety layer.
- **Option D: New versioned repository, full rewrite.** Everything in TypeScript, including the agent controller, for all three tiers.
- **Option E: Adopt Nomad Autoscaler with the Hetzner plugin** for the two Nomad tiers. A bespoke path for Traderton.
- **Option F: Universal, configuration-driven engine** that manages any number of pools from one definition, built before the second tier exists.

The decision agent may derive a better option and must include a baseline.

## 6. What I could not determine

| # | Unknown | How to find out |
|---|---|---|
| U1 | The cost of parameterising the existing scripts: function bodies were not read | Read `scale-common.sh`, `capacity-controller.sh`, `capacity-inventory.sh`; try a spike on a branch and run `tests/run-all.sh` |
| U2 | Whether the existing test suite currently passes in full | Run `infra/hetzner/scripts/tests/run-all.sh` (read-only) |
| U3 | Whether Traderton's Phase 10 module extraction has started, and its timing | Ask the owner; check Traderton `docs/features/initial/CANONICAL-STATE.md` |
| U4 | Whether herobids and Traderton share a Hetzner project or token (INV-L3 coupling risk) | Compare `*.tfvars` provider settings (read-only; do not print tokens) |
| U5 | Whether the Hetzner plugin works with Terraform-owned servers and our safety guards | Read the plugin source; short staging spike |
| U6 | Traderton's scaling shape and bottleneck (OD-02) | Measurements listed in A-06, A-07, A-13 |
| U7 | Where the kit would run, and whether adding a Node runtime on the control plane is acceptable | `infra/hetzner/cloud-init.yaml`; control-plane resource budget |
| U8 | Engineering capacity over the next quarter (A-20) | Owner |

## 7. Constraints specific to this decision

- The agent autoscaler is safety-critical. Any change must keep its behaviour identical until a parity gate passes (INV-O6, INV-E7).
- The shared capability must not couple Traderton's runtime or state to herobids (INV-L3).
- Two real consumers must exist before abstraction (INV-E8). Today the agent tier is proven; the browser tier is a draft; Traderton has no autoscaling.
- The sandbox and agent-node rollouts are in progress on staging. Avoid destabilising agent scaling while they run.

## 8. Out of scope

- Designing Traderton's scale-out (OD-02).
- Control-plane scalability (OD-04) and residency policy (OD-03). They change node counts but not the shape of the answer.
- Implementation, repository creation and Terraform changes.
