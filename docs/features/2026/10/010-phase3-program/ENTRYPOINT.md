# Phase 3 Program — ENTRYPOINT (read this first, every session)

**Status:** living. **A fresh agent with no prior context starts HERE.**
**Created:** 2026-10-02
**Scope:** Phase 3 of the staging-first External Backend roadmap — Steps 11–13,
plus the transport seam, `McpTransport`, and a Traderton MCP server surface.

> You are an autonomous implementing agent. You will NOT have the context of the
> agent that wrote this. Everything you need is in this package plus the
> referenced docs. Read in this order: **ENTRYPOINT → TASKS → DECISIONS →
> INVARIANTS → SEAM**, then start at the first incomplete task in TASKS.
>
> **Do not pause between tasks.** The only reasons to stop are the three hard
> stops in §6. Everything else you decide with §5 and record.

## 0. Reading order & document map

| Doc | Role |
|---|---|
| `ENTRYPOINT.md` (this) | Objective, authority, invariants, autonomy contract, decision framework, Definition of Done |
| `TASKS.md` | The ordered, executable task list. Your live tracker, with a `Current cursor:` line at the top |
| `DECISIONS.md` | Phase-3 decisions already made (do not relitigate) + where you append new ones |
| `INVARIANTS.md` | The checkable invariants, each with the command that checks it |
| `SEAM.md` | Pointer to the normative contract + the fixture paths + the change rule |
| `ESCALATIONS.md` | Non-blocking batch for anything you genuinely cannot decide. Append, never pause |

Referenced (authoritative; do not duplicate — read them):
- **Program charter:** `../../09/24/000-program/ENTRYPOINT.md` — its §1 objective and §4 invariants GOVERN this program.
- **Program decisions:** `../../09/24/000-program/DECISIONS.md` — D1–D20. **D13–D20 were recorded for this phase; read them before any code.**
- **Program tracker:** `../../09/24/000-program/PROGRESS.md` — update Steps 11–13 as you go.
- **Roadmap:** `../../09/24/001-staging-first-external-backend-roadmap.md` — Phase 3 = Steps 9–16; this package covers 11–13.
- **The contract (normative):** `../../09/24/006-step10-external-backend-contract-and-trust-plan.md` — §1 definition, §2/§2.4/§2.5 client + seam + MCP mapping, §3 descriptor, §4 rotation, §5 frozen REST bytes, §6 failure behaviour, **§7 your ordered tasks**.
- **Discovery:** `../../09/24/005-step9-external-backend-genericization-discovery.md` — symbol dispositions, importer inventory, the hard-coded trading branches.
- **Architecture:** ADR 015 (`../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md`) and **ADR 016** (`../../../../tech/architecture/adrs/2026/10/016-mcp-as-external-backend-transport.md`, which supersedes ADR 015 §8).
- **Repo rules:** `herobids/AGENTS.md`, `traderton/AGENTS.md`, `herobids/docs/best-practices/README.md`.
- **Operational knowledge:** `.github/skills/external-backend-genericization/SKILL.md` (this phase) and `.github/skills/trading-boundary-ops/SKILL.md` (boundary observation).

## 1. Strategic objective (TOP — read before anything)

Separate trading from the agent platform so **herobids is a generic agent host**
and **Traderton owns the trading product**. Driven by a legal/payment-provider
requirement: **herobids must not be a trading application.** Engineering can
support that claim; it cannot alone decide whether a payment provider accepts it.

**Phase-3 objective:** herobids reaches External Backend tools **only** through a
generic, trust-gated path whose invocation transport is pluggable — with both
`RestTransport` and `McpTransport` implemented, REST remaining the default, and
no code anywhere in the generic path that recognises a specific backend.

**The test of success is not that the code says "trading" nowhere.** It is that a
second, unrelated backend could be registered with **zero platform code change**.
If trading is the only thing the mechanism ever serves, this is a monolith in two
repos with a renamed seam. Keep asking that question.

## 2. Phase 3 scope

In scope:
- **Step 0** — baseline capture + shared signing-vector fixtures + descriptor
  conformance fixtures + a local fixture skill source.
- **Step 0b** — the CF-1/CF-2 write-path idempotency fix (D18).
- **Step 11** — generic client migration + the internal transport seam.
- **Step 11b** — `McpTransport` + the Traderton MCP server surface (D14).
- **Step 12** — trust-gated deep integration; descriptor as sole schema authority.
- **Step 13** — Traderton skill publication, dev-signed.
- **Closeout** — reconciliation + carried-forward obligations + handback.

