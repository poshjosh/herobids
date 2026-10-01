# Phase 2 Program — TASKS (ordered, executable)

**Status:** live tracker. **Read `ENTRYPOINT.md` first, then work this list.**
Do not pause between tasks.

**Current cursor:** `T0.1` (not started). ← Update this line to the task you are
on after every task, so a context reset resumes unambiguously.

### Status scheme (use the emoji, NOT the checkbox)

Each task is prefixed with ONE status emoji. Edit the emoji as you progress; the
`- [ ]` checkbox is cosmetic — ignore it, the emoji is the source of truth
(because ⤴/🚫 have no checkbox equivalent).

- ⬜ not started · 🔄 in progress · ✅ done · 🚫 blocked (hard stop §5.2) ·
  ⤴ escalated-legal (row recorded in `ESCALATIONS.md`; CONTINUE other work)

Worked example row:
`- ✅ **T0.1 Load context.** …`  → done.
`- 🚫 **T4.2 Publishing …**` → blocked on operator (infra hard stop); move on.

Per task: **Goal · Inputs · Agent/skill · Exit criteria · Decision/escalation
note.** Every task ends with: `pnpm lint` + build/tests green, local commit,
update this file (status + cursor) + DECISIONS.md.

### Dependencies & parallelism (roadmap allows overlap)

Blocks are NOT a strict chain. Independent / parallelizable:
- **Block 1 (frontend remediation)**, **Block 2 (backend audit)**, and **Block 3
  (doc move)** are largely independent and may proceed in parallel (or in any
  order) once Block 0 is done.
- **Block 4 (Traderton site)** is independent of Blocks 1–2.

Genuine gates:
- T2.1 (backend audit) **must precede** T2.2 (backend remediation).
- T2.1 may **reclassify a doc as MOVE** → such items feed Block 3; so if running
  serially, prefer T2.1 before T3.1 to avoid missing doc moves.
- T5.1 (reconcile) depends on T1.1 **and** T2.1 being complete.
- T4.2 (publish) is a hard stop regardless of other progress.

---

## Block 0 — Orientation (do once)

- ⬜ **T0.1 Load context.** Read ENTRYPOINT, this file, DECISIONS, ESCALATIONS.
  Read the roadmap Phase 2 steps, ADR 015, the frontend audit (`../003-…`), and
  the 002 analysis/plan. Confirm staging is live (read-only: herobids
  `/api/health`, Traderton `/health/ready`) — if not, that is a Phase 1 concern,
  note and proceed with doc/code work that does not need staging. **Confirm the
  traderton repo** (`~/dev_ai/traderton`) exists and is clean (needed for Blocks
  3–4; see ENTRYPOINT §3.6).
  - Exit: you can restate the objective, the two hard stops, and the
    classification rubric without re-reading.
- ⬜ **T0.2 Confirm `ESCALATIONS.md` is present** (it is pre-seeded in this
  folder with the §5.3 columns). If somehow missing, recreate it from the
  ENTRYPOINT §5.3 template. This is where every ESCALATE-LEGAL item goes.

## Block 1 — Step 8 remediation: frontend (already audited)

- ⬜ **T1.1 Implement the genericize-agent-capability-UI slice.** Execute
  `../002-genericize-agent-capability-ui/001-plan.md` Stages 1–5 (generic
  capability list, Capabilities tab, remove type selector, API-client family
  generalization with the lockstep caveat, i18n relabels).
  - Agent: PlanCreator (refine the plan if stale) → Implementer → UnitTester →
    CodeReviewer/Reworker. VisualTester for the UI.
  - Exit: trading / trading+email / email-only / no-skill agents all render the
    correct capabilities; no top-level Trading/Strategy tab; no type selector;
    trading agents unchanged; `pnpm lint` + web build + tests green.
  - Decision note: any API `skillPresetId`/route change that would break the
    deployed contract → keep a thin alias and record the API removal as a
    backend-audit dependency (do NOT break the boundary).

## Block 2 — Step 8 audit: backend (mirror the frontend audit)

