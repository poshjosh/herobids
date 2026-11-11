# 02 Invariants

**Status:** Draft v0.1. Compiled from existing sources; nothing here is new law unless marked **[NEW]**.
**Last reviewed:** 2026-11-11
**Purpose:** rules a recommendation must pass before it is compared on merit.

**Severity**

- **HARD:** never break. Breaking one needs the owner's explicit ratification.
- **FIRM:** break only through a recorded decision that names the invariant and the reason.
- **SOFT:** strong default. Deviation needs a stated reason in the record.

**Source wins.** Each row summarises its source. If they differ, the source is right and this row must be fixed. Paths are relative to this folder. `T:` means the Traderton repo.

**Conflict order** (when two invariants collide): Legal and isolation, then Safety, then Security, then Operations safety, then Engineering, then Process. Same as the value hierarchy in [01-strategy.md](./01-strategy.md#5-value-hierarchy-the-trade-off-order).

## L. Legal and isolation

| ID | Invariant | Severity | Source | Verify by |
|---|---|---|---|---|
| INV-L1 | Trading is a separately deployable, isolable unit. Today herobids consumes Traderton out-of-process over the REST boundary and does not import `@traderton/*` into the shipped platform process. | HARD | T: `docs/features/initial/000-vision.md` | Search herobids for `@traderton/` imports in shipped packages |
| INV-L2 | Trading authority and trading logic live in Traderton. Herobids owns users, connections, agent grants, plans and the boundary client. Do not mirror trading logic or preset definitions in herobids. If a change seems to need a trading decision in herobids, stop and ask the owner. | HARD | [../../AGENTS.md](../../AGENTS.md), [ADR 011](../tech/architecture/adrs/2026/09/011-split-trading-authority-by-responsibility.md), [ADR 018](../tech/architecture/adrs/2026/10/018-eliminate-parity-drift-check.md) | Review diff for order sizing, risk limits, venue calls, strategy presets |
| INV-L3 | Traderton keeps its own VM, state and credentials. The two systems meet at a signed (HMAC) HTTPS boundary. A shared tool or library must not create runtime or state coupling. **[NEW wording, from T: `infra/hetzner/README.md`]** | HARD | T: `infra/hetzner/README.md`, `docs/features/initial/004-decision-log.md` | Check separate Terraform state, credentials, and no shared runtime dependency |

## S. Safety of users, funds, data and running agents

| ID | Invariant | Severity | Source | Verify by |
|---|---|---|---|---|
| INV-S1 | Never duplicate an external action. A trading agent is owned by exactly one executor at a time. Exactly-once cannot be assumed for arbitrary external effects: use provider idempotency, reconciliation and fencing, otherwise enter a visible safe-pending state. | HARD | [agent-continuity roadmap](../features/2026/10/30/001-agent-continuity-and-safe-capacity/000-roadmap.md) | Design must name the ownership/fencing mechanism |
| INV-S2 | Acknowledged work is not lost. Unsupported or uncertain effects go to a safe pending state, never blind replay. | HARD | same | Failure-injection test or documented recovery path |
| INV-S3 | Scale-in, drain or replacement never cuts a live browser session or a running agent without a defined handover. Abort the removal instead. **[NEW wording, from decision C-04 and Plan 005]** | HARD | [Plan 005](../features/pending/005-browser-pool-dedicated-tier/001-plan.md) | Test under load |
| INV-S4 | Agent mode purity: the creator's goal text and explicit constraints are the source of policy. No hidden constraints. User-configured limits are immutable by the agent. Operator defaults come from config, not code. | FIRM | [../../AGENTS.md](../../AGENTS.md) | Review for hard-coded limits |
| INV-S5 | LLM hidden reasoning is never persisted, parsed for tools, or shown to users. | HARD | [../../AGENTS.md](../../AGENTS.md) | Boundary test at `@herobids/llm` |
| INV-S6 | Defence in depth on every LLM-facing surface that can trigger side effects. | FIRM | [ADR 007](../tech/architecture/adrs/2026/08/007-defense-in-depth-for-llm-surfaces.md) | Layer checklist in the ADR |

## X. Security

| ID | Invariant | Severity | Source | Verify by |
|---|---|---|---|---|
| INV-X1 | No secrets, keys or credentials in the repo. `.env*` files stay ignored. Every `.env*` has a committed `.example` twin updated in the same change. | HARD | [../../AGENTS.md](../../AGENTS.md) | Diff scan; twin present |
| INV-X2 | Browserless has no authentication. The browser pool, and anything fronting it, must be reachable only on the private network. | HARD | [Plan 005](../features/pending/005-browser-pool-dedicated-tier/001-plan.md), [bug 2026/11/08 001](../bug-reports/2026/11/08/001-browser-pool-registered-on-public-address-blocked-by-ufw.md) | External probe from outside the network |
| INV-X3 | Validate at trust boundaries (API input, config load, venue responses) with Zod. Interior code trusts validated types. | FIRM | [../../AGENTS.md](../../AGENTS.md) | Schema present at each boundary |
| INV-X4 | Do not weaken a security profile (AppArmor, seccomp, egress rules) to make a tool work without a recorded decision. | FIRM | [rollout guide](../tech/agents/agent-runtime-rollout-guide.md) section 2 | Record names the trade-off |

## O. Operations and change safety

| ID | Invariant | Severity | Source | Verify by |
|---|---|---|---|---|
| INV-O1 | Terraform: run in the environment's own data dir (`TF_DATA_DIR=.terraform-envs/<env>`), plan first, read the plan, apply only a reviewed plan. An unexpected destroy is a stop. | HARD | [../../AGENTS.md](../../AGENTS.md), [rollout guide](../tech/agents/agent-runtime-rollout-guide.md) section 4 | Plan output reviewed and recorded |
| INV-O2 | Never mutate shared infrastructure state while investigating (no Terraform apply, no workspace creation, no backend writes, no S3/DNS/server changes) without owner approval. | HARD | [../../AGENTS.md](../../AGENTS.md) | Commands used are read-only |
| INV-O3 | Node configuration ships before job requests that depend on it. New runtime behaviour ships dark behind a flag that defaults to off. | FIRM | [rollout guide](../tech/agents/agent-runtime-rollout-guide.md) section 1 | Flag default and order in the plan |
| INV-O4 | Prove the full chain on one target before many. Keep a fast rollback and know the command before starting. | FIRM | same | Plan has gate and rollback per phase |
| INV-O5 | Staging before production. Production receives the same gates. | FIRM | same, [Plan 005](../features/pending/005-browser-pool-dedicated-tier/001-plan.md) | Plan order |
| INV-O6 | Every autoscaler has hard minimum and maximum bounds, a cooldown, and fails closed: it refuses to act when inventory, ownership or drift is unknown. | HARD | [safe-capacity roadmap](../features/2026/10/30/001-agent-continuity-and-safe-capacity/000-roadmap.md), `infra/hetzner/variables.tf` | Bounds and refusal paths tested |
| INV-O7 | Every async loop reschedules itself on failure (`finally` or top-level catch). Fatal versus warn-and-continue is a deliberate choice. | FIRM | [../../AGENTS.md](../../AGENTS.md) | Code review |
| INV-O8 | Read state from the source (Nomad, DB, running container), not from a wrapper's summary or memory. Namespaces and env ordering have caused false results before. | SOFT | [rollout guide](../tech/agents/agent-runtime-rollout-guide.md) section 1 and 9 | Command output in the record |

## E. Engineering

| ID | Invariant | Severity | Source | Verify by |
|---|---|---|---|---|
| INV-E1 | TypeScript strict. No `any`, `@ts-ignore`, `as unknown as X`. No swallowed errors. | FIRM | [../../AGENTS.md](../../AGENTS.md) | `pnpm lint` |
| INV-E2 | Public APIs return `Result<T, E>` with namespaced dot-string error codes. | FIRM | same | Review |
| INV-E3 | Ports and adapters. Domain ports in `packages/domain`. Business logic is pure where possible. Constructor injection, no singletons. No circular package dependencies. | FIRM | same | Dependency check |
| INV-E4 | Two config layers, never mixed: operator config (deploy/restart) and instance config (runtime). No hard-coded magic numbers for limits or defaults. | FIRM | [../../AGENTS.md](../../AGENTS.md), [../best-practices/configuration.md](../best-practices/configuration.md) | Where does the value live? |
| INV-E5 | No new dependency without justification. Pin exact versions. Flag unusual package names. | FIRM | same | Diff |
| INV-E6 | Investigate before fixing: read related docs, search `docs/bug-reports/`, read `git log` for affected files. | SOFT | same | Cited in the record |
| INV-E7 | "Dead" is proven by trial deletion judged by the owning repo's build and full suite, not by grep. | FIRM | [parity epic invariants](../features/2026/10/10/001-eliminate-parity-check/invariants-and-quality-gates.md) I6 | Suite output |
| INV-E8 | Abstract only when duplication is proven. Write the simplest code that meets the need. A parameter with one real value is a constant. | SOFT | [../../AGENTS.md](../../AGENTS.md), T: decision log | Evidence of at least two real consumers |
| INV-E9 | Run focused tests, then `pnpm lint` and the relevant build before declaring code work complete. | FIRM | [../../AGENTS.md](../../AGENTS.md) | Command output |

## P. Process

| ID | Invariant | Severity | Source | Verify by |
|---|---|---|---|---|
| INV-P1 | "Done" is a behaviour of the running system, not an artifact. Freeze exit checks before implementing. A partial result is reported as not done. | FIRM | [lesson](../lessons/definition-of-done-and-goalpost-drift.md) | Exit check stated as behaviour |
| INV-P2 | Defer only with a named home. A deferral recorded after the fact to explain a gap is goalpost drift. | FIRM | same | Deferral has an owner and a place |
| INV-P3 | Copies drift. Text or code in more than one place is already wrong or soon will be. Prefer one owner and a pointer. | SOFT | same | Duplicate search |
| INV-P4 | Trading-extraction work: nothing merges to `main` in either repo without explicit owner approval. **Scope: the extraction/cutover. Check T: `CANONICAL-STATE.md` for whether it is still active.** | HARD while active | T: `docs/features/initial/008-decision-process.md` section 6.1 | Branch workflow |
| INV-P5 | Test names describe behaviour. Commits are atomic and focused. | SOFT | [../../AGENTS.md](../../AGENTS.md) | Review |

## How to use this file

1. Before comparing options, test each against the HARD rows. Any option that breaks one is **gated out** unless the owner ratifies it.
2. Then test against FIRM rows. A break needs a decision naming the row.
3. A recommendation states which invariants it touches, and how it keeps or deliberately breaks each.
4. If a needed invariant is missing, say so in the record under "Invariant gaps". Do not invent one.

## Candidate invariants not yet adopted

Raised during framework design. The owner decides whether to adopt them.

- **[PROPOSED] INV-N1:** every autoscaled tier states its scale-in hazard and drain procedure before enabling scale-in.
- **[PROPOSED] INV-N2:** no cost-bearing automation runs in production without a spend ceiling and an alert.
- **[PROPOSED] INV-N3:** every number used to size capacity has an evidence grade, and anything below grade P or V is flagged in the plan.
