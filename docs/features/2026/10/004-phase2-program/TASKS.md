# Phase 2 Program — TASKS (ordered, executable)

**Status:** live tracker. **Read `ENTRYPOINT.md` first, then work this list.**
Do not pause between tasks.

**Current cursor:** `T3.1` (next). ← Update this line to the task you are
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

- ✅ **T0.1 Load context.** Read ENTRYPOINT, this file, DECISIONS, ESCALATIONS.
  Read the roadmap Phase 2 steps, ADR 015, the frontend audit (`../003-…`), and
  the 002 analysis/plan. Confirm staging is live (read-only: herobids
  `/api/health`, Traderton `/health/ready`) — if not, that is a Phase 1 concern,
  note and proceed with doc/code work that does not need staging. **Confirm the
  traderton repo** (`~/dev_ai/traderton`) exists and is clean (needed for Blocks
  3–4; see ENTRYPOINT §3.6).
  - Exit: you can restate the objective, the two hard stops, and the
    classification rubric without re-reading.
- ✅ **T0.2 Confirm `ESCALATIONS.md` is present** (pre-seeded, confirmed). (it is pre-seeded in this
  folder with the §5.3 columns). If somehow missing, recreate it from the
  ENTRYPOINT §5.3 template. This is where every ESCALATE-LEGAL item goes.

## Block 1 — Step 8 remediation: frontend (already audited)

- ✅ **T1.1 Implement the genericize-agent-capability-UI slice.** Execute
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

- ✅ **T2.1 Backend trading-coupling audit.** Inventory trading-specific
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
- ✅ **T2.2 Execute backend REMOVE-SAFE / GENERIC remediations** surfaced by
  T2.1 that do not touch the deployed boundary contract or need legal input.
  - Agent: PlanCreator → Implementer → Tester → Reworker.
  - Exit: changes done + verified; contract-affecting ones deferred with a note.
  - **Safe-standalone GENERIC items to do now (from `../005-…` §Follow-on 1–4,8):**
    1. Genericize `GET /capabilities` (`apps/api/src/routes/capabilities/index.ts:23`)
       — derive family list from registered skills' `capabilityFamilies`.
    2. Un-gate the per-family presentation route
       (`apps/api/src/routes/capabilities/trading.ts:410`, `if family!=='trading'→404`).
    3. Relabel trading-specific generic error copy (`agents.ts:108`,
       `blueprints.ts:1026,1040` — "Trading service is unavailable").
    4. Capability-neutral default goal (`chat.ts:692` `synthesizePrompt` default).
    8. Capability-generic blueprint defaults (`blueprints.ts:448` — no `momentum`
       default for a generic blueprint).
  - **Deferred (contract/lockstep — P2-7/P2-12), NOT in this slice:**
    - (6) Generalize `/capabilities/trading/*` → `/capabilities/:family/*`
      (lockstep with web api-client).
    - (7) Demote `skillPresetId`/`strategyPreset`/`SKILL_PRESET_MAP` (web still
      sends `strategyPreset`; needs lockstep or ignore-window).
    - (5) Reshape Guided Setup into a family-driven flow (coordinate with E1).
    - Blueprint facet-schema genericization (larger; Phase-3-adjacent).

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

### Block 0 — Orientation (done 2026-10-01)
- Read ENTRYPOINT, TASKS, DECISIONS, ESCALATIONS, roadmap Phase 2 (Steps 6–8),
  frontend audit `../003-…`, and the 002 analysis + plan. Objective, two hard
  stops, and the §5.1 rubric are internalized.
- Repo state: both `herobids` and `traderton` on `main` with clean working
  trees. Phase 2 program docs already committed in herobids HEAD `e382c624`.
- Baseline `pnpm lint` (tsc --noEmit) green before any change.
- Staging health NOT reachable from this environment (DNS does not resolve for
  `staging.herobids.com` / `staging.traderton.com`). Per T0.1 this is a Phase 1
  concern — noted; proceeding with doc/code work that does not require staging.
- `ESCALATIONS.md` present and pre-seeded (§5.3 columns). Confirmed.

### Block 1 — T1.1 frontend genericization (done 2026-10-01)
- Agents: Implementer (frontend Stages 1–5), CodeReviewer (clean, LOW only),
  VisualTester (surfaced a backend gap), Contemplator (ruling P2-10),
  Implementer (backend readiness fix), CodeReviewer (backend, clean).
- Frontend: AgentDetailPage now derives capability families from skills and
  renders one readiness card per family; Advanced Settings has a generic
  **Capabilities** tab replacing Trading/Strategy; the agent "type"/preset
  selector is gone (replaced by a non-identity "Suggested skills" helper);
  `SkillPresetId` retired → `SuggestedSkillSetId`; i18n relabels across en/ar/hi.
- API-client: kept thin trading aliases (`tradingConnections`/`tradingPositions`)
  — deployed boundary contract untouched (P2-7). `skillPresetId` API field left
  accepted-but-ignored; its removal is a backend-audit (T2.x) follow-up.
- **Backend fix (P2-10, ruled in-scope):** `GET /agents/:id/capabilities/readiness`
  now emits one entry per family the agent's skills declare ∪ provider families,
  instead of a hardcoded `knownFamilies = ['trading']`. Kept the route's own
  per-family loop (preserves revoked-vs-unconfigured semantics; did NOT swap to
  `resolveRuntimeCapabilityDescriptor` which filters to active grants). This
  completes audit issue #1 end-to-end (email-only agent now shows an email card).
