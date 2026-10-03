# Phase 3 Program — TASKS (ordered, executable)

**Status:** live tracker. **Read `ENTRYPOINT.md` first, then work this list.**
**Do not pause between tasks.** Only the three hard stops in ENTRYPOINT §6 stop you.

**Current cursor:** **T2.3** (`McpTransport` on herobids + contract suites over `['rest','mcp']` + xstack leg) — T2.1 gate 1 ✅, T2.2 traderton MCP surface ✅ (`6fc1099`,`e781a4b`,`dfda5eb`,`5ea82f9`). ←
*Update this line to the task you are on after every task.*

### Status scheme (use the emoji, NOT a checkbox)

- ⬜ not started · 🔄 in progress · ✅ done · 🚫 blocked (hard stop, ENTRYPOINT §6) ·
  ⤴ escalated (row in `ESCALATIONS.md`; **CONTINUE other work**)

Per task: **Goal · Inputs · Agent · Exit criteria · Record.** Every task ends
with: relevant tests + `pnpm lint` green, a **branch** commit (never `main`,
never pushed), and an update to this file (status + cursor + running notes),
`DECISIONS.md`, and the program `PROGRESS.md` where a step changes state.

### Dependencies & parallelism

**Genuine gates (do not reorder these):**
- **T0.3 → T1.x.** The shared signing vectors must be captured against
  **pre-rename** code. Captured after the rename they pin post-rename bytes and
  prove nothing about the rename.
- **T0.6 → T1.x.** The CF-1 fix lands on current names and gets renamed with
  everything else. Folding it into T1 destroys T1's "no behaviour change"
  verification, which is the thing that makes the rename safe.
- **T2.1 (spike gate 1) → T2.2/T2.3.** A failing gate 1 is a hard stop, not a
  workaround point.
- **T2.2 (backend MCP surface) → T2.3 (`McpTransport`).** The client needs a
  counterparty.
- **T3.x → T4.x.** Step 13 replaces the Step-12 stub.
- **T0.5 (fixture skill source) → T4.3.** Step 13 cannot verify via the live CLI.

**Parallelisable:** T0.3 / T0.4 / T0.5 are independent of each other. T2.2
(traderton repo) is independent of T1.x (herobids) once the seam contract in
`SEAM.md` is fixed.

---

## Block 0 — Orientation, baseline, fixtures

- ✅ **T0.1 Load context.** Read, in order: this package's `ENTRYPOINT`, `TASKS`,
  `DECISIONS`, `INVARIANTS`, `SEAM`, `ESCALATIONS`; the program
  `ENTRYPOINT`/`DECISIONS` (**D13–D20 especially**)/`PROGRESS`; **ADR 016** then
  ADR 015; the **Step 10 plan** (the normative contract — §1, §2, §2.4, §2.5, §3,
  §5, §7); the Step 9 discovery; `.github/skills/external-backend-genericization/SKILL.md`.
  - Exit: you can restate, without re-reading — the objective, the three hard
    stops, the branch/push rule per repo, which document is normative for the
    seam, and why T0.3 and T0.6 precede T1.
- ✅ **T0.2 Confirm repo state + capture baseline (G0).** For herobids, traderton
  and traderton-skills: `git rev-parse HEAD`, `git status --short`, `pnpm lint`
  exit code, and the five mandated scripts' exit codes. Create the three branches
  (ENTRYPOINT §3). **If a repo's tree is dirty, stop and report** rather than
  committing on top of it.
  - Exit: baseline table in the running notes below. Pre-existing failures named
    and explicitly excluded from this run's scope.
  - Note: run **G3** (local-boundary assertion) before the suites, every time.
- ✅ **T0.3 Shared signing vectors — against PRE-RENAME code.** Create
  `invocation-signing-vectors.json` in both herobids and traderton: POST invoke;
  GET status with empty body; a path with a query string (must be stripped);
  non-ASCII body. Each case records the expected canonical string and
  `sha256=<hex>`. herobids asserts its signer emits those bytes; traderton
  asserts its verifier accepts them and rejects a one-byte mutation. **Both
  assert a SHA256 digest of the fixture file itself**, recorded in `SEAM.md`, so a
  one-sided edit also fails.
  - Why: `herobids/packages/domain/src/traderton/sign.test.ts:28-36` hand-
    replicates the traderton verifier inline and claims "if it verifies against
    this replica, it verifies against the real `authenticateRequest`". That claim
    is **unfalsifiable from inside herobids** — if traderton's `auth.ts` changes,
    the herobids test still passes. These vectors replace it as the real guard.
  - Exit: vectors green in both repos; digests recorded in `SEAM.md`; the old
    replica comment annotated or removed.
- ✅ **T0.4 Descriptor conformance fixtures.** One signed descriptor plus tampered
  variants: bad signature, wrong `backendId`, expired `expiresAt`, unapproved
  `ref`, unknown `keyId`, pin mismatch. Each must degrade to instruction-only
  (Step 10 DT3).
  - Exit: fixtures exist in both repos; the herobids-side assertions are written
    (they go green in T3.x when the verification pipeline exists).
- ✅ **T0.5 Local fixture external-skill source.** A local source the resolution
  path can install from, so Step 13 can be verified without `npx skills add`
  (D20 — the live CLI resolves from the remote and cannot see local work).
  - Exit: a skill can be installed from the fixture source end-to-end in a test.

## Block 0b — CF-1 / CF-2: write-path idempotency (D18)

> **This is a deliberate, recorded behaviour change** authorised by D18. Record it
> as an Intentional-divergence note under the parity-not-liveness invariant.

- ✅ **T0.6 Thread a stable idempotency key + requestId.**
  `packages/domain/src/traderton/client.ts:169-171` defaults `requestId`,
  `idempotencyKey` and `correlationId` to `randomUUID()`, and **no non-test call
  site supplies either** of the first two — verified across `risk-limits.ts:131`,
  `watch.ts:96/155/201`, `agent.ts:949`, `agent-decision-handler.ts:530`,
  `agent-message-broker.ts:529`, `index.ts:959`, `approval-service.ts:119`. The
  backend's `replay` branch is therefore unreachable, so a caller-level retry of a
  write can duplicate a side effect. A stable key already exists in
  `payload.decisionId`; `apps/worker/src/traderton/write-adapter.ts:71-72,84-85`
  already plumbs both fields through.
  - Also: persist `requestId` long enough that a response lost after execution is
    reconcilable (CF-2).
  - **D15's `in_progress` resolution depends on this** — re-issuing `tools/call`
    with the same key is how the MCP path resolves a running invocation.
  - Agent: PlanCreator → Implementer → UnitTester → CodeReviewer/Reworker.
  - Exit: characterisation tests green — same key twice → exactly ONE durable
    side effect; same key + changed payload → `validation.invalid_payload`, no
    second effect; timeout-after-execution → reconcilable. The backend legs of the
    first two are already covered by its `app.test.ts` and boundary verification
    suite — **confirm still green rather than duplicating.**
  - Record: the divergence note, and which call sites now supply which key.