Out of scope (**attempting any of these is a failure of the run**):
- Steps 14, 15, 16 (D12) — including "just the easy part" of any of them.
- Any staging mutation, restart, redeploy, traffic exercise or rollback rehearsal.
- Any staging **confirmation**, including a "read-only" signed probe. See §7.
- `traderton/scripts/shell/tests/run-live-boundary.sh` — it **defaults to
  `https://api.staging.traderton.com`** when `BOUNDARY_BASE_URL` is unset and its
  suite invokes `submit_decision`. Never run it.
- Building metrics/instrumentation to satisfy a latency or throughput item. No
  metrics system exists; those items are **N/A, not pending**.
- Fixing pre-existing failures captured at baseline, including the known worker
  launch-latency bug behind `RUN_UNSTABLE_LLM_LATENCY_TESTS`.
- Any `git push` or merge to `main`, in any repo.

## 3. Cross-repository write authority (D20 — read before writing in any repo)

Phase 3 spans four repos. Your authority is **identical in the three that are in
scope**: author and commit freely on a branch; **never push, never merge to
`main`**.

| Repo | Local path | Authority | Branch | Push |
|---|---|---|---|---|
| herobids | `~/dev_ai/herobids/` | Full, in scope | `phase3-external-backend` | 🚫 HARD STOP |
| traderton | `~/dev_ai/traderton/` | Full, in scope (MCP route over the existing dispatcher) | `phase3-mcp-surface` | 🚫 HARD STOP |
| traderton-skills | `~/dev_ai/traderton-skills/` | Full, in scope (Step 13: 3 × `SKILL.md` + descriptor) | `phase3-skill-publication` | 🚫 HARD STOP |
| openaidom-skills | `~/dev_ai/openaidom-skills/` | **None this phase.** Read-only | — | 🚫 |

### Before the first write in a repo that is not herobids
1. Confirm it exists and `git status` is clean. **If dirty, stop and report** —
   do not commit on top of someone else's uncommitted work.
2. Read that repo's own `AGENTS.md` and author to **its** conventions.
3. For traderton also read `docs/features/initial/CANONICAL-STATE.md` and
   `docs/features/initial/008-decision-process.md`. (The program ENTRYPOINT once
   cited these at `docs/CANONICAL-STATE.md` and `.../8-decision-process.md`; both
   were wrong. The paths here are correct.)
4. Create and check out the branch named above. **Commit there, not on local
   `main`** — branch commits are the reversibility net (traderton
   `008-decision-process.md` §6.2); undoing a local-`main` commit needs
   `git reset --hard`, which you may not run.

### Why push is a hard stop — per repo, so you don't reason your way around it
- **traderton:** `.github/workflows/build-push.yml` fires on
  `push: branches:[main]` and publishes `ghcr.io/poshjosh/traderton:sha-<sha>`
  plus `:latest` for the boundary AND site images. A push republishes a moving
  alias in a shared registry → **infrastructure mutation**, not just
  main-branch discipline.
- **traderton-skills:** no CI, but herobids resolves external skills **live and
  unpinned at runtime** — `apps/worker/src/tools/skills.ts:37` spawns
  `npx skills add <ref> --yes`, and `normalizeExternalRef` turns the D11 ref
  `traderton/skills/crypto-trading` into `traderton/skills@crypto-trading`. A
  push changes agent-facing instruction content for every subsequent install,
  with no pinned prior version to roll back to → **infrastructure mutation**.
- **herobids:** `main` is ahead of `origin/main` by design. Standing no-push rule.

**"It's only documentation" / "it's only instruction text" is NOT an exemption.
The gate is on the push, not on the content.**

### Signing keys (Step 13)
No ed25519 key material exists in any repo (verified).
- **Dev keypair: generate it yourself.** Ephemeral local scaffolding, autonomous.
  Gitignore the private key — never commit it. Mark the committed descriptor
  clearly as dev-signed.
- **Real staging/production key: operator-held.** Registering a real public key
  into an operator-managed definition is an infrastructure mutation → prepare it,
  document it, request approval, do not execute.
- **Step 13 is NOT blocked by this.** It completes with the dev key + the gate.

### Step 13 verification — do NOT use the live skills CLI
Your `traderton-skills` work stays local, and `npx skills add` resolves from the
**remote**, so it cannot see your work. Satisfy Step 10 §7 task 17 against the
**local fixture skill source** built in Step 0d, plus the descriptor-trust path.
Record real-remote resolution as deferred to the post-push operator step. **Do
not report a green you did not get, and do not push to make a test pass.**

## 4. Invariants / governing law (inherited — do not break)

All invariants in `../../09/24/000-program/ENTRYPOINT.md §4` apply. `INVARIANTS.md`
in this folder turns the Phase-3-relevant ones into assertions with commands.
The ones that bite hardest here:

