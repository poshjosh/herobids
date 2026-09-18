# Plan A3: Boundary risk/account context — serve `get_risk_limits`, `adjust_risk_limits`, `get_account_summary` behind the boundary

- **Task:** A3 — restore the risk/account read+adjust surface over the boundary
- **Repo:** both (implementation mostly traderton; small herobids option-dependent)
- **Status:** PLAN — **decision recorded (2026-09-18): Option X** (see the DECISION section below). No implementation authorized yet; ready for plan-creation/implementation when Track A is green-lit.
- **Defect class:** Lost feature from the migration (audit §2 rows `tools/risk-limits.ts`, `tools/account.ts`; §7 follow-ups).

## Context (verified against HEAD 2026-09-18)

- Traderton's `get_risk_limits` **unconditionally** requires `ctx.riskContractOps` (`packages/worker/src/tools/risk-limits.ts:20-23`) — no fallback boundary-side. `adjust_risk_limits` shares the same guard (`:86-89`).
- `bin.ts`'s context factory supplies **no** `riskContractOps`, `agentRepo`, or `executionConfig` → over the boundary both tools **always** return `success: false, "risk contract not available in this context"`.
- herobids' tool routes boundary-**first** when configured (`apps/worker/src/tools/risk-limits.ts:25`) → the error surfaces to the LLM (historical `agent_messages` evidence: `get_risk_limits → "risk contract not available in this context"`).
- `get_account_summary` degrades similarly (truthful `*_unavailable` warnings — audit §2; cosmetic today because capital injection drives the risk gate, but the LLM sees `capital: null`).
- Since phase 3, the consumer already threads `capital`/`riskPosture`/`riskOverrides` in the signed `submit_decision` payload — the data needed to serve these reads **already crosses the wire**, just only on that one tool.

**Impact:** the agent cannot read or adjust its risk limits over the boundary; account summary lies about capital. This is the biggest user-visible regression of the migration.

## DECISION (2026-09-18): Option X — copy the ops, bind to payload now, restore READS only

Confirmed after a code deep dive + Contemplator pass. Two facts drove it:
- **FACT 1 — the ops are COPYABLE.** herobids `apps/worker/src/agent.ts` `buildRiskContractOps()` already implements `getContract`/`adjustOverrides`(/`getProfile`) + the risk-contract math. Building it boundary-side in traderton is a **copy** (copy-never-author safe); only the SOURCE BINDING is an authored thin seam. The ops are source-agnostic — payload now, profile store (B1) later.
- The boundary consumers already exist (`traderton .../tools/risk-limits.ts`, `tools/account.ts`); the break is that `bin.ts` **never constructs** `riskContractOps`. A3's job is to construct it.

**What A3 does (Track A — stability, decision-light):**
1. Copy the source-agnostic `riskContractOps` + math into traderton; wire the boundary context factory (`bin.ts`) to construct it. `get_account_summary` rides the same seam (name it in scope).
2. **Single `RiskSource` seam (ACCEPTANCE CRITERION).** The ops read `{ capital, riskPosture, overrides }` through ONE narrow interface — never ad-hoc payload fields. Under A3 it is implemented by reading the payload echo; under B1 it is reimplemented against the profile store. This is the linchpin: it makes the B1 payload→profile swap a one-adapter change AND keeps echo-deletion clean. If A3 reads payload fields ad hoc, the whole low-rebind/clean-deletion advantage erodes.
3. **Restore READS only** (`get_risk_limits`, `get_account_summary`) bound to the payload echo via the seam.
4. **`adjust_risk_limits` stays fail-closed / typed-failing until B1.** The write has no durable traderton-owned home until the profile store (B1) exists — writing it anywhere pre-B1 either violates "traderton owns what traderton enforces" or smuggles B1 into Track A. Matches the fail-closed posture herobids' code already documents. The write comes alive in Track C when the profile gives `adjustOverrides` its durable home.

**Why Option X over "build once inside B1" (Option Y):** the expensive work (copy ops + math, wire handlers, restore tools + tests) is done ONCE and survives B1 untouched; only a tiny payload-source adapter is throwaway. Option Y would block a stability fix behind Track C's heaviest decision, or drag profile-store design into Track A — both defeat the epic's division of labor. The single-seam shape means Option X is *safer* for B1: the swap seam is built and exercised under load in Track A, so Track C's source swap is already proven.

**Notes:** the read surface may be the 5-field contract only until the profile store lands (`getProfile` is optional; consumers already guard it) — graceful degradation, not a bug. A8 must assert the split: reads succeed AND `adjust_risk_limits` fails **closed with a typed precondition** (not a silent pass, not an in-process write) so the fail-closed write can't regress unnoticed before B1.

### Two resolved caveats (2026-09-18) — nothing left open

**Caveat 1 — empty-payload plumbing: ATTACH the risk spec to the read calls (DECIDED).** `get_risk_limits`/`get_account_summary` take empty payloads today; the echo currently rides only on `submit_decision`. Resolution: the platform (herobids) attaches the risk spec to these read calls too, reusing the SAME `buildSubmitDecisionPayload`-family builder that already stamps `submit_decision`. Chosen over cache-from-last-decision because it keeps every read self-contained and correct, and avoids the cache's failure modes (stale values; a first read before any decision returning nothing). The `RiskSource` seam reads from the per-call payload.
- **Who attaches:** the PLATFORM (herobids worker), post-LLM, from the `agents` row — NOT the agent/actor. The LLM never sees or supplies these values (same as the `submit_decision` echo).