## Block 1 — Step 11: generic client migration + transport seam

- ✅ **T1.1 Rename + registry.** Rename `packages/domain/src/traderton/` and its
  subpath export → `external-backend` (`@herobids/domain/external-backend`);
  apply the Step 10 §2 symbol table. Add `ExternalBackendDefinition` + Zod schema;
  add the `appConfig.externalBackends[]` registry with the single `traderton`
  entry derived from today's `boundary` block + env, including
  `endpoint.protocol` (default `'rest'`), `toolProtocolOverrides` and `mcpPath`.
  **Update the matching `.env.example` twin for any new env key** (repo rule).
  - **Preserve `sign.ts` bytes** (Step 10 §5). Acceptance: the T0.3 vectors AND
    `sign.test.ts` pass **unmodified**.
  - Exit: `pnpm lint` + api/worker tests + full build green.
- ✅ **T1.2 Extract the transport seam** per Step 10 §2.4, with `RestTransport`
  as the first implementation. Seam interface **internal to the package — not
  exported**. `requestId` and `idempotencyKey` are first-class seam inputs.
  Orchestration (envelope, idempotency, deadline, health gating, retry,
  audit/correlation, result mapping) stays above it.
  - Exit: `INVARIANTS.md` seam checks green; no behaviour change.
- ✅ **T1.3 Rewire call sites + importers.** The **6** construction sites across
  **3** files — `apps/worker/src/index.ts:440,468,502,794`,
  `apps/worker/src/agent.ts:938`, `apps/api/src/index.ts:198` — become registry
  lookups by `backendId`. Rewire the ~32 type-level importers. Rename ctx ports
  `tradertonBoundary`→`externalBackend`, `tradertonWriteBoundary`→
  `externalBackendWrite`.
  - Note: Step 9 Crit 2A and Step 10 §1/§7 originally said 5 sites and listed
    `apps/api/src/routes/exports.ts` — **line 348 there is a COMMENT**, not a
    construction. Corrected in the Step 10 plan §1.
  - Exit: lint + both builds + api/worker tests green. **No behaviour change
    expected** (rename + config reshape + a one-implementation seam). T0.6's
    change is already in and already verified, so this assertion stays meaningful.

## Block 2 — Step 11b: `McpTransport` + the backend MCP surface (D14)

- ✅ **T2.1 Spike gate 1 — `params._meta` inside the signed bytes. HARD STOP if
  it fails.** On a throwaway branch: stand up a low-level MCP `Server` on
  traderton's existing app; connect a herobids client whose transport `fetch` is
  wrapped with a middleware calling the existing signing logic over the outgoing
  body. Assert that **`initialize`, any SDK-originated notification, AND
  `tools/call`** all pass the backend's `authenticateRequest`, and that
  `params._meta` is inside the hashed bytes.
  - If any SDK-originated frame cannot be signed, or `_meta` is not in the signed
    body: **STOP, record it, re-open ADR 016.** Do not work around it.
  - Also assert here: `pnpm lint` clean with **zero** escape hatches (grep the
    diff for `any`, `@ts-ignore`, `as unknown as`), and `pnpm why zod` shows our
    code still on a single zod version.
