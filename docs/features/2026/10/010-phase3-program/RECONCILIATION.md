# Phase 3 — Reconciliation (T5.1)

**Status:** closeout record. **Date:** 2026-10-03.
**Scope:** Phase 3 Steps 11–13 (+ Step 0/0b/11b), executed from this package.
**Rule (ENTRYPOINT §8 G-DoD):** every Step-10 §7 task and every Step-9 discovery
disposition maps to exactly one outcome — ✅ done / 🕓 deferred-with-note / ⤴
escalated / 🧱 out-of-scope. **No item unclassified.**

Legend: ✅ done · 🕓 deferred (carried, with a CF/evidence pointer) · ⤴ escalated
(ESCALATIONS row) · 🧱 out-of-scope (Step 14/15/16 or D12).

Branches (zero pushes, D20): herobids `phase3-external-backend`, traderton
`phase3-mcp-surface`, traderton-skills `phase3-skill-publication`.

---

## 1. Step 10 §7 ordered tasks → outcome

### Step 0 — baseline + shared fixtures (before any edit)

| § | Task | Outcome | Evidence |
|---|---|---|---|
| 0a | Capture G0 baseline (HEAD + `git status` + lint + 5 suite exit codes, all three repos) | ✅ | TASKS Baseline table; `phase3-logs/g0-*.log` |
| 0b | `invocation-signing-vectors.json` in both repos (frozen cases + fixture digest) | ✅ | T0.3; herobids `3d6587f8`, traderton `a9ca3db`; digest `1d4a04b8…20ef` (SEAM §3.1) |
| 0c | Descriptor-conformance fixtures in both repos (signed + 6 tampered variants → instruction-only) | ✅ | T0.4; herobids `2bb453a8`, traderton `d072b97`; dir digest `823ceb2b…0766` (SEAM §3.2) |
| 0d | Local fixture external-skill source | ✅ | T0.5 `89184632`; used end-to-end at T4.3 |

### Step 0b — CF-1/CF-2 write-path idempotency (D18)

| § | Task | Outcome | Evidence |
|---|---|---|---|
| 0e | Thread a stable `idempotencyKey` + `requestId` from every write call site | ✅ | T0.6 `f495ab3d` (+ round-2 `89349ba7`); IV-1; W1–W5 keyed |
| 0f | Persist `requestId` so a lost-after-execution outcome is reconcilable | ✅ | T0.6 (same-key re-issue + status reconcile); P3-7 |
| 0g | Characterisation tests (same key → 1 effect; changed payload → `validation.invalid_payload`; timeout-after-execution → reconcilable) | ✅ | `write-idempotency.contract.test.ts` (10, ×['rest','mcp'] after T2.3); backend legs confirmed green not duplicated |

### Step 11 — generic client migration + transport seam

| § | Task | Outcome | Evidence |
|---|---|---|---|
| 1 | Rename `traderton/` dir + subpath → `external-backend`; symbol table; preserve `sign.ts` bytes | ✅ | T1.1 C1 `1b204d63`; R100 blob proof; `sign.test.ts` 8 + vectors 20 unmodified |
| 2 | `ExternalBackendDefinition` + Zod + `appConfig.externalBackends[]` registry (protocol/overrides/mcpPath); `.env.example` twin | ✅ | T1.1 C2 `5fc75081` (schema), T1.3 C4 `ae34241f` (registry wiring); no new env key |
| 3 | Extract the transport seam (`RestTransport` first); seam internal, not exported; requestId/idempotencyKey first-class | ✅ | T1.2 C3 `4889e4bf`; I2/I3/I3b/I5 green |
| 4 | Rewire the 6 construction sites + ~32 importers; ctx ports `tradertonBoundary`→`externalBackend` | ✅ | T1.3 C4 `ae34241f` (sites), C5 `c79bd4c4` (ports/adapters) |
| 5 | Verify: lint + api/worker tests + full build; no behaviour change | ✅ | Block 1 suites: `run-all-tests.sh --e2e` 9/9 tiers, `run-extra-tests.sh --all --skip-tier 6` exit 0 (`phase3-logs/{c4,b1end}-*.log`) |

