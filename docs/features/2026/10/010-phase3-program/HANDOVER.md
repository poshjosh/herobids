# Phase 3 — Session handover

**Written:** 2026-10-03, at the end of session 1 (after T0.6).
**Read order for the next session:** this file → `ENTRYPOINT.md` → `TASKS.md`
(cursor + running notes) → `DECISIONS.md` §3–§4 → the plan for the current
block under `plans/`. You do not need to re-read the program docs, ADRs or the
Step 9 discovery end to end; the plans already distil them, and the cursor
tells you where you are.

## 1. Where things stand

| Repo | Branch | HEAD (end of session 1) | Tree |
|---|---|---|---|
| herobids `~/dev_ai/herobids` | `phase3-external-backend` | docs commit after `f495ab3d` (check `git log -3`) | clean |
| traderton `~/dev_ai/traderton` | `phase3-mcp-surface` | `d072b97` | clean |
| traderton-skills `~/dev_ai/traderton-skills` | `phase3-skill-publication` | `00963fc` (no commits yet) | clean |

Nothing has been pushed in any repo. Never push or merge to `main` (hard stop 1).

Done (✅ in TASKS): T0.1, T0.2 (G0 baseline — all five suites exit 0), T0.3
(signing vectors), T0.4 (descriptor conformance fixtures), T0.5 (local fixture
skill source), T0.6 (CF-1/CF-2 idempotency, IV-1).

## 2. First actions next session (in order)

1. **G3 check**: `env | grep TRADERTON_` empty; `grep TRADERTON_BOUNDARY_URL
   ~/dev_ai/herobids/.env` no match; `BOUNDARY_BASE_URL` unset.
2. **T0.6 round-2 review (owed).** Round 1 found a HIGH, which was fixed; the
   round-2 CodeReviewer pass was interrupted before it reported. Run a
   CodeReviewer on herobids commit `f495ab3d` (`git show f495ab3d`) with this
   focus: the `isLookupLevelAnswer` fix in `apps/worker/src/traderton/write-adapter.ts`
   (unknown outcome instead of rejection after the poll deadline), the poll body
   guards in `packages/domain/src/traderton/client.ts`, and the new fake controls
   `failNextExecution` / `stallNextCompletion`. Fix any CRITICAL/HIGH in a
   follow-up commit before starting T1.1. Park LOWs in TASKS §Outstanding Issues.
3. **Start T1.1** using `plans/block1-step11-plan.md` (commits C1–C5). Re-run its
   inventory greps first; Block 0 shifted line numbers.

## 3. Working loop (what worked; keep it)

Per task: Implementer (with the plan section + explicit "do not commit / do not
edit TASKS") → CodeReviewer on the uncommitted diff → fix CRITICAL/HIGH (and
cheap MEDIUMs) via Implementer or inline → focused tests + `pnpm build` +
`pnpm lint` + I7 grep → **commit traderton first, then herobids** (so the
herobids record can cite the traderton SHA) → a `docs(phase3): record T…`
commit updating TASKS (✅, cursor, running note with SHAs/counts, LOWs parked),
DECISIONS (next free **P3-9**), PROGRESS where a step changes state.

The `todo_list` tool loses state between calls in this environment — use the
TASKS cursor as the only tracker.

## 4. Facts that cost time to establish

- **`pnpm lint` type-checks nothing** in either repo (`files: []`); test files
  are in no tsconfig. `pnpm build` is the type gate (P3-2); type-check new test
  files ad hoc with a temp tsconfig in `/tmp` that extends the package tsconfig.
- **Vitest alias trap:** root `vitest.config.ts` aliases `@herobids/domain` and
  Vite prefix-matches. A value import of a subpath needs its own alias placed
  BEFORE the bare one (P3-8 added it; renamed to `/external-backend` at T1.1 C1).
- **Run tests from the herobids root** with `pnpm exec vitest run <paths>`;
  rebuild domain (`pnpm --filter @herobids/domain build`) before worker/api
  runs.
