# Phase 2 Program — ENTRYPOINT (read this first, every session)

**Status:** living. **A fresh agent with no prior context starts HERE.**
**Created:** 2026-10-01
**Scope:** Phase 2 of the staging-first External Backend roadmap — the
**product/legal boundary** work that makes herobids present as a generic agent
platform, not a trading application.

> You are an autonomous implementing agent. You will NOT have the context of the
> agent that wrote this. Everything you need is in this package plus the
> referenced docs. Read in this order: **ENTRYPOINT → TASKS → DECISIONS**, then
> start at the first incomplete task in TASKS.

## 0. Reading order & document map

| Doc | Role |
|---|---|
| `ENTRYPOINT.md` (this) | Objective, invariants, autonomy contract, decision framework, handoff rules |
| `TASKS.md` | The ordered, executable task list (Steps 6–8 + audits + remediation). Your live tracker with a `Current cursor:` line at the top. |
| `DECISIONS.md` | Decisions already made (do not relitigate) + where you append new ones |
| `ESCALATIONS.md` | The single batch of legal/payment-provider questions you cannot decide (§5.3). Already present (pre-seeded); append to it, never pause for it. |

Referenced (authoritative; do not duplicate — read them):
- Roadmap: `../../../09/24/001-staging-first-external-backend-roadmap.md` (Phase 2 = Steps 6, 7, 8)
- Staging program charter: `../../../09/24/000-program/ENTRYPOINT.md` — its §1 objective and §4 invariants GOVERN this program too.
- Staging decision protocol: `../../../09/24/000-program/DECISIONS.md` — the Contemplator handoff + trigger test. Reused verbatim here.
- Architecture authority: `../../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md` (ADR 015, Accepted).
- Frontend audit (already done): `../003-frontend-trading-coupling-audit.md`
- First remediation slice (specced): `../002-genericize-agent-capability-ui/{000-analysis.md,001-plan.md}`

## 1. Strategic objective (TOP — read before anything)

Separate trading from the agent platform so **herobids is a generic agent host**
and **Traderton owns the trading product**. This is driven by a legal/payment-
provider requirement: **herobids must not be a trading application.** Phase 1
(deploy Traderton independently + prove staging) is done. Phase 2 removes
herobids' first-party *trading product surface*: documentation, a minimal
Traderton site, and an audit-driven cleanup of trading-specific UI/API/SEO/
billing/skill surfaces — deciding per surface: make generic, move to Traderton,
or remove.

## 2. Phase 2 scope (the three roadmap steps)

- **Step 6 — Move trading documentation.** Traderton becomes the canonical home
  for trading reference/venue/wallet docs. herobids keeps only generic or
  referential docs.
- **Step 7 — Minimal Traderton frontend.** A small public site at
  `staging.traderton.com` (docs, venue guides, service status, product
  identity). No trading dashboard. Does not expose the execution boundary.
- **Step 8 — Audit the legal/product boundary.** Inventory every herobids
  trading-specific surface (UI, API, setup, credential, billing, SEO, skill,
  marketplace); decide per surface: generic / move / remove; execute the safe
  changes; batch the legal-only questions (see §5).

The **frontend trading-coupling audit** (`../003-…`) and the
**genericize-agent-capability-UI** remediation (`../002-…`) are the already-
produced first inputs to Step 8. A matching **backend audit** is a Step 8 task
(see TASKS).

## 3. Invariants / governing law (inherited — do not break)

All invariants in `../../../09/24/000-program/ENTRYPOINT.md §4` apply. The ones that
bite most in Phase 2:

1. **No infrastructure mutation without explicit operator approval.** Terraform
   apply/destroy, DNS/TLS changes, deploys, secret changes, traffic exercises
   are all gated. This is a HARD STOP (see §5).
2. **Ownership boundary.** Trading domain behaviour/semantics belong to
   Traderton; herobids core stays generic. Do not add Traderton-named branches
   to generic platform code.
3. **No backward-compatibility obligation** (greenfield; no users/data). Prefer
   clean removal over compatibility shims. But do not break the deployed
   herobids↔Traderton boundary contract without a lockstep change on both sides.
4. **Main-branch discipline.** Do not merge to `main` or push without explicit
   human approval. Work on `main`'s current state or a designated branch; commit
   locally. **This applies to BOTH repos** (herobids and traderton).
5. **Parity, not liveness.** Moving ownership must not change trading behaviour
   without a recorded Gap/Deferred/Intentional-divergence note.
6. **Cross-repo rule (Steps 6–7 write into traderton).** Before writing anything
   into the traderton repo (`~/dev_ai/traderton`): confirm it exists and the
   working tree is clean, and **read its own `AGENTS.md` / repo conventions**
   (and `docs/CANONICAL-STATE.md` if present) first. Author traderton content to
   traderton's conventions, not herobids'. Same no-push rule there.

## 4. Autonomy contract (how to run without pausing)

**Default: act. Decide via the framework in §5. Do NOT pause for operator input
except for the two hard stops in §5.** Specifically you MAY, without asking:

- read anything; run read-only investigation and builds/tests/lint;
- classify every trading surface (generic / move / remove / escalate);
- make and commit (locally) the engineering changes that are reversible and
  within scope: genericizing UI, relabeling i18n, moving docs, writing the
  minimal Traderton site content, removing or hiding trading-only surfaces that
  carry no legal ambiguity;
- generate plans (via PlanCreator) and spawn sub-agents (§6);
- update TASKS.md and DECISIONS.md as you go.