### Step 11b — `McpTransport` + the backend MCP surface (D14)

| § | Task | Outcome | Evidence |
|---|---|---|---|
| 6 | Spike gate 1 (`params._meta` inside the signed bytes) — HARD STOP if it fails | ✅ PASS | T2.1 spike worktrees (herobids `c9b1c0c2`+`acd9cd8f`, traderton `6c386697`+`6b36a79`); `phase3-logs/t2.1-*.log`; all 7 items |
| 7 | traderton MCP route over the existing dispatcher; `Server` + descriptor `tools/list`; `isError` return; `_meta` assertions; reuse `buildCanonicalString`; REST route untouched | ✅ | T2.2 `6fc1099`/`e781a4b`/`dfda5eb`/`5ea82f9`; gate 2 (parser+REST+dispatcher byte-unchanged) held; off by default |
| 8 | herobids `McpTransport` behind the seam; HMAC via fetch middleware; per-call timeout from `deadlineAt` | ✅ | T2.3 `093974be`; `attemptTimeoutMs` IV-2; `2327f455` |
| 9 | Contract tests ×['rest','mcp'] on both; characterisation on both; tools/list cross-check → instruction-only on mismatch; `protocol` stays `rest` outside dev/test (D19) | ✅ | T2.3 contract + parity suites; **xstack parity EXECUTED** against the real MCP route (4 MCP legs, `phase3-logs/t2.3-xstack-parity.log`); cross-check at T3.1/T3.2 |

### Step 12 — trust-gated deep integration

| § | Task | Outcome | Evidence |
|---|---|---|---|
| 5 | Descriptor type + verification pipeline (ed25519, pinning, expiry, revocation) in domain | ✅ | T3.1 `747f6fdb`; `descriptor.ts`; T0.4 fixtures green (14 variants) |
| 6 | Replace the trading `if`-branches with the generic rule (no `if (trading)`) | ✅ | T3.2 `ac4fe432`; I1 visibility-path = 0 (only the `deriveReadiness` readiness stay, class-c) |
| 7 | Register the Traderton definition + load its descriptor; a local stub keeps trading working | ✅ | T3.3 (folded in `ac4fe432`); stub, then replaced at T4.2 |
| 8 | Verify: trading tools resolve for a D11-ref agent; non-matching skill → no tools; revocation strips tools | ✅ | `descriptor-tool-visibility.test.ts` parity + degrade matrix |

### Step 13 — Traderton skill publication

| § | Task | Outcome | Evidence |
|---|---|---|---|
| 13 | Author `SKILL.md` for the three crypto skills (frontmatter + backend-owned instructions from the herobids seeds) | ✅ | T4.1 traderton-skills `77fd7a59` (not pushed) |
| 14 | Signed descriptor binding the three refs → tool schemas; wire `trustedDescriptorSigningKeys` + `approvedSourceSkillRefs`; DELETE the Step-12 stub (grep-proven) | ✅ | T4.2 `636905f0`; I10 grep = 0 |
| 15 | Signing key: dev ed25519, private key gitignored, descriptor marked dev-signed; real operator key gated | ✅ (dev) / 🕓 (real key) | T4.2 (dev key committed-public, private gitignored); real key → CF-9 |
| 16 | Commit on a branch; do NOT push traderton-skills/traderton (D20) | ✅ | all three repos local-only (I9); push → CF-8 |
| 17 | Verify against the LOCAL FIXTURE source (not the live CLI); record real-remote resolution deferred | ✅ / 🕓 | T4.3 `3c16064b` (install→resolve→visibility→invoke→map, both transports); real-remote CLI resolution → CF (post-push operator step) |