- **Mandated suites:** helper `~/dev_ai/herobids-traderton/phase3-logs/run-five.sh
  <label>` runs all five with the G3 check (`ONLY=tt-all,hb-all,…` to subset);
  logs land beside it. herobids `run-extra-tests.sh --all` Tier 6 contacts
  herobids staging read-only and sends a Telegram message — per P3-1 use
  `--skip-tier 6` for intermediate runs; full `--all` only at closeout G2 (E1 is
  an open operator question about this).
- **Host sleep** stretched the G0 herobids run to ~9 h wall-clock. Keep the
  machine awake (`caffeinate -dims`) for long suite runs.
- **MCP SDK** (Block 2): `@modelcontextprotocol/client@2.3.0` and `/server@2.3.0`
  (zod 4 nested, our code stays on zod 3). Every client POST body reaches a
  custom `fetch` as a string, so gate 1 looks likely to pass, but it must be
  proven by test (hard stop 3 if not). The Fastify adapter is unnecessary;
  use the web-standard stateless JSON transport inside a normal route. Details
  and the decisions to record are in `plans/block2-mcp-plan.md` (n19–n37, IV-2).
- **Fixtures:** signing vectors sha256 `1d4a04b8…20ef`; descriptor dir sha256
  `823ceb2b…0766`. Regenerating the descriptor fixtures changes the key and
  digest, so it is a contract change in both repos (SEAM §4).
- **T4.1 constraint:** each `SKILL.md` frontmatter `name` must be single-line
  and equal the ref's skill segment (`crypto-trading`, …).

## 5. What is left (TASKS order)

| Block | Tasks | Plan | Notes |
|---|---|---|---|
| 1 — Step 11 | T1.1 rename + definition schema (C1, C2); T1.2 seam + `RestTransport` (C3); T1.3 registry wiring + ctx ports (C4, C5) | `plans/block1-step11-plan.md` | Its P3-n numbers are placeholders — renumber from **P3-9**. After C4, run the herobids `run-all-tests.sh --e2e` once (rebuild the agent image: payload env renames). C3 moves T0.6's reconcile into the client. |
| 2 — Step 11b | T2.1 spike gate 1 (**hard stop if it fails**); T2.2 traderton MCP route + gate 2 (via traderton's own 008 decision process); T2.3 `McpTransport` + `['rest','mcp']` contract/parity suites + xstack leg | `plans/block2-mcp-plan.md` | Spike branches `phase3-mcp-spike` local only. Records IV-2 (deadline-derived attempt timeout). |
| 3 — Step 12 | T3.1 descriptor verification pipeline (flip the T0.4 `describe.skip`); T3.2 replace the hard-coded trading branches (I1 baseline: 2 literal hits / 39 broad); T3.3 Traderton definition + dev stub descriptor | **none yet** — run PlanCreator first (context-gatherer for the branch inventory) | Reason codes in the T0.4 manifest are normative (adopt as-is). |
| 4 — Step 13 | T4.1 three `SKILL.md` in traderton-skills; T4.2 dev-signed descriptor, gitignored private key, DELETE the stub (grep proof, I10); T4.3 verify via `LocalDirectorySkillInstaller` on both transports | **none yet** | Never use the live skills CLI; record real-remote resolution as deferred. |
| 5 — Closeout | T5.1 full DoD G0–G9 + `RECONCILIATION.md`; T5.2 carried-forward obligations (G9, blocking); T5.3 ESCALATIONS + PROGRESS + completion note under `docs/features/2026/10/` | — | The completion report must contain the G9 sentence verbatim (ENTRYPOINT §8). |

Open operator items so far: ESCALATIONS **E1** only (Tier 6 staging contact in
a mandated suite). Out of scope and parked: the pre-existing deprovision
over-dedup (MEDIUM, TASKS §Outstanding Issues).