- Verification: `pnpm lint` green; web build + 681 web tests green; api+db builds
  green; capability functional tests 5/5 green (against local compose pg+redis).
- UAT recorded in `docs/tech/user-acceptance-tests.md` §6.0b (GC-01…GC-08);
  GC-02/GC-03 (originally ❌ for the backend gap) are fixed by P2-10.
- Commit: see git log (local, no push). SHA 44c67098.

### Block 2 — T2.1 backend audit (done 2026-10-01)
- Agent: Contemplator (scoped research) authored `../005-backend-trading-coupling-audit.md`.
- Classification: 13 GENERIC, 3 MOVE, 0 REMOVE-SAFE, 3 ESCALATE-LEGAL (E1/E2/E3
  appended to ESCALATIONS.md). KEEP = trading skills, worker/engine mechanics,
  Traderton boundary. Boundary + `domain/{traderton,trading}` internals are
  Phase-3-owned.
- Correction recorded (P2-12): web still SENDS `strategyPreset` (and the
  `skillPresetId` field plumbing remains) in `agent-payloads.ts:265,273` → those
  backend removals are lockstep, not standalone.
- MOVE items feed Block 3 (doc move): `buildTradingPrompt` venue/strategy
  reference copy; web `trading-venues` docs; `reference/crypto-ecosystem` docs.

### Block 2 — T2.2 safe-standalone backend remediations (done 2026-10-01)
- Agents: Implementer (slice) → CodeReviewer (clean, LOW only). Resume agent
  re-verified before commit.
- Implemented the fully-safe-standalone GENERIC follow-ons from `../005-…`:
  1. `GET /capabilities` (`capabilities/index.ts`) now derives its `families`
     list from the deduped, sorted `capabilityFamilies` across `SYSTEM_SKILLS`
     (was a hardcoded single `trading` entry). Read-only, additive. Dropped the
     trading-specific `description` field (was "Algorithmic trading across
     multiple venues") rather than invent per-family copy.
  3. Capability-neutral 503 copy: `agents.ts:108`, `blueprints.ts:1026/1040`,
     and the matching `trading.ts` `boundaryUnconfiguredError` message now say
     "The capability service is unavailable …" instead of "Trading service …".
  4. `synthesizePrompt` (`chat.ts`) ungated final fallback is now the
     capability-neutral "Assist with the user's goals and tasks"; the trading
     allocation clause stays gated behind `capital` (only populated for trading
     presets). Test relabelled to assert the neutral default.
- **Item 2 (un-gate presentation 404):** already a no-op — grep for
  `family !== 'trading'` in `trading.ts` returns 0 hits; the
  `/agents/:agentId/capabilities/:family/presentation` route is already
  generic-by-`:family` with no trading-only 404 gate (nothing to remove).
- **Item 8 (blueprint `momentum` default, `blueprints.ts:448`): deferred** — it
  changes a default *payload* (behaviorally risky vs. a pure relabel) and sits
  outside the reviewed-clean slice; recorded under Outstanding Issues for a
  family-scoped-defaults follow-up rather than widening this slice.
- Verification: `pnpm lint` green; `@herobids/api` build green; chat tests 94/94
  green; capability-model functional tests 5/5 green (local compose pg+redis).
- Commit: local, no push (see git log).

---

## Outstanding Issues (non-blocking; from code review)

Low-severity observations recorded during review (no CRITICAL/HIGH remain).
Grouped by task.

### T1.1 (genericize agent capability UI)
- **LOW — orphaned i18n key.** `agents.create.goalPlaceholder.personalAssistant`
  is now unreferenced after `resolveGoalPlaceholderKey` collapsed to
  trading/custom. Present in all three locales (parity-safe). Remove in a future
  i18n cleanup. (`apps/web/src/app/i18n/locales/{en,ar,hi}.ts`)
- **LOW — degenerate readiness edge.** In `AgentDetailPage.tsx`, if
  `hasAnyCapability` is true but the readiness response contains no entry
  matching a derived family (data mismatch / partial response), the capabilities
  block renders neither cards, empty-state, nor a loading row. Not reachable with
  the corrected backend (P2-10 now emits an entry per declared family). Optional
  hardening only.

### T2.2 (safe-standalone backend remediations)
- **LOW — dropped catalog `description`.** The genericized `GET /capabilities`
  no longer returns a per-family `description` (the old hardcoded trading entry
  had one). No current consumer depends on it; add a `families`-level
  description once skills carry capability-family display metadata.
  (`apps/api/src/routes/capabilities/index.ts`)
- **LOW/deferred — blueprint `momentum` default** (audit item 8,
  `apps/api/src/routes/blueprints.ts:448`). `GET /blueprints/defaults` still
  returns the trading `momentum` preset as the generic default. The audit rated
  it "mostly safe standalone" but it changes a default *payload*; deferred to a
  family-scoped-defaults follow-up (coordinate with the Phase-3-adjacent
  blueprint facet-schema work) rather than the reviewed-clean relabel slice.
- **LOW/out-of-scope — residual trading-worded 503s.** Audit scope relabelled
  the four GENERIC 503 messages (`agents.ts`, `blueprints.ts` ×2, `trading.ts`).
  Other "Trading service is unavailable"-style strings elsewhere (e.g.
  `bots.ts`, `dashboard.ts`) were surfaced as out-of-scope for T2.2 (not on the
  audit's safe-standalone list); sweep them in a later generic-copy pass or when
  those routes are family-shaped.