**Every Step-10 §7 task is ✅, with two tasks carrying a 🕓 sub-item** (task 15
real operator key → CF-9; task 17 real-remote CLI resolution → post-push), both
recorded as carried-forward, neither blocking the locally-verified DoD.

---

## 2. Step 9 discovery dispositions → outcome

The Step-9 discovery enumerated the symbol/importer dispositions and the
hard-coded trading branches that Phase 3 Steps 11–12 act on.

| Step-9 item | Outcome | Where |
|---|---|---|
| `traderton/` client module + ~32 type importers → `external-backend` rename | ✅ | T1.1 (Step 11 task 1/4) |
| The 6 client construction sites (corrected from 5; `exports.ts:348` is a comment) | ✅ | T1.3 C4 (Step 11 task 4) |
| CF-1 write-path idempotency defect (reachable duplicate-order path) | ✅ | T0.6 (Step 0b, D18) — IV-1 |
| Hard-coded trading branches (`skills.ts`, `agent-runtime-descriptor.ts`, `agent.ts`, …) in the visibility path | ✅ | T3.2 (Step 12 task 6); I1 → 0 |
| `provider-catalog.ts` cited by Step 10 §7 task 5 as a trading-branch site | ✅ (N/A) | Investigation found `apps/api/**/provider-catalog.ts` does not exist; `packages/domain/src/provider-catalog.ts` is the LLM-model catalog, unrelated — no branch to remove |
| TICK-WORK / market-data family gates (`agent-capabilities.ts`, `runtime-composition.ts:700`, `agent.ts` startup guard) | 🧱 | Step 14/15 — market-data orchestration, not visibility (plan §6 fence); still read `capabilityFamilies` (parity) |
| `deriveReadiness` `family === 'trading'` (venue-account readiness) | 🧱 | Step 14/15 — readiness-presentation stay (class c), not registration/dispatch/visibility |
| `packages/domain/src/trading/**` (trading-domain modules), consumer-local trading names (`tradertonClient`, `hybrid-price-adapter`, `price-contracts`) | 🧱 | Step 14/15 (D12) |
| api CF-11 surfaces (`exports-traderton.ts`, `trading-profile-reconciliation-saga`, `traderton-operator-defaults`) | 🧱 / 🕓 | Step 14/15 (D12) + open legal/product dispositions → CF-11 |
| `tradingBackendId` first-party binding | ✅ (kept, out of visibility) | P3-17/P3-22; removed with the first-party sites at Step 14 |

---

## 3. Carried-forward obligations (full set → see DECISIONS §5, G9 at T5.2)

CF-3 REST differential vs the pinned oracle · CF-4 representative load · CF-5 no
metrics system (latency/throughput N/A) · CF-6 staging restart/health/idempotent-
retry/rollback (proven for a read tool only) · CF-7 no rollback path · CF-8 push
gate (all three repos) · CF-9 real operator-held signing key · CF-10 conditional
third (MCP) differential leg · CF-11 open legal/product dispositions · CF-12
pre-existing baseline failures · **CF-13 1→N external-backend forwarding** (I12:
a second backend resolves *visibility* with zero code change; *invoking* its
tools over HMAC needs the N-forwarding change). Plus: real-remote `npx skills`
resolution deferred to the post-push operator step (Step 13 task 17).

---

## 4. Invariants at closeout (G8) — see T5.2 for the full G0–G9 record

I1 visibility-path 0 (readiness stay recorded) · I2/I3/I3b none · I4 frozen
(sign 8 + vectors 20, digest `1d4a04b8…`) · I5 present · I6 descriptor sole
authority · I7 0 new escape hatches in production (38 diff hits are all
rename-touched pre-existing `as unknown as` lines in TEST files) · I9 zero
pushes · I10 stub gone (grep 0) · I11 `.env.example` current · **I12 written
answer:** a second, unrelated backend is exposed with config + a signed
descriptor and zero platform code change for *visibility*; the one remaining
code-change for *tool invocation over HMAC* is the 1→N forwarding (CF-13).
