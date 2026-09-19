# Handoff Brief: hero-trade — Trading Extraction Completion Epic

*Purpose: bring an LLM agent with NO prior context up to speed on this workspace, the completed work, and the planned-but-unimplemented epic. Everything below is verifiable from the repo files cited. Read top to bottom, then read §3's documents in order.*

> **Status update (2026-09-19):** Track A and A8 are user-confirmed complete. B1, B2, B3, B5 item 2, and B6 are ratified as ADRs 010–014. Independent-review corrections are incorporated into C1a and C1–C5; do not implement until authorized and each plan's prerequisites are evidenced in `EXECUTION_LEDGER.md`. C1 profiles use `(ownerId, actorId, venueAccountId)` while direct execution preserves one selected binding per running agent. C5 reruns the full final test suite, A8, and the C3 UAT rows. B4 and the remaining B5/A9 batch are open. This update supersedes older "B1 open," "A1 first," and contingent-C-plan status below.

## 1. Workspace facts

- Workspace root `hero-trade` contains **two sibling git repos** (the root itself is NOT a git repo — never assume version control above them):
  - **`herobids`** — the consumer platform: generic AI agents with an LLM tick loop (`apps/worker`), REST API (`apps/api`), React web (`apps/web`). Branch `consume-traderton`. pnpm monorepo (`@herobids/domain`, `@herobids/db`, apps).
  - **`traderton`** — the trading authority: engine, risk gate, venue adapters, actors, and the REST boundary. Branch `l3-integration`. pnpm monorepo (`@traderton/*`).
- **Focused commits are allowed.** Commit completed logical slices and update the changelog when warranted. Do not commit secrets. **Do not merge herobids into `main` yet**; traderton remains subject to its own branch/merge rules.
- Architecture in one line: herobids' agent runtime calls trading via the **traderton REST boundary** (HMAC-signed `POST /internal/v1/tools:invoke`, per-tool Zod payload validation, idempotency store for writes); traderton owns execution, positions, fills, risk enforcement. Strategic goal: **herobids agents are generic agents consuming external trading capabilities** — trading semantics should not live in herobids long-term.

## 2. What has happened (do not redo)

- **2026-09-17, fixed in 3 phases** (committed by the user 2026-09-18 as herobids `c7294d98` / traderton `6cb07d6`): every agent `submit_decision` was rejected `precondition.not_ready "trading context unavailable"`.
  - **Phase 1**: traderton's `submit_decision` Zod schema didn't declare `venueAccountId` → the dispatcher's payload validation **stripped** the consumer's hint before subject resolution. Fix: declare the field (`trading.ts`).
  - **Phase 2**: the boundary never registered the agent-direct `AgentTradingActor` (its constructor had zero production callers). Fix: lazy construct+register+**start** in `bin.ts` → `buildAgentDirectActorEnsure`, cached per `(ownerId, actorId, venueAccountId)`.
  - **Phase 3**: actor capital never injected → `EquityTracker(0)` → daily-loss limit $0.00 → every decision rejected. Fix: herobids injects `capital`/`riskPosture`/`riskOverrides` into the signed `submit_decision` payload (post-LLM, from the `agents` row); traderton schema declares them; `subject-resolver.ts` extracts `agentRiskSpec`; the ensure consumes it and reconstructs the actor on capital/posture change.
  - Reports: `001-agent-trading-context-unavailable-decisions-rejected.md` + traderton companion `001-submit-decision-schema-strips-venue-account-id.md`. Live-verified end-to-end: decisions persisted, shadow fills + positions + journal produced (previously all zero).
- **2026-09-18, audit completed** (no code changed): `001-herobids-trading-logic-ownership-audit.md` — full inventory of trading/trading-adjacent code, data, config, UI remaining in herobids, with dependency diagram, LLM-coupling analysis, dormant-remnant register, 15 surprises. It is the **evidence base** for everything planned.
- **2026-09-18, epic drafted — nothing implemented**: `001-trading-extraction-completion`. Also filed (user-deferred): `docs/bug-reports/2026/09/18/001-gmail-oauth-return-lands-on-agents-list-not-create-form.md` (pre-existing UX bug, out of epic scope).

## 3. The epic — authoritative documents (read in this order)

All under `001-trading-extraction-completion`:

1. **`000-roadmap.md`** — current status, task index, review gate, and implementation order. It is the authoritative sequencing document.
2. **Historical Track A plans (completed; do not redo).** `plans/A1-ensure-cache-crash-recovery.md` records A1+A2, two defects in the shipped `buildAgentDirectActorEnsure` (traderton `bin.ts`):
   - **A1**: cache-hit fast path awaits the cached promise but never re-checks `runtime.actorRegistry.get(actorId)?.isRunning` → one actor crash (its `onCrashed` hook deregisters it) makes every later `submit_decision` fail `instance_not_running` **until process restart**.
   - **A2**: on a spec change, `ensureCache.delete` → async stop/reconstruct leaves a window where a concurrent invocation (LLM submits 2–3 decisions per tick) starts a second rebuild against a half-torn-down actor. Fix = single-flight cache-entry ordering.