1. **No infrastructure mutation without explicit operator approval.** Purely
   local, ephemeral dev/test scaffolding (a local `docker compose up`, a
   throwaway test container, a dev keypair) remains autonomous.
2. **Ownership boundary.** No `if` branch in generic registration, dispatch or
   visibility code may recognise a specific backend identity (ADR 015 §5).
3. **No backward-compatibility obligation** (greenfield). Prefer clean removal
   over shims. But do not break the deployed herobids↔Traderton contract without
   a lockstep change on both sides.
4. **Branch commits, zero pushes, all repos** (§3, D20).
5. **Parity, not liveness.** Nothing changes trading behaviour without a
   recorded Gap/Deferred/Intentional-divergence note. The CF-1 fix (Step 0b) is a
   deliberate, recorded behaviour change authorised by D18 — record it as such.
6. **The REST invocation bytes are frozen** (Step 10 §5). `McpTransport` REUSES
   `buildCanonicalString` and the header set; it does not refactor them. **If a
   change to `sign.ts` looks necessary for MCP's benefit, STOP and re-open
   ADR 016.**
7. **The verified descriptor is the sole authority for tool schemas** (D16).

## 5. Autonomy contract + decision framework

**Default: act.** You MAY, without asking: read anything; run read-only
investigation, builds, lint and the local test suites; stand up and tear down
local containers; generate plans; spawn sub-agents; make and commit (on a branch)
any reversible in-scope engineering change; update TASKS/DECISIONS/ESCALATIONS.

Per task run: **read ENTRYPOINT → read TASKS → prepare (investigate ⇄ plan) →
[decision checkpoint] → implement → verify → record (TASKS + DECISIONS +
PROGRESS)**. If a task has no written plan and is more than mechanical, author
one first — that is always permitted.

### 5.1 Decision routing (program ENTRYPOINT §6, as revised 2026-10-02)

Route to a fresh **Contemplator** only when a choice is **both**
architecturally significant **and** genuinely contested — meaning you cannot
state the decisive reason in one sentence. If you CAN name the deciding argument
plainly and it survives a check against §4, **decide it, record it, move on**.

**Detail is not complexity.** A decision with many downstream mechanics but one
clear deciding reason is yours to make; write the mechanics into the record. A
brief that takes longer to write than the decision takes to make is a signal you
have already decided.

Use the handoff protocol in `../../09/24/000-program/DECISIONS.md` when you do
route. Record every ruling in this folder's `DECISIONS.md`.

### 5.2 The stuck rule (do not grind)

After **two** failed attempts at the same approach: stop tweaking. Write the
diagnosis into the TASKS running notes, then either switch to a materially
different approach or mark the task 🚫 and move to the next independent task.
Never loop on the same fix. An authorization boundary never blocks progress —
record it as a carried-forward obligation and continue.

### 5.3 Escalation without pausing

If something genuinely needs the operator, append it to `ESCALATIONS.md` with
(a) what it is + file:line, (b) the options, (c) your engineering recommendation,
(d) why it needs operator input — then **keep working on everything else**. The
operator resolves the batch at the end.

## 6. The THREE hard stops (the only reasons to wait)

1. **Any `git push` or merge to `main`, in any repo** (§3).
2. **Infrastructure mutation** — Terraform, deploy, DNS/TLS, secrets, registry
   publication, live-traffic exercises, real signing-key registration.
3. **MCP spike gate 1 failing** — if `params._meta` is not inside the request
   bytes the client signs, the signature cannot cover the envelope and the D15
   mapping is invalid. **Stop and re-open ADR 016**; do not work around it.

Nothing else is a hard stop.

## 7. Why there is no staging check in this phase

Staging **is** reachable from the working environment (DNS resolves, SSH works),
so this is a prohibition on merit, not an omission:

1. **Epistemically empty.** Staging runs pre-Phase-3 refs (traderton `41d9c2c1`,
   herobids `a5f403cf`). A probe measures code this run did not write and
   manufactures a false impression of cutover readiness.
2. **Not purely read-only.** The documented probe pattern requires reading live
   HMAC secrets from a running container and `docker cp`-ing a file onto an
   operator-managed host. Writing to that host is a mutation, not observation.
3. **Redundant.** The baseline read-path check is already recorded as passing.

What you have instead is stronger than it sounds: `herobids/scripts/shell/tests/
run-all-tests.sh` calls `ensure_boundary_up` unconditionally and brings up the
real traderton stack at `localhost:8080`, so the local suite exercises **real
HMAC over real HTTP into a real Postgres-backed boundary** — not a mock.