**Caveat 2 — trust posture: ACCEPT as a known, documented transitional weakness (DECIDED).** The risk numbers are consumer-asserted and traderton cannot verify them — the same posture as today. A3 is a stability task, not an integrity fix, and changes nothing for the worse. B1 fixes it properly by making traderton OWN the numbers (profile store keyed on verifiable `(ownerId, venueAccountId)`). Recorded here explicitly so this interim is never mistaken for the end-state.

---

## Options (original pre-loaded analysis — retained for context; superseded by the DECISION above)

**Option 1 — Per-tool context injection from consumer values (RECOMMENDED).**
Build a boundary-side `riskContractOps` in `bin.ts`'s context factory, sourced from the **same consumer-injected values** the actor ensure already consumes. Mechanics:
- Extend the subject resolver's `agentRiskSpec` extraction (or a parallel context-request field) so risk-context-bearing invocations for `get_risk_limits`/`adjust_risk_limits`/`get_account_summary` receive the spec (these tools take empty payloads today — so either accept the spec via an optional payload field the consumer sends, or attach it to the injection from a small consumer-side "context" invoke).
- `bin.ts` assembles `riskContractOps` = `buildAgentRiskLimits`-family resolution (traderton already owns this math) over the injected spec; `agentRepo` = a thin adapter over the injected capital; `executionConfig` = from injection ownerMode + spec.
- `adjust_risk_limits` then needs a durable store: **sub-decision** — (1a) persist overrides traderton-side (new small store or the trading-profile store if B1 lands there), or (1b) fail adjust with a typed `precondition.not_supported` until B1 decides (read-only parity restored now; write deferred to the B1 outcome).
- Pros: consistent with the phase-3 value-injection architecture; no new trust surface (values already cross); restores parity without pre-empting B1. Cons: more payload plumbing; 1b leaves adjust broken-but-honest.

**Option 2 — Typed fail (minimal honesty fix).**
Change the guards to return a typed `precondition.not_ready` (like other boundary gaps) instead of a bare error string, and make herobids' tool surface fall back to its in-process read for `get_risk_limits` (it already has the code) while hiding/annotating `adjust_risk_limits`.
- Pros: one afternoon of work; no new plumbing. Cons: keeps the split-brain (consumer reads its own limits, traderton enforces from payload echoes) — read and enforcement can drift; adjust stays lost.

**Option 3 — Defer wholesale to B1.**
Treat this as the first consumer of the B1 trading-profile and fix it there.
- Pros: no interim architecture. Cons: the most user-visible regression stays until B1 lands; B1 is the biggest decision.

**Recommendation: Option 1 with sub-decision 1b** (read parity now via injected spec; adjust fails typed until B1). Rationale: restores the lost read feature immediately on the already-accepted value channel; does not invent a durable store that B1 would immediately re-decide; the trust question is identical to phase 3's (accepted for now, revisited by B1).

## Steps (Option X — finalized 2026-09-18)

1. traderton: **copy** the source-agnostic `riskContractOps` + risk-contract math from herobids `apps/worker/src/agent.ts buildRiskContractOps()` (copy-never-author: copy the ops + math; author only the source binding). Define the single **`RiskSource`** interface returning `{ capital, riskPosture, riskOverrides }` for the invocation.
2. traderton: extend `get_risk_limits`/`get_account_summary` schemas + resolver extraction to accept the risk spec on the read call (Zod-strips lesson: declare every field the factory reads).
3. traderton: `bin.ts` context factory — construct `riskContractOps` behind the `RiskSource` seam, implemented for A3 by reading the per-call payload spec; feed `get_account_summary` capital from the same seam. Absent spec → typed precondition (keep account summary's graceful `warnings` degrade).
4. traderton: `adjust_risk_limits` → **fail-closed / typed precondition** pointing at B1 (no durable write home until the profile store exists). Do NOT write to the agent row or invent a store.
5. herobids: `tools/risk-limits.ts` + `tools/account.ts` — the PLATFORM attaches the risk spec to these read calls (post-LLM, from the `agents` row), reusing the `buildSubmitDecisionPayload`-family builder. Map the typed precondition through `mapReadResultToToolResult`.
6. Tests both sides: boundary `riskContractOps` construction via the seam; end-to-end read parity vs the in-process shape; `adjust_risk_limits` typed fail-closed. A8 asserts reads-work AND adjust-fails-closed.

**B1 hand-off:** B1/Track C reimplements the `RiskSource` seam against the profile store (one-adapter swap), deletes the payload echo, and activates `adjust_risk_limits`. The ops, math, handlers, tools, and tests from A3 survive unchanged.

## Verification

- Per-package tsc both repos; full suites.
- Live cross-stack: `get_risk_limits` returns real limits (capital 1000 → daily-loss $200 visible); `get_account_summary.capital` populated; adjust fails typed.

## Risks

- Payload-field proliferation (spec now on 3 tools) — mitigated by one shared extraction helper.
- If B1 lands on traderton-owned profiles, Option 1's `riskContractOps` assembly gets replaced by the profile store — acceptable interim cost, explicitly flagged.

## References

- `traderton/packages/worker/src/tools/risk-limits.ts:20-23,86-89` · `tools/account.ts`
- `traderton/packages/boundary/src/bin.ts` (context factory; zero riskContractOps refs — verified)
- `herobids/apps/worker/src/tools/risk-limits.ts:25` (boundary-first routing)
- Audit: `docs/tech/trading/audits/2026/09/001-…-ownership-audit.md` §2, §7-S2