- ⬜ **T2.1 Backend trading-coupling audit.** Inventory trading-specific
  surfaces in `apps/api`, `apps/worker`, `packages/*` that are *product/identity*
  coupling (NOT the legitimate Traderton boundary client): API routes
  (`/capabilities/trading/*`, `skillPresetId` enum), system-skill seeds
  (`SYSTEM_SKILLS`, trading presets), prompt/preset copy, SEO/sitemap, billing
  product copy, marketplace. Classify each with the §5.1 rubric. Produce the
  audit doc at the **next available number** —
  `docs/features/2026/10/NNN-backend-trading-coupling-audit.md` (list the
  directory, take the highest existing `NNN-` prefix + 1; same shape as
  `../003-…`). Reserve the number before writing to avoid collisions.
  - Agent: investigate directly or delegate a scoped research sub-agent; write
    with PlanCreator if large.
  - Exit: a complete classified inventory; GENERIC/MOVE/REMOVE-SAFE items listed
    as follow-on tasks here; ESCALATE-LEGAL items appended to `ESCALATIONS.md`.
  - Note: distinguish *trading product coupling* (in scope) from the generic
    External Backend boundary (Phase 3, out of scope here).
- ⬜ **T2.2 Execute backend REMOVE-SAFE / GENERIC remediations** surfaced by
  T2.1 that do not touch the deployed boundary contract or need legal input.
  - Agent: PlanCreator → Implementer → Tester → Reworker.
  - Exit: changes done + verified; contract-affecting ones deferred with a note.

## Block 3 — Step 6: move trading documentation

> **Prerequisite (ENTRYPOINT §3.6):** before writing into the traderton repo,
> confirm `~/dev_ai/traderton` exists + clean and read its `AGENTS.md` /
> conventions (and `docs/CANONICAL-STATE.md` if present). Author to traderton's
> conventions; same no-push rule.

- ⬜ **T3.1 Inventory herobids trading docs.** Find trading reference/venue/
  wallet-funding docs under `docs/` and any public-page content
  (`apps/web/src/features/public-pages/`). Classify generic vs trading-domain.
  - Exit: a list of files to MOVE vs KEEP (generic/referential).
- ⬜ **T3.2 Move trading-domain docs to Traderton.** Relocate the MOVE set into
  the traderton repo (`~/dev_ai/traderton`) as its canonical docs; leave
  herobids with only generic/referential content and update internal links.
  - Decision note: moving files across repos is code/content, not infra — allowed.
    Committing in the traderton repo follows the same no-push rule.
  - Exit: herobids trading reference docs removed/relocated; no dangling links
    (link-check or grep); traderton holds the canonical copies.

## Block 4 — Step 7: minimal Traderton frontend

> **Prerequisite (ENTRYPOINT §3.6):** same traderton-repo checks as Block 3.

- ⬜ **T4.1 Author the minimal site content** for `staging.traderton.com`:
  docs, venue guides, service status, product identity. No trading dashboard, no
  execution-boundary exposure. Build it in the traderton repo per its
  conventions (mirror herobids public-pages patterns where sensible).
  - Agent: PlanCreator → Implementer → VisualTester (local).
  - Exit: site builds and serves locally; content present; no route reaches the
    execution boundary (assert the apex/execution block, mirroring the staging
    Caddy guard).
- ⬜ **T4.2 Publishing (DNS/TLS/deploy) — HARD STOP.** Prepare the publish steps
  (DNS, TLS, deploy) and document them; do NOT execute. Request operator
  approval. Status 🚫 until approved.

## Block 5 — Step 8 wrap-up

- ⬜ **T5.1 Reconcile the audits.** Confirm every surface from the frontend
  (`../003-…`) and backend (T2.1) audits is either done (GENERIC/MOVE/
  REMOVE-SAFE) or in `ESCALATIONS.md`. No surface left unclassified.
- ⬜ **T5.2 Finalize `ESCALATIONS.md`** as the single operator decision batch
  (the legal/payment-provider product-boundary questions). This is the one
  deliverable that waits on the operator.
- ⬜ **T5.3 Phase 2 closeout.** Update this file (all tasks ✅/⤴/🚫), update
  DECISIONS.md, and update the staging program tracker
  `../../09/24/000-program/PROGRESS.md` Steps 6–8 to reflect reality. Write a
  short Phase 2 completion note under `docs/features/2026/10/`.
  - Exit: Phase 2 Definition of Done (ENTRYPOINT §8) met, modulo the batched
    legal escalations and any infra hard stops awaiting operator approval.

---

## Running notes / handoff (append as you work)

- *(empty — the implementing agent fills this with per-task evidence, commit
  SHAs, which sub-agent ran each task, and any Contemplator rulings.)*