## 8. Definition of Done

Done when all nine gates pass, and not before. **"Done" means LOCALLY VERIFIED.
It does NOT mean cutover-ready.** G9 exists to prevent that misreading.

**G0 — Baseline captured** before any edit: HEAD + `git status --short` +
`pnpm lint` exit code + the five mandated scripts' exit codes, for all three
repos. A gate already failing at baseline is a **pre-existing condition** —
record it, do not fix it, do not block on it. Only regressions against G0 are
yours.

**G1 — Static gates.** `pnpm lint` exits 0 in BOTH repos; `pnpm build` succeeds
in BOTH; no `any`, `@ts-ignore` or `as unknown as X` introduced.

**G2 — The five mandated suites**, at their DEFAULT gates, all exit 0:
```
traderton/scripts/shell/tests/run-all-tests.sh --e2e
traderton/scripts/shell/tests/run-extra-tests.sh --all
traderton/scripts/shell/tests/run-integration.sh
herobids/scripts/shell/tests/run-all-tests.sh --e2e
herobids/scripts/shell/tests/run-extra-tests.sh --all
```
Do **not** set `RUN_UNSTABLE_LLM_LATENCY_TESTS=1`. Flipping that gate is not
permitted; the bug behind it is out of scope.

**G3 — Local-boundary assertion**, run BEFORE G2 every time: `env | grep
TRADERTON_` returns nothing, no `TRADERTON_BOUNDARY_URL` in herobids `.env`, and
`BOUNDARY_BASE_URL` unset. If any is set, **STOP and report** — do not run a
staging-pointed suite.

**G4 — Step exit criteria** per Step 10 §7 (Steps 0, 0b, 11, 11b, 12, 13),
including: the shared signing vectors pass in both repos with matching fixture
digests; `sign.test.ts` passes UNMODIFIED after the rename; the Step-12 stub
descriptor is DELETED (proven by grep).

**G5 — Transport-risk characterisation**, on BOTH transports: same idempotency
key twice → exactly one durable side effect; same key + changed payload →
`validation.invalid_payload`, no second effect; response-lost-after-execution →
reconcilable; outage and recovery → typed fail-closed, no crash, no hang; error
mapping preserves code + retryable verbatim.

**G6 — The seam does not leak.** Nothing above the seam imports a
transport-specific symbol; the seam interface is not exported from the package
subpath; `requestId` and `idempotencyKey` are first-class seam inputs on both
transports.

**G7 — Contract tests parameterised** over `['rest','mcp']` pass on both. A test
that passes on only one transport means something leaked below the seam.

**G8 — Genericity.** `INVARIANTS.md` all green, including: no backend-identity
`if` branch in generic code, and the written answer to "could a second,
unrelated backend register with zero platform code change?"

**G9 — Carried-forward obligations recorded (BLOCKING).** Every carried item is
written into this folder's `DECISIONS.md`, the program `PROGRESS.md`, and the
Step-16 obligation list, each with its evidence path. The completion report MUST
contain this sentence verbatim:

> "Phase 3 Steps 11–13 are locally verified. The write path has NOT been proven
> against the live Traderton boundary. No differential against the pinned oracle,
> no load evidence, and no staging confirmation were produced. This run does not
> establish cutover readiness."

## 9. Sub-agents / skills

- **Contemplator** — contested judgment calls (§5.1). Produces a ruling.
- **PlanCreator** — a concrete plan before any multi-file or behaviour-changing task.
- **Implementer** — execute an approved plan.
- **BugFixer** — defects surfaced by verification.
- **Tester / UnitTester** — tests for changed behaviour.
- **CodeReviewer / Reworker** — review and rework until only LOW issues remain.
- **VisualTester** — not expected this phase (no UI work).
- **context-gatherer** — bulk codebase investigation; prefer it over serial reads.

**Fallback:** if a named agent is unavailable in your environment, perform that
role **inline**. The loop and quality bar are unchanged; only the delegation
differs.

**Context budget:** Phase 3 is larger than Phase 2 in files touched. Delegate
heavy investigation and bulk edits to sub-agents **specifically to preserve your
own context** so you can finish in one run. Keep the orchestration state
(TASKS/DECISIONS/ESCALATIONS cursor) in your own context; push deep file-reading
and large edits out.

## 10. Recording discipline (your only audit surface)

With write authority in three repos and zero pushes, the operator's only view is
three local working trees. **Per task**, record in `TASKS.md`: repo + branch +
commit SHA, which sub-agent did what, what was verified and with what counts, and
anything gated. Update the `Current cursor:` line after **every** task. Do not
make the operator go spelunking.
