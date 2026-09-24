# Program Entrypoint — External Backend / Staging

**Status:** living. **Read this first, every session, before any action.**
**Date established:** 2026-09-24
**Scope:** the cross-repository effort to run Traderton as an independently
deployable trading service while Herobids remains the generic agent platform.

> A fresh agent with no conversation context starts here, then reads
> [PROGRESS.md](./PROGRESS.md) to discover exactly where work stopped, and
> consults [DECISIONS.md](./DECISIONS.md) before making any judgment call.

## 1. Strategic objective (TOP — read before anything else)

Separate trading from the agent platform so that **Herobids is a generic agent
host and Traderton is an independently owned trading product/backend**.
Trading-domain instructions, tool schemas, risk/execution policy, venue rules,
credentials, persistence, documentation, and (later) the trading frontend are
Traderton-owned. Herobids retains only generic agent hosting, generic external
skill installation, generic signed dispatch, health/visibility composition, and
the operator-managed registration of external backends.

This is driven by a legal/payment-provider requirement: **herobids must not be
a trading application.** Engineering can support that claim; it cannot alone
decide whether a payment provider accepts it.

## 2. Next milestone objective (narrow, expires when done)

Restore Herobids staging, then deploy Traderton as an independently reachable
staging backend. **Do not begin the generic External Backend refactor until
staging operational proof is complete.** The current step is recorded at the
top of [PROGRESS.md](./PROGRESS.md).

## 3. Roadmap

[001-staging-first-external-backend-roadmap.md](../001-staging-first-external-backend-roadmap.md)
— the 16-step, 3-phase sequence. PROGRESS.md is its live tracker; the roadmap
is the stable plan.

## 4. Invariants / rules (governing law)

1. **No infrastructure mutation without explicit operator approval.** Terraform
   apply/destroy, redeploys, resets, DNS/TLS changes, and provisioning are all
   gated. Diagnosis and read-only observation are the default.
2. **Ownership boundary:** Traderton owns trading domain behaviour; Herobids
   owns only generic platform concerns. Provider-named code (`traderton/`,
   `system/trading`) is not the target state — see [ADR 015](../../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md).
3. **No backward-compatibility obligation.** There is no production/customer
   deployment or agent data to preserve (greenfield cutover), so do not build
   migrations, aliases, or dual-run shims. Staging state is not assumed
   disposable; confirm it by inspection before any reset.
4. **Main-branch discipline.** Neither repo merges to `main` without explicit
   human approval. Work on the current state of `main` or a designated branch.
5. **Parity, not liveness** (traderton invariant). This work moves first-party
   ownership and changes nothing trading behaviourally without a Gap/Deferred/
   Intentional-divergence record.

**Precedence over Traderton's autonomy contract.** Traderton
`008-decision-process.md` treats merging as the only mandatory stop and permits
local infrastructure wiring without pre-approval. For THIS program the stricter
rule here wins: mutation of **operator-managed** infrastructure (staging,
production, cloud/Terraform-managed resources, DNS/TLS, shared services) always
requires explicit operator approval. Purely local, ephemeral dev/test
scaffolding (e.g. a local `docker compose up` for testing) remains autonomous.

### Authorization default (what you may do without asking)

- **Read-only observation and investigation are always permitted.** Gathering
  context — reading code, reading state, running non-mutating checks — is normal
  step work, not something that needs approval.
- **Mutation is gated.** Any change to infrastructure, configuration, DNS/TLS,
  secrets, or data requires explicit operator approval first.
- **Judgment calls route to Contemplator** per §6, not to the operator (unless
  the ruling would violate an invariant — then human ratification).

Also read, when relevant:
- `herobids/AGENTS.md` and `traderton/AGENTS.md` (repo rules).
- `traderton/docs/CANONICAL-STATE.md` (authoritative truth for traderton).
- `traderton/docs/features/initial/8-decision-process.md` (the Contemplator routing rule).

**Precedence and staleness.** `traderton/docs/CANONICAL-STATE.md` is the
authority for Traderton-internal state, decisions, and invariants, but it
documents the research/extraction phase and can lag the live git state (it may
still describe the boundary/L3 work as branch-only). Where it and this program
describe the same live fact, verify against both repos' git state
(`git status` / `git log` on `main` and the working branch) rather than trusting
either summary verbatim. For sequencing and authorization of THIS program,
ENTRYPOINT.md §1–§4 are controlling.

## 5. Operating loop (per step)

For every step in PROGRESS.md run:

```
read ENTRYPOINT → read PROGRESS → prepare (investigate ⇄ plan) → [decision checkpoint] → implement → verify → record
```

- **prepare (investigate ⇄ plan)** — investigate and plan are an iterative
  pair, not a fixed order. Read-only investigation is always permitted; use it
  to gather enough grounded facts (file:line or observed state) to write the
  current step's plan, and plan in light of what you find — revisit either as
  needed. A separate "discover" stage is not used; investigation is just the
  context-gathering half of preparation.

  If the current step has **no written plan**, author one before implementing.
  Write it as its own dated file under `docs/features/2026/09/24/` (e.g.
  `NNN-<step-slug>-plan.md`) and link it from the roadmap and the PROGRESS.md
  "Notes / handoff" column. A full plan is required for any step that can
  mutate infrastructure, change externally-visible behaviour, or touch the
  ownership boundary; a purely mechanical step may use a short checklist. A
  plan must state: objective, scope, non-goals, ordered concrete tasks,
  verification/exit criteria, and any approval gates. Writing or refining a
  plan is itself read-only work and is always permitted; executing a mutating
  plan still requires the approvals the plan marks.

- **decision checkpoint** — apply the trigger test in §6; route judgment calls
  to a fresh Contemplator via the handoff in [DECISIONS.md](./DECISIONS.md).
- **implement** — no infra mutation without approval; keep changes atomic.
- **verify** — build/lint/tests or the documented staging checks.
- **record** — update PROGRESS.md, and log decisions in DECISIONS.md.

## 6. Decision trigger test (when to spin off Contemplator)

Route a choice to Contemplator when it could:
- **degrade the ownership boundary** (leave/return trading behaviour in Herobids, or add a Traderton-named branch to generic code);
- **change externally-visible behaviour** (a contract, tool, route, or copy change);
- **mutate infrastructure** (any apply/destroy/reset/DNS/TLS — even if "low-risk", the approval gate still applies);
- **contradict a recorded decision or an invariant.**

Low-stakes mechanical choices (a variable name, an internal helper, a doc reword) are decided normally. When in doubt, route it.

## 7. Document map

| Doc | Role |
| --- | --- |
| `ENTRYPOINT.md` (this file) | Strategic objective + invariants + loop |
| `PROGRESS.md` | Live 16-step tracker + exact continue-from point |
| `DECISIONS.md` | Decision log + Contemplator handoff protocol |
| `../001-staging-first-external-backend-roadmap.md` | Stable plan |
| `../002-staging-recovery-diagnostic-plan.md` | Current step's detailed read-only plan |
| ADR 015 | External Backend naming/trust decisions |
| traderton `008-decision-process.md` | Full deliberation/routing procedure |