You run the loop per task: **read ENTRYPOINT → read TASKS → prepare (investigate
⇄ plan) → [decision checkpoint §5] → implement → verify (build/lint/test) →
record (TASKS + DECISIONS)**. Keep going through the whole task list; do not stop
between tasks.

## 5. Decision framework (rule your own judgment calls)

For every choice, apply this rubric. Only two outcomes stop you; everything else
you decide and record.

### 5.1 Per-surface classification rubric (Step 8 core)

For each trading-coupled surface, classify as exactly one:

| Class | Test | Action (autonomous) |
|---|---|---|
| **GENERIC** | The surface is really capability-neutral and only *looks* trading (labels, trading-only queries, hardcoded family). | Make it generic/driven by skills+capabilityFamilies. Do it. |
| **MOVE** | Trading-domain content that belongs to Traderton (reference docs, venue/wallet guides, trading product copy). | Move to Traderton (Step 6/7). Do it. |
| **REMOVE-SAFE** | A trading-only surface herobids should not carry, whose removal/hiding has **no** legal/billing/entitlement ambiguity and is reversible. | Remove or hide behind a capability gate. Do it. |
| **ESCALATE-LEGAL** | Removing/keeping it is a **legal/payment-provider/product-identity** judgment (e.g. may herobids mention/link a trading product? billing copy? SEO/marketplace positioning?). | Do NOT decide. Record in the escalation batch (§5.3). Continue with other work. |

If unsure between REMOVE-SAFE and ESCALATE-LEGAL, treat it as ESCALATE-LEGAL.

### 5.2 The TWO hard stops (the only reasons to wait on the operator)

1. **Infrastructure mutation** — any Terraform apply/destroy, deploy, DNS/TLS,
   secret, or live-traffic action (invariant §3.1). Prepare it, document it,
   request approval; do not execute.
2. **Legal/payment-provider product-boundary calls** — the ESCALATE-LEGAL class.
   Do not decide these. Batch them (§5.3).

Nothing else is a hard stop. Hidden coupling, naming, tab layout, which skill to
move, how to render capabilities generically — decide these yourself.

### 5.3 Batched legal escalation (so you never pause mid-flight)

Do not interrupt the operator per legal question. Instead maintain a single file
`ESCALATIONS.md` in this folder: append each ESCALATE-LEGAL surface with (a)
what it is + file:line, (b) the options, (c) your engineering-neutral
recommendation, (d) why it needs legal/payment input. Keep working on everything
else. The operator resolves the whole batch at the end of Step 8.

### 5.4 Contemplator for genuine engineering judgment calls

For non-legal choices that are architecturally significant (could degrade the
ownership boundary, change a contract/route/public copy, or contradict a
recorded decision), route to a fresh **Contemplator** using the handoff protocol
in `../../../09/24/000-program/DECISIONS.md`. Record the ruling in DECISIONS.md.
Low-stakes mechanical choices: just decide.

## 6. Sub-agent / skill handoffs (available tooling)

Use the available agents/skills rather than doing everything inline:

- **Contemplator** — engineering judgment calls (§5.4). Produces a ruling.
- **PlanCreator** ("Plan") — when a task needs a concrete implementation plan,
  generate one (dated file in this folder or the relevant feature folder) before
  implementing. Required for any multi-file or behaviour-changing task.
- **Implementer** — execute an approved plan.
- **BugFixer** — diagnose/fix defects surfaced by verification.
- **Tester / UnitTester** — add/extend tests for changed behaviour.
- **VisualTester** — browser verification of UI changes (local xstack stack).
- **CodeReviewer / Reworker** — review and rework until only LOW issues remain.

Rule: for anything beyond a trivial edit, PlanCreator first, then Implementer,
then Tester, then CodeReviewer/Reworker. Record which agent did what in TASKS.md.

**Fallback:** if a named agent is not available in your environment (sub-agents
may be Autopilot-only, or the roster may differ), perform that role **inline**
yourself — the loop and quality bar are unchanged; only the delegation differs.

**Context budget:** Phase 2 is large for one context window. Delegate heavy
investigation and bulk implementation to sub-agents **specifically to preserve
your own context** so you can finish in one run — not as a style preference. Keep
the orchestration (TASKS/DECISIONS/ESCALATIONS state) in your own context; push
the deep file-reading and large edits out to sub-agents where available.

## 7. Verification & recording (every task)

- Run `pnpm lint` (must pass) and the relevant build/tests before marking a task
  done. For UI, run a VisualTester pass on the local xstack stack.
- Keep trading agents regression-free (a trading-only agent must behave exactly
  as before any genericization).
- Commit locally, atomic per logical change (invariant §4.4 — no push).
- Update TASKS.md status and append any decision to DECISIONS.md.

## 8. Definition of done (Phase 2)

- Step 6: trading reference/venue/wallet docs are canonical in Traderton;
  herobids retains only generic/referential docs.
- Step 7: a minimal `staging.traderton.com` site exists (docs/status/identity),
  no execution boundary exposed. (Any DNS/TLS/deploy to publish it = hard stop §5.1.)
- Step 8: every trading surface is classified and every GENERIC/MOVE/REMOVE-SAFE
  change is executed and verified; `ESCALATIONS.md` holds the complete
  legal-only batch for one operator decision; the frontend audit remediation
  (`../002-…`) is implemented; a backend audit exists and its safe remediations
  are done.
- `pnpm lint` + builds + tests green. TASKS.md fully checked. DECISIONS.md and
  ESCALATIONS.md current.