- ✅ **T2.2 Spike gate 2 + the backend MCP surface** (traderton repo, branch
  `phase3-mcp-surface`, traderton's own conventions). Mount an MCP route on the
  existing boundary app over the existing `ToolInvocationDispatcher` (whose
  public surface is exactly `dispatch(body, pathMajor)` and `status(requestId)`).
  Low-level `Server` (D17) with `tools/list` served **verbatim from the signed
  descriptor** (D16); `tools/call` **returning** `isError: true` with the failure
  envelope in `structuredContent` (never throwing — a thrown error becomes a
  JSON-RPC protocol error and the closed failure-code union is lost); `_meta`
  header↔body assertions; **reuse** the shared `buildCanonicalString`.
  - **Gate 2 (coexistence):** the frozen REST route, its `addContentTypeParser`
    raw-body retention, and the existing `app.test.ts` +
    `boundary.verification.integration.test.ts` all pass **UNMODIFIED**.
  - Exit: both traderton suites green; REST bytes untouched.
- ⬜ **T2.3 `McpTransport`** (herobids). *(From T1.2: register `mcp` in `transports/select-transport.ts` — the only file that names a transport; decide P3-25 (deadline-derived attempt timeout); `poll(requestId)` returns `precondition.not_ready` on a transport without `lookupStatus`; strengthen `select-transport.test.ts` override test once two transports exist; decide whether a lost re-issue inside the no-lookup loop should keep re-issuing until the deadline.)* Behind the seam. HMAC via the client
  transport's `fetch` middleware. **Per-call timeout driven from the envelope's
  `deadlineAt`** — the SDK client defaults to 60s, which would silently override
  the contract's deadline semantics. `in_progress` resolved by re-issuing
  `tools/call` with the same `idempotencyKey` (no status endpoint on this path).
  Tasks extension NOT adopted.
  - Exit: contract tests **parameterised over `['rest','mcp']` pass on both**;
    the T0.6 characterisation tests pass on both; `protocol` stays `'rest'`
    outside dev/test (D19).

## Block 3 — Step 12: trust-gated deep integration

- ⬜ **T3.1 Descriptor type + verification pipeline.** Implement Step 10 §3 in
  domain: ed25519 verification against `trustedDescriptorSigningKeys`, pinning,
  expiry, `backendId` match, revocation. Failure → instruction-only (DT3).
  - Exit: the T0.4 conformance fixtures all go green.
- ⬜ **T3.2 Replace the hard-coded trading branches.** The resolution path that
  today hard-codes trading: `skills.ts`, `provider-catalog.ts`,
  `agent-runtime-descriptor.ts`, worker `agent.ts:473`,
  `runtime-composition.ts:700`, `agent-capabilities.ts:18`. New rule: *skill ref
  matches an enabled definition + verified descriptor → expose descriptor tools;
  else instruction-only* (ADR 015 §5 — **no `if (trading)`**).
  - **D16/DT4:** tool `name`, `description`, `inputSchema`, `category` come from
    the verified descriptor and nowhere else. A `tools/list` response is
    cross-checked or ignored; disagreement is a trust failure → DT3. The
    descriptor's `tools[]` already maps 1:1 onto `ToolDefinition` at
    `packages/domain/src/trading/tool-contract.ts:335`, consumed by
    `packages/llm/src/llm-provider.ts:51`.
  - Agent: context-gatherer for the branch inventory → PlanCreator → Implementer
    → Tester → CodeReviewer/Reworker.
  - Exit: trading tools resolve for an agent whose skills include the D11 refs; a
    non-matching external skill gets NO tools; revocation strips tools; expiry /
    untrusted key / `backendId` mismatch each degrade without crashing a session.
- ⬜ **T3.3 Register the Traderton definition + a dev-signed stub descriptor** so
  the generic path works locally. **The stub is temporary and T4.2 must delete it.**
  - Exit: lint + builds + tests green; `INVARIANTS.md` genericity checks green.

## Block 4 — Step 13: Traderton skill publication

- ⬜ **T4.1 Author the three `SKILL.md`** in `~/dev_ai/traderton-skills/` (branch
  `phase3-skill-publication`): `crypto-trading`, `crypto-bot-management`,
  `crypto-risk-monitoring` (frontmatter `name` + `description`; body = the
  backend-owned instructions, derived from the herobids seeds `TRADING_SKILL` /
  `BOT_MANAGEMENT_SKILL` / `RISK_MONITORING_SKILL` as source of truth). Follow
  the skill-authoring guide.
  - Exit: three skills authored; branch commit; **no push**.
- ⬜ **T4.2 Produce the real (dev-signed) descriptor and DELETE the stub.**
  Generate a dev ed25519 keypair locally, **gitignore the private key**, mark the
  descriptor clearly as dev-signed. Bind the three refs → tool
  schemas/instructions. Wire `trustedDescriptorSigningKeys` +
  `approvedSourceSkillRefs` (D11).
  - **Exit: grep proves ZERO references to the T3.3 stub remain.** A run that
    leaves the stub in place is not done.
  - Gated and NOT attempted: registering a real operator-held public key.
- ⬜ **T4.3 Verify against the LOCAL FIXTURE source (T0.5), not the live CLI.**
  herobids resolves external skills live and unpinned at runtime
  (`apps/worker/src/tools/skills.ts:37`; `normalizeExternalRef` maps the D11 ref
  to `traderton/skills@crypto-trading`), so the real CLI cannot see local work.
  - Exit: install → descriptor resolution → tool visibility → invocation →
    result mapping, end to end through the generic path on the fixture source,
    **on both transports**. Real-remote resolution recorded as deferred to the
    post-push operator step. **Do not report a green you did not get, and do not
    push to make a test pass.**

## Block 5 — Closeout

- ⬜ **T5.1 Run the full Definition of Done** (ENTRYPOINT §8, G0–G9). Write a
  `RECONCILIATION.md` in this folder mapping every Step-10 §7 task and every
  Step-9 discovery disposition to exactly one outcome: ✅ done / 🕓
  deferred-with-note / ⤴ escalated / 🧱 out-of-scope. **No item unclassified.**
- ⬜ **T5.2 Record carried-forward obligations (G9, BLOCKING).** Into this
  folder's `DECISIONS.md`, the program `PROGRESS.md`, and the Step-16 obligation
  list, each with its evidence path. Minimum set: the REST differential against
  the pinned oracle (D10); representative load; no metrics system exists (so
  latency/throughput items are **N/A, not pending**); staging restart /
  health-visibility / idempotent-retry-on-writes / rollback; the absent rollback
  path; the push gate; the real signing key; the open legal/product dispositions;
  and the **conditional third differential leg** if an MCP transport is reachable
  when Step 16 is planned.
- ⬜ **T5.3 Finalise `ESCALATIONS.md`** as the single operator batch, and update
  the program `PROGRESS.md` Steps 11–13. Write a short completion note under
  `docs/features/2026/10/`.
  - Exit: Definition of Done met; the G9 verbatim sentence present in the
    completion report.

---

## Baseline (fill at T0.2)

Captured 2026-10-02 23:41 → 2026-10-03 09:08 (local), before any edit. G3 asserted
before each suite (`env | grep TRADERTON_` empty; no `TRADERTON_BOUNDARY_URL` in
herobids `.env`; `BOUNDARY_BASE_URL` unset). Logs (outside the repos):
`~/dev_ai/herobids-traderton/phase3-logs/g0-*.log`, runner `run-five.sh`.

| Repo | HEAD | Tree | `pnpm lint` | Mandated suites |
|---|---|---|---|---|
| herobids | `8d30dd46` (= `origin/main`) | clean | 0 | `run-all-tests.sh --e2e` **0** (vitest 6384 passed / 325 skipped; all 9 tiers PASS incl. Playwright 16/16) · `run-extra-tests.sh --all` **0** (16 PASS, 3 SKIP = the `RUN_UNSTABLE_LLM_LATENCY_TESTS` trio) |
| traderton | `84c37210` (= `origin/main`) | clean | 0 | `run-all-tests.sh --e2e` **0** (2716 passed / 61 skipped; boundary-e2e 7/7) · `run-extra-tests.sh --all` **0** (3 executed) · `run-integration.sh` **0** (14 passed / 1 skipped) |
| traderton-skills | `00963fc2` (= `origin/main`) | clean | n/a (no package.json) | n/a |

Branches created from those HEADs: herobids `phase3-external-backend`, traderton
`phase3-mcp-surface`, traderton-skills `phase3-skill-publication`.

Pre-existing failures excluded from this run's scope: **none failing.** Known
pre-existing *skips*: the three Tier-5 tests behind `RUN_UNSTABLE_LLM_LATENCY_TESTS`
(bug 2026-09-05/001, CF-12); traderton `boundary-invocations.integration.test.ts`
and other DB-gated integration files skip in `run-all-tests.sh` (no `DATABASE_URL`).
The herobids `run-all-tests.sh` wall-clock (23:43 → 09:01) includes host sleep
(`pmset` log; a ~9.2 h gap inside the log) — not a test-duration signal.

Invariant baselines (INVARIANTS.md):

| Inv | Baseline |
|---|---|
| I1 | literal grep: **2** hits (`agent-runtime-descriptor.ts:82`, `agent.ts:473`). Broader inventory (`'trading'`/`'traderton'` string literals in the six files): **39** — T3.2's work list |
| I2, I3, I5, I6 | N/A — no `external-backend/` module yet; `Transport` in `packages/domain/package.json`: 0 |
| I4 | `sign.test.ts` green (part of the unit tier) |
| I7 | 0 (no branch diff) |
| I8 | clear |
| I9 | all three repos on their `phase3-*` branch; 0 commits ahead of `origin/main` |
| I10 | 0 (N/A until T4.2) |
| I11 | `apps/worker/src/env-example-drift.test.ts` green (unit tier) — used as the I11 check; the literal `rg` pair in INVARIANTS is not line-number-safe |

---

## Running notes / handoff (append as you work)

*Per task: repo + branch + commit SHA · which sub-agent did what · what was
verified and with what counts · anything gated. This is the operator's only
audit surface — three local working trees with no pushes.*

**T0.1 / T0.2 (herobids `phase3-external-backend`, docs commit below).**
Coordinator read the package + program docs, ADR 016/015, Step 9/10, the skill.
Baseline table above. PlanCreator sub-agents wrote working plans for Block 0,
T0.6, Block 1 and Block 2 (copied into `plans/` in this folder; plans are
working documents — the commits and these notes are the record). Findings from
planning that later tasks depend on:
- `pnpm lint` (`tsc --noEmit` on a `files: []` solution tsconfig) appears to
  type-check no inputs in either repo, and `*.test.ts` are excluded from every
  tsconfig. **`pnpm build` is treated as the real type gate**; I7's grep covers
  test files. Parked as an Outstanding Issue (not fixed: out of scope).
- Root `vitest.config.ts` aliases `@herobids/domain` → `src/index.ts`; Vite
  prefix-matches, so a VALUE import of `@herobids/domain/<subpath>` in a test
  resolves to a non-existent file. Works today only because every such import is
  `import type`. Fixed (and recorded in DECISIONS) where a task first needs a
  value import.
- Four api write sites already pass an idempotency key (`setup.ts`,
  `provider-links.ts`, `blueprints.ts`, the reconciliation saga) — a correction
  to the T0.6 call-site list, which covers the 8 worker sites.
- `client.poll` treats a `not_found.resource` status answer as still running and
  spins to the deadline — fixed in T0.6 (status-based reconciliation needs it).
- `run-extra-tests.sh --all` Tier 6 contacts **herobids** staging (read-only SSH
  autoscale probe incl. `scale-in.sh --dry-run`, HTTPS to
  `staging.openaidom.com`) and sends a real Telegram `sendMessage`. It is a G2
  mandated suite, so it ran at G0; see P3-1 and ESCALATIONS E1.

**T0.3 — shared signing vectors (pre-rename).** traderton `phase3-mcp-surface`
`a9ca3db`; herobids `phase3-external-backend` `3d6587f8`. Implementer wrote
the generator, fixture and tests; CodeReviewer: 0 CRITICAL/HIGH, 2 MEDIUM fixed
(real-app rejection now asserts `signature mismatch`; this record), LOWs L1–L3
fixed, L4–L6 parked below.
- Fixture `invocation-signing-vectors.json`, byte-identical in both repos
  (`cmp` + `shasum`), sha256 `1d4a04b8e92c2baddea4fc8fef787a310d756cfa621d88c11609ad0f9d0520ef`
  (SEAM §3.1). 4 cases: full-envelope POST, empty-body GET, query-stripped GET,
  non-ASCII POST (428 UTF-8 bytes vs 414 UTF-16 units). Test-only secret.
- Generated from the CURRENT herobids signer by `scripts/ts/generate-signing-vectors.ts`
  (`--check` exits 0 = deterministic; a one-byte edit makes it and the digest
  test fail — verified, then restored).
- herobids: `signing-vectors.test.ts` 16 tests (imports only `./sign.js`, so it
  survives T1.1 byte-unmodified), `client-signing-vectors.test.ts` 4 tests
  (client wire body + headers). `sign.test.ts` comment-only: the replica is
  labelled "NOT a cross-repo guard" and points at the vectors.
- traderton: `signing-vectors.test.ts` 26 tests — real `authenticateRequest`
  accepts every case; one-byte body and signature mutations rejected with
  `signature mismatch`; unstripped query path rejected; real `createBoundaryApp`
  via `app.inject` accepts all 4 (query case proves `toSignedRequest` strips)
  and rejects a mutated signature. `app.test.ts` 37/37 unchanged.
- I4 forms: `pnpm --filter @herobids/domain exec vitest run -t "signing vectors"`
  → 20 pass. I7: 0 escape hatches (test files type-checked ad hoc under strict
  by both sub-agents, since no tsconfig covers them).

**T0.4 — descriptor conformance fixtures.** traderton `phase3-mcp-surface`
`d072b97`; herobids `phase3-external-backend` `2bb453a8`.
Implementer built the generator, fixtures and tests; CodeReviewer round 1: 0
CRITICAL/HIGH, 5 MEDIUM (maxAge semantics undefined; cross-check coverage gap;
Step 10 §1 `publicKey` still "PEM/base64"; keyId uniqueness unstated; this
record) → Implementer rework → round 2: all MEDIUM resolved, none new.
- **Doc first (SEAM §4):** Step 10 §3 gained "Canonicalization and encoding"
  (P3-3): RFC 8785 JCS over a stated value domain; wrapper `{descriptor,
  signature, keyId}`; padded-base64 ed25519 over `UTF-8(JCS(descriptor))`;
  unique keyIds, `keyId` selects exactly one `active|retiring` key; PEM SPKI;
  pin digest = sha256 of the JCS bytes; `maxAge` bounds cache age (validity is
  `issuedAt ≤ now < expiresAt`); the `tools/list` cross-check rule; reason codes
  normative. §1's `publicKey` comment updated.
- **Fixtures:** fictional generic `example-echo` backend (no trading shapes),
  11 files, 14 variants (8 required + positive controls `valid-pinned`,
  `retiring-key-accepted`, `tools-list-agrees` + `tools-list-schema-disagrees`,
  `tools-list-extra-tool`, `definition-disabled`). Each negative carries exactly
  one defect (asserted by restore-and-compare). Dir sha256
  `823ceb2ba634fc6df21e53e82549f3db63a8fdb19caaf52fdaf5d80d60910766` — test
  constants in both repos, SEAM §3.2 shell command, `diff -r` all agree.
- **Keys:** ephemeral ed25519 generated in memory; only the PEM SPKI public key
  is written; `rg -l "PRIVATE KEY"` on all new files → none.
- **Tests:** herobids `descriptor-conformance.test.ts` 23 always-on pass + 14
  in `describe.skip('… TODO(T3.1) flip to describe')`; traderton 23 pass.
  herobids `packages/domain/src/traderton` total 62 pass / 14 skip. Test files
  and generator type-checked ad hoc under strict (both reviewers); I7 0.

**T0.5 — local fixture external-skill source.** herobids only, `89184632`.
Implementer added the port + seam + local installer + fixtures + test;
CodeReviewer: 0 CRITICAL/HIGH, 2 MEDIUM — M1 (`cp` kept symlinks pointing out
of the workspace) fixed by the coordinator (`dereference: true` + the CLI's
exclusion list, with a test); M2 (ad-hoc result type) decided as P3-4. LOWs
L2/L5/L6 fixed (reinstall-replaces + missing-frontmatter tests, port JSDoc,
pinned default-path error); L1/L3/L4 parked.
- `packages/domain/src/ports/external-skill-installer.ts` + optional
  `ToolContext.externalSkillInstaller`; `apps/worker/src/tools/skills.ts` routes
  `add_skills` through `ctx.externalSkillInstaller ?? npxSkillsCliInstaller`
  (spawn args, `CI=1`, 30 s timeout, sequencing unchanged; list/remove untouched;
  no production wiring of the local installer — grep-verified).
- `LocalDirectorySkillInstaller` (test/T4.3 only): `owner/repo@skill` with
  traversal-safe segments, `<sourceRoot>/<owner>/<repo>/skills/<skill>/`,
  CLI-identical `sanitizeName`, rm-then-cp with dereference.
- Fixtures `apps/worker/src/tools/__fixtures__/external-skill-source/example/skills/skills/{echo,echo-shell}/`
  (same `example/skills/echo` ref as the T0.4 descriptor fixtures).
- `skills-local-source.test.ts` 13 tests: `example/skills/echo` installs
  end-to-end through the real `add_skills` with `spawn` mocked to throw;
  Bash-detection follow-up; missing ref; 5 unsafe refs; symlink dereference +
  exclusions; reinstall replaces; missing frontmatter; default path still spawns
  `npx skills add example/skills@echo --yes`. With `skills.test.ts` and
  `skills-bash-detection.test.ts`: 229/229. domain + worker build, `pnpm lint`
  green; new test type-checked ad hoc under strict; I7 0.
- **Constraint carried to T4.1:** each `SKILL.md` frontmatter `name` must
  sanitize to the ref's skill segment (`crypto-trading`, …) and be single-line —
  the installer names the dir from `name`, the post-install reader from the ref.

**T0.6 — CF-1/CF-2 write-path idempotency (D18, IV-1).** herobids
`f495ab3d`; traderton untouched (read-only confirmations only). PlanCreator
wrote `plans/t0.6-idempotency-plan.md`; Implementer implemented it;
CodeReviewer round 1: **1 HIGH** (a write still running at the deadline was
reported as a terminal *rejection* — `client.poll`'s synthesised
`deadline.expired` mapped to `rejected`, recorded by approval-service) + 2
MEDIUM (poll could throw on an unrecognised 200 body; fake could not model
stored failures / stalled completion) + LOWs → Implementer rework, all fixed.
**Round-2 review was interrupted before it reported** — the coordinator
re-verified instead (backend claim checked in traderton `dispatcher.ts`
`mapToolResult`; tests below). A fresh round-2 review is the first action of
the next session (`HANDOVER.md`).
- Call sites: W1 `agent-decision-handler.ts` → `payload.decisionId`; W2
  `approval-service.ts` → `approvalId`; W3 `agent-message-broker.ts`
  `invokeBotLifecycle` → `envelope.messageId`; W4 worker `index.ts`
  `evaluateAgentWatches` → uuid per evaluation; W5 `agent.ts` →
  `createSubjectBoundWriteBoundary` (uuid per tool write). All five derive the
  `requestId`. Correction to the TASKS list: 4 api sites were already keyed
  (`setup.ts`, `provider-links.ts`, `blueprints.ts`, the saga) — they now get
  derived `requestId`s; behaviour otherwise unchanged.
- Decisions P3-5 (key lifecycle), P3-6 (derived requestId), P3-7 (in-call
  reconcile + unknown-not-rejected), P3-8 (vitest subpath alias).
- Tests: focused run (domain traderton, worker traderton/agents, approval,
  risk-limits, watch) 38 files, **701 passed / 14 skipped**; contract suite
  10/10 ×3 runs (+5 by the Implementer); worker + api full **4484 passed / 295
  skipped**; `pnpm build` + `pnpm lint` green; I7 0. Mutation checks by the
  Implementer: disabling the re-issue, the derived requestId or the HIGH-1
  guard each fails the matching tests.
- traderton read-only: `app.test.ts` 37/37; `run-integration.sh
  packages/db/src/boundary-invocations.integration.test.ts` exit 0 (store 7/7 —
  this file skips in every mandated suite, so it was run explicitly).
- Not done here: a herobids leg against the REAL local boundary (herobids
  vitest runs before `ensure_boundary_up`) → carried into CF-6.

**T0.6 round 2 (session 2).** herobids `89349ba7`. CodeReviewer round 2 on
`f495ab3d`: **0 CRITICAL/HIGH**; round-1 HIGH confirmed fixed and the
`isLookupLevelAnswer` premise re-verified against traderton
`dispatcher.ts`/`app.ts`/`result.ts`. Implementer fixed M1 (`parseInvokeResponse`
now shape-checks an `unknown` body → transport_error, never throws), M2 (re-issue
keeps the original transport_error on any lookup-level answer, not only
`deadline.expired`), L1 (fake failure codes narrowed to the 5 storable codes),
L3 (status `state` must be `in_progress|terminal`), L5 (blank key rejected).
Coordinator: success outcome with no `payload` key accepted (backend
`successResult(identity, undefined)` serialises without it — the Implementer's
stricter guard would have regressed it); body ids must be strings. Follow-up
review: 0 CRITICAL/HIGH; its MEDIUM (no test for the re-issue *replace* side)
fixed. Tests: domain traderton + worker traderton/agents/approval + api **2272
passed / 298 skipped**; build + lint green; I7 0. M3/M4 parked below.


**T1.1 — rename + definition schema (C1, C2).** herobids `phase3-external-backend`
C1 `1b204d63`, C2 `5fc75081`; traderton untouched. Implementer did C1 and C2;
CodeReviewer on each: **0 CRITICAL/HIGH**.
- **C1** (`refactor(domain): rename …`): `git mv` of 23 files; 93 files changed
  (api 45, worker 16, domain 26, scripts 2, `.github` 2, SEAM 1, vitest config).
  **R100 proof** on the commit (`HEAD~1:…/traderton/$f` vs `HEAD:…/external-backend/$f`
  blob ids): `sign.ts`, `sign.test.ts`, `signing-vectors.test.ts`, the signing
  fixture, all 11 descriptor-conformance files, `request-id(.test).ts`. Fixture
  sha256 `1d4a04b8…20ef` and dir digest `823ceb2b…0766` unchanged;
  `generate-signing-vectors --check` exit 0. I4: `sign.test.ts` 8 pass
  unmodified; `-t "signing vectors"` 20 pass. Full `packages/domain apps/api
  apps/worker`: **5561 passed / 309 skipped**. Completeness greps empty except
  the frozen fixture description text (P3-9). I7: 36 `as unknown as
  ExternalBackendClient…` hits, all pre-existing test-stub lines changed only by
  the symbol rename (36 `-` / 36 `+`, identical after the rename); zero new.
- **C2** (`feat(domain): ExternalBackendDefinition …`): `config/external-backends.ts`
  (schema, map→array registry, `ResolvedExternalBackendSchema`,
  `findExternalBackend`, `resolveExternalBackend` → `Result`,
  `findExternalBackendProtocolViolations`), `external-backend/client-config.ts`.
  Unwired. Review MEDIUMs fixed by the coordinator before commit: decision
  numbers recorded (P3-9..P3-18 + placeholder map), `baseUrl` http(s)-only
  without userinfo, `.strict()` at every level; LOWs fixed: timeout max,
  `.`/`..` skill-ref segments, JSON round-trip test, Step 10 wording. T0.4
  manifest accepted without fixture edits (14 variants). domain **1105 passed /
  14 skipped**; build + lint green; new test type-checked ad hoc; I7 0.
- Doc-first: Step 10 plan §1 "Config migration — amended Phase 3 T1.1" and the §2
  rename table, in C2.


**T1.2 — internal transport seam (C3).** herobids `4889e4bf`. Implementer built
`transports/{transport,rest-transport,select-transport}.ts`, rewired `client.ts`,
moved the T0.6 reconcile into `ExternalBackendClient.invokeAndAwait` (worker
adapter is a thin delegate; blank-key guard stays in the adapter). CodeReviewer:
**0 CRITICAL/HIGH**; REST parity confirmed line by line (same envelope object to
`signInvoke`, URLs, timeouts, messages, decode trees, requestId labelling).
Coordinator fixed review M1 (unparseable `deadlineAt` refused; interval clamp),
M2 (moved test now distinguishes the running row's requestId), M3 (P3-19..P3-21
recorded), LOW fake-timer flake + already-past-deadline case, index header.
- Unmodified and green: `client.test.ts` 28, `client-signing-vectors.test.ts`,
  `sign.test.ts` 8, signing vectors 20, `write-idempotency.contract.test.ts` 10.
- New: `client-await.test.ts` (29), `rest-transport.test.ts` (13),
  `select-transport.test.ts` (5). `packages/domain apps/api apps/worker`:
  **5631 passed / 309 skipped**. build + lint green; new tests type-checked ad
  hoc; I7 0.
- I2, I3, I3b (dist d.ts has no `transports/` reference; `client.d.ts` shows
  only `private readonly selectTransport;`), I5: all green.
- Doc-first: Step 10 §2.4 note "(amended Phase 3 T1.2)".


**T1.3 — registry wiring + ctx ports (C4, C5).** herobids C4 `ae34241f`, C5
`c79bd4c4`. Implementer did both; CodeReviewer on each: **0 CRITICAL/HIGH**.
- **C4:** `appConfig.boundary` → `appConfig.externalBackends` (map in
  `config/default.yaml`, entry `traderton`) + `tradingBackendId: traderton`;
  both loaders retarget `TRADERTON_BOUNDARY_{URL,CONSUMER_ID,KEY_ID,TIMEOUT_MS}`
  (P3-16), drop the HMAC row (now `caller.hmacSecretRef`), enforce D19 after
  parse, export `resolveConfiguredExternalBackend`. 6 sites are registry lookups
  (worker `index.ts` S1–S4, agent via new `apps/worker/src/external-backend/agent-ports.ts`,
  api `index.ts`); payload `BOUNDARY_CONFIG_JSON` → `EXTERNAL_BACKEND_CONFIG_JSON`
  (P3-24) carrying `{definition, hmacSecret}`; agent-ports logs no parse error
  text (secret-safe, tested). Drift test learns `hmacSecretRef`s. Review parity
  check: identical client config values, subjects, deadlines, degradation, log
  text. Coordinator added the review MEDIUM (runtime-lifecycle env forwarding
  tests) and a stale script comment. No new env key; `.env.example` comment only.
  Stricter-than-before validation (http(s) baseUrl, non-empty ids, timeout cap)
  affects only malformed configs.
- **C5:** ctx ports `externalBackend` / `externalBackendWrite`,
  `ExternalBackendReadResult`, worker adapters `git mv`'d to
  `apps/worker/src/external-backend/` as `ExternalBackend{Read,Write,ToolWrite}Boundary`,
  `tools/external-backend-result.ts`. Symmetric rename (52 files, +291/−291);
  CF-11 api symbols and consumer-local names untouched (counts identical before
  and after); T0.6 contract test changed by symbol renames only.
- Tests: `packages/domain apps/worker apps/api` **5654 passed / 309 skipped**;
  build + lint green; I7 0; I1 no new literal; I2/I3/I3b/I5 green.
- **Suites (G3 asserted first; agent image rebuilt before each):**
  `run-all-tests.sh --e2e` after C4 (`phase3-logs/c4-hb-all.log`) and at block
  end (`b1end-hb-all.log`): exit 0, 9/9 tiers, unit **6595 passed / 339
  skipped** (G0 6384 — growth is this phase's new tests), Playwright 16/16.
  `run-extra-tests.sh --all --skip-tier 6` (P3-1): exit 0, 11 PASS, 3 SKIP (the
  `RUN_UNSTABLE_LLM_LATENCY_TESTS` trio, as at G0) (`b1end-hb-extra.log`).
- Plan §5 I12 note for closeout: after Block 1 a second backend registers with
  config only (YAML entry + its own `hmacSecretRef`); remaining code-bound items:
  the optional `TRADERTON_BOUNDARY_*` override rows, the `tradingBackendId`
  binding of first-party trading sites (Step 14), tool visibility (T3.2).

**T2.1 — MCP spike gate 1: PASS.** Implementer, in git worktrees (main trees
untouched): traderton `~/dev_ai/wt/traderton-spike` branch `phase3-mcp-spike`
(base `d072b97`) `6c386697` + `6b36a792`; herobids `~/dev_ai/wt/herobids-spike`
branch `phase3-mcp-spike` (base `ae34241f`) `c9b1c0c2` + `acd9cd8f`. Never pushed.
Logs `phase3-logs/t2.1-*.log`. Per item (block2 plan §2.2):
1. Default client frames: `POST initialize`, `POST notifications/initialized`,
   `GET` (405), `POST tools/call`; every POST body a `string` (both legs).
2. Every POST passed the **unmodified** `authenticateRequest` on the real
   `createBoundaryApp` (initialize 200, notification 202, tools/call 200 success).
3. Server-received sha256 = middleware-hashed sha256 for all 3 POSTs;
   `params._meta` strict-equals the 8 envelope fields (incl. non-ASCII), and so
   does the handler's `request.params._meta`.
4. Tamper controls → `authentication.invalid_caller`, tool not run: byte flip in
   `_meta` (`signature mismatch`), deadline header ≠ `_meta.deadlineAt`, `_meta`
   keyId ≠ header.
5. SDK `notifications/cancelled` after a client timeout: string body, signed,
   authenticated, 202.
6. herobids `createSigningFetch` headers strict-equal `signRequest(...)` for every
   frame; body forwarded unchanged; bridge: real traderton verifier accepted all
   3 herobids-signed POSTs (+ byte-flip control rejected).
7. build + lint green both; escape-hatch grep empty; strict tsc over spike tests
   green; zod: app packages on 3.25.76, 4.6.5 only under `@modelcontextprotocol/*`
   — **after** a `pnpm-workspace.yaml` override `abitype>zod: 3.25.76` (adding
   the SDK made pnpm resolve viem→abitype's optional zod peer to 4.x; P3-45).
`sign.ts` / `auth.ts` / `dev/sign.ts` unchanged. Hard stop 3 not triggered.


**T2.2 — traderton MCP boundary surface (TC2–TC4) + decision ratified.**
traderton `phase3-mcp-surface`: FD rewording `6138283`, TC2 `6fc1099`, TC3
`e781a4b`, TC4 `dfda5eb`, review fixes `5ea82f9`. **Decision settled by the
operator** ("one core, two seams; mcp and rest share all but the seams; swap most
API tests rest↔mcp at will") — I passed it to the Contemplator for an independent
view (verdict **"settled within the rules"**: MCP is a second *wire* onto the one
dispatcher, not a second execution path; FD3 was worded against a route when it
meant the dispatcher). Recorded in traderton 004 "MCP-FD" + 001 ledger; 005
§Fixed Decisions 1–3 reworded + FD6 extended. Operator ratified the rewording.
- TC2 pure move of signed-request material to `request-material.ts` (gate-2
  files unmodified; REST handler + parser blocks textually identical).
- TC3 `mcp/*` route over the existing `ToolInvocationDispatcher`, off by default
  (`BOUNDARY_MCP_ENABLED=false`); `@modelcontextprotocol/server@2.3.0` dep +
  `/client@2.3.0` devDep (exact) + `abitype>zod: 3.25.76` override; env twins
  (both); exports; `descriptor-tools` projection (serves, never verifies — D16);
  n25 result encoding, n26 pre-dispatch failures, dispatcher exception →
  sanitized `-32603`, GET/DELETE→405, batch→-32600.
- TC4 real-Postgres idempotency verification (4 cases) + `run-integration.sh`.
- CodeReviewer: **0 CRITICAL/HIGH**; gate 2 confirmed (`auth.ts`/`dispatcher.ts`/
  `dev/sign.ts` byte-unchanged; block-identity identical; app without `mcp`
  registers no route). Fixed its LOW-1 (JCS-equal descriptor dedup, not raw
  `JSON.stringify`) + LOW-2 (dropped unused predicate) in `5ea82f9` with a
  reordered-keys test.
- Tests: `packages/boundary` 164 passed / 32 skipped; `mcp/*` 36;
  env-example-drift 7. **Integration (real Postgres, throwaway containers
  55432/56379):** `run-integration.sh` exit 0 — MCP verification 4/4, REST
  verification 15 (+1 skip) (`phase3-logs/t2.2-tt-integration.log`). build +
  lint green; zod: app packages 3.25.76, 4.x only under `@modelcontextprotocol/*`;
  I7 0 in production code.
- Gate 2 (coexistence) is the binding invariant and holds. The heavy traderton
  cross-stack suites (`run-all-tests.sh --e2e`, `run-extra-tests.sh --all`) are
  owed at closeout G2.

---

## Outstanding Issues (park LOW findings here; do not fix them mid-task)

**Baseline / cross-cutting**
- LOW — `pnpm lint` type-checks nothing in herobids or traderton (root tsconfig
  `files: []` + references, run with `--noEmit`), and test files are in no
  tsconfig. Pre-existing; mitigated by P3-2. Fix belongs to a tooling task.

**T0.3**
- LOW (L4) — no `.gitattributes` in either repo; a CRLF-converting checkout
  would fail the fixture digests (fails closed). Optional: `**/__fixtures__/** -text`.
- LOW (L5) — traderton `signing-vectors.test.ts` has no explicit "exactly four
  case ids" check (covered indirectly by the pinned digest).
- LOW (L6) — body mutation is exercised at `authenticateRequest` level only, not
  through `app.inject` (signature mutation is).

**T0.4** (consider at T3.1, which adopts the reason codes)
- LOW — rule text writes `descriptorPinning.maxAge.seconds`; the real path is
  `descriptorPinning.seconds` when `mode: 'maxAge'`.
- LOW — `issuedAt ≤ now` has no not-yet-valid variant/reason code; Step 10 §3
  pipeline step 4 still says only "`expiresAt` not past".
- LOW — no missing-tool or duplicate-name `tools/list` variant (rule text and
  helper cover them; a ⊆-only check would pass the suite).
- LOW — `descriptor.ref_not_approved` is a definition-level check; consider
  `definition.ref_not_approved` before T3.1 makes codes final.
- LOW — SEAM §3.2 intro and Step 10 §7 0c variant list don't mention positive
  controls; Step 10 §4 rotation could say "under a new keyId" explicitly.
- LOW — JCS rule does not reject lone surrogates (RFC 8785 requires I-JSON);
  both sides are TS today.

**T0.5**
- LOW (L1, for T4.3) — a traderton-skills checkout maps to
  `<sourceRoot>/traderton/skills`; use a temp tree with a symlink, or add an
  optional `repoDirs` option. The T4.3 test should take the checkout path from
  an env var and skip when absent.
- LOW (L3) — `parseSkillFrontmatter` is line-based: quoted values keep their
  quotes; `description: >-` passes the presence check.
- LOW (L4) — the installer imports `parseSkillFrontmatter` from `./skills.js`
  (whole tool module); extract `skill-frontmatter.ts` if it is ever wired from
  `skills.ts`.

**T0.6**
- MEDIUM (pre-existing, NOT fixed, out of scope) — `deprovision:${venueAccountId}`
  (api `setup.ts` compensate + `provider-links.ts`) replays a first terminal
  `provision.in_use` failure forever, so a user can never delete that link after
  stopping the bot; saga `actionId` retries after a terminal failure behave the
  same. Fix per P3-5 (per-attempt key). Verify with a backend test first.
- LOW — `parseInvokeResponse` (invoke path) can still throw on a `null`/`{}` 200
  body (`'state' in null`, `mapTerminalResult({})`); left untouched (REST invoke
  path outside T0.6's scope). Candidate for T1.2's RestTransport decode.
- LOW (pre-existing) — the decision handler emits `decision.rejected` for
  `status: 'error'` (unknown outcome); only the log says "unknown". Changing the
  event is an event-type change.
- LOW — the re-issue/poll fetches use the full `requestTimeoutMs`, not the
  remaining budget (≤ one timeout overrun, documented). T2.3 decides the
  deadline-derived attempt timeout (block2 plan n31 / IV-2).
- LOW — the in-call reconcile lives in the worker adapter, not the client
  ("implemented once" per Step 10 §2.4); block1 plan C3 moves it into
  `ExternalBackendClient.invokeAndAwait`. api direct-client writes get no in-call
  reconcile today.
- LOW — derived `requestId`s are predictable from (consumer, owner, tool, key);
  matters only if the (non-owner-scoped) status lookup were ever exposed beyond
  the HMAC-authenticated consumer.
- LOW — `apps/worker/src/traderton/__tests__/fake-idempotent-boundary.ts`
  compiles into the worker dist (same as the api `__tests__` helpers precedent).

**T0.6 round 2** (the `parseInvokeResponse` LOW above is fixed in `89349ba7`)
- MEDIUM (M3, deferred — event-type change) — an unknown outcome still emits
  `instance.decision.rejected` (`agent-decision-handler.ts` ~604), so
  `runtime-composition.ts` counts it in `metrics.decisionsRejected` and the
  activity feed shows "Decision rejected". The sync reply is correct (`error`).
  Fix: a distinct `instance.decision.outcome_unknown` event, or stop counting it.
- MEDIUM (M4, deferred — tool-contract wording) — agent-container
  `mapWriteResultToToolResult` (`apps/worker/src/tools/traderton-read.ts` ~101)
  maps `in_progress` to `precondition.not_ready` (same code as "not
  configured") and `transport_error` to "unreachable"; W5 keys are per call, so
  an LLM retry is a new write. Fix: unknown-outcome wording telling the agent to
  verify (`list_watches`/`get_risk_limits`), maybe `boundary.in_progress`.
- LOW — failure `code` checked only as a string (unknown codes pass through for
  forward compatibility); `details` not shape-checked.
- LOW — the cross-repo premise of `isLookupLevelAnswer` (stored results carry
  only the 5 storable codes) is pinned by a comment only; a traderton
  dispatcher test would pin it.
- LOW — a re-issue during a rolling backend deploy could see a deterministic
  pre-store rejection (unknown tool, `authorization.denied`) although attempt 1
  executed. Rare; out of scope.
- LOW — traderton status lookup is not consumer/owner-scoped and requestIds are
  now predictable; within the current HMAC trust model. Follow-up: scope
  `findByRequestId` by the authenticated `consumerId`.

**T1.1**
- LOW — `hmacSecretRef` echoes the ref name in `secret_missing`; if an operator
  pasted an uppercase base32 secret into the ref it would be echoed. Unlikely.
- LOW — `contractVersion: z.literal('1.0')`: unquoted YAML `1.0` parses to a
  number and is rejected (fails closed; `default.yaml` quotes it).
- LOW (for C4) — the D19 check under `NODE_ENV ?? 'development'` lets `mcp`
  through when `NODE_ENV` is unset; agent-ports must not log `JSON.parse` error
  text for `EXTERNAL_BACKEND_CONFIG_JSON` (Node echoes a snippet; payload holds
  the secret); T3.1 must still report the fixture reason `definition.disabled`.
- LOW — prose "Traderton REST boundary" remains in `packages/domain/src/index.ts`
  and `trading/tool-contract.ts` comments; traderton test headers still name the
  old herobids fixture path.
- LOW — `.github/skills/external-backend-genericization/SKILL.md` item 8 still
  describes the pre-T0.6 idempotency state.

**T1.2**
- LOW — `TransportInvocation` restates `requestId`/`idempotencyKey`/`deadlineAt`
  that `ExternalBackendToolInvocationV1` already requires (kept as explicit I5
  documentation).

**T1.3**
- LOW — the api gives no startup log when the trading backend is unresolved
  (pre-existing; adding one is new behaviour).
- LOW — the drift test reads `hmacSecretRef`s from `default.yaml` only; a backend
  added only in an environment overlay would bypass it.
- LOW — `tradingBackend` setup duplicated in api/worker `index.ts` and the two
  loaders (mirrored-loader convention; Step 14 deletes the sites).
- LOW — "Traderton REST boundary" prose remains in the moved adapter headers and
  log strings; `infra/hetzner/docs/runbooks/phase1-operational-readiness.md`
  cites pre-move paths (dated capture).