3. **`plans/A3-boundary-risk-account-context.md`** — lost feature: traderton's `get_risk_limits`/`adjust_risk_limits` unconditionally require `ctx.riskContractOps`, but `bin.ts`'s context factory supplies none → both ALWAYS fail over the boundary (`"risk contract not available in this context"`); `get_account_summary.capital` reports null. Pre-loaded recommendation: **Option 1-1b** — assemble `riskContractOps`/`agentRepo`/`executionConfig` boundary-side from the already-crossing risk values (**source-agnostic seam** so the future profile store can replace the source); `adjust_risk_limits` fails typed until a durable store exists. Small decision pending user confirmation.
4. **`plans/A4-wire-resolver-default-ports.md`** — `bin.ts` resolver ports define neither `getDefaultOwnerMode` nor `getDefaultVenueAccountId` → every agent-direct actor starts at a `paper` mode ceiling. Recommendation: wire a static operator default now (documented transitional); per-agent mode rides the future B1 profile.
5. **`plans/A5-dormant-remnant-sweep.md`** — 17-item deletion table (dormant engine-era modules with live traderton counterparts, dead env/config, vestigial routes/repos). Four "check-first" items must be re-verified import-free before deletion.
6. **`plans/A6-fallback-posture.md`** — four transitional fallbacks (local-Redis `list_watches`, `resolve_watch`/`resolve_task` legacy stores, in-app exit-price reconstruction, in-process `get_risk_limits` read). Per-item options + recommendations; item 4 depends on A3's outcome.
7. **`plans/A8-stabilization-certification-gate.md`** — the definition of "current state pinned": two consecutive clean cross-stack runs (statics → xstack bring-up → live trade path → A-track regression checks → full boundary-tool invocation sweep → agent eval loop). The gate certifies; it does not repair — product-code findings file bug reports.
8. **`plans/C1a-profile-write-path-consolidation.md` + `plans/C1-trading-profile-slice.md` … `plans/C5-final-certification-gate.md`** — prepared execution plans. Read the independent review brief and `EXECUTION_LEDGER.md` before any implementation.
9. **`decisions/B1-stored-trading-state.md` … `B6-capability-agnostic-frontend.md`** — B1/B2/B3/B5.2/B6 are ratified; B4 and the remaining B5/A9 batch are open. ADRs 010–014 are the final decision records.

## 4. Governing constraints (from the user, standing)

1. **Review first**: Track A/A8 is complete and the independent-review corrections are incorporated. Do not implement C1a/C1–C5 before authorization and plan prerequisites are evidenced in the execution ledger.
2. **Plans ≠ implementation authorization.** Every task is fully drafted; implementation starts only when the user says so, in roadmap order (C1a first, then C1; C3a/C4 only when their ledger prerequisites permit). Track-A decision gates are historical and require no new implementation decision.
3. **Commits are allowed.** Keep them focused, update the changelog when warranted, and do not merge herobids into `main` yet.
4. Root `hero-trade/docs/` is unversioned — the epic lives in `herobids/docs/features/…` by decision; traderton-side work is tracked there by pointer but **authored in traderton** (its copy-never-author rules: never make traderton depend on herobids code).
5. Ownership line to preserve in all work: **traderton owns what traderton enforces** (execution, risk math, venue state); herobids owns the agent brain, UX, approvals lifecycle, capability/connection model.

## 5. Hard-won technical lessons (violating these causes real bugs)

- **Zod strips unknown keys.** ANY field the boundary reads from a tool payload (subject-resolver, context factory, actor ensure) MUST be declared in that tool's Zod schema (`traderton/packages/worker/src/tools/*`), or it is silently stripped pre-resolution. This was the entire phase-1 bug and recurs easily (phase 3 added `venueAccountId`+`capital`+`riskPosture`+`riskOverrides` to `submit_decision` for exactly this reason). When adding a payload field: check the schema AND every downstream consumer.
- **Per-package typecheck**: use `npx tsc --noEmit -p packages/<pkg>` (both repos). The root `pnpm lint` has a build-cache blind spot — it passed while Docker's `pnpm -r run build` failed (TS6133 unused / TS2663 missing-this). Always verify per-package before shipping.
- **Test-tier env**: run unit suites from a clean shell (`env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY …`) or leaked env vars make the "unit" tier hit the DB in parallel forks → 40P01 TRUNCATE deadlocks. Migrations run via the compose `migrate` service, never `pnpm migrate`.
- **Cross-stack harness**: `reset-and-run-xstack.sh` MUST be run from `herobids`; it tears down BOTH stacks with `-v` (data loss by design). Local agent ops: login `POST /auth/login` (no `/api` prefix) with `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env.ops.dev`; start an agent with `POST /agents/:id/start -d '{}'` (empty body + JSON content-type is rejected otherwise). First agent tick is force-escalated.
- **Boundary observability**: side-effecting tools persist rows in traderton `boundary_invocations`; **read-only tools bypass the store** — absence there does not mean "never called". The dispatcher logs swallowed context-factory errors internally (`precondition.not_ready` stays opaque over the wire by design).
- **Session-start discipline**: run `git status`/`git log` on BOTH repos before making any claim about repo state — the user commits/pushes between sessions.
- Search: prefer `rg` in the shell for verification-heavy greps.

## 6. Where things stand right now

- Repository branches and worktree state are deliberately not recorded here; run `git status` and `git log` in both repos before making a claim.
- **Immediate next steps:** implementation is not yet authorized. When authorized, create the first C1a ledger entry, record both repository SHAs, and follow the ledger/roadmap order. C3a and C4 may be independent only when their ledger prerequisites are met; C5 is the final gate. B4 and the remaining B5/A9 batch remain decision work.

*If any statement here conflicts with the roadmap or the user's in-chat instructions, those win — this file summarizes, they govern.*