# Consume Traderton over REST (L3) — START HERE

**A fresh session lands here with no context. This folder is self-contained; read it in order.**

## What's happening
Trading is being extracted into a separate **Traderton** service. herobids is becoming its
**REST consumer**: it deletes its in-tree trading execution and calls Traderton's boundary
(HMAC-signed `POST /internal/v1/tools:invoke`) instead. Everything else (agents, messaging,
LLM, the connection/grant layer, approvals, maxBots) stays in herobids.

## Where you may work
**Branch `consume-traderton` ONLY.** herobids `main` and every other branch are untouchable.
Merging this branch to `main` = **cutover**, and needs explicit human approval. Never touch the
stray `apps/worker/src/watch-summary.js`.

**Do NOT edit the sibling `traderton` repo.** It is **READ-ONLY** from here — read it (the 005
contract, the boundary code, CANONICAL-STATE) and copy/mirror as needed, but never modify it. If a
change to traderton is genuinely needed (e.g. the boundary or the contract), STOP and surface it to
the human / the traderton session — traderton edits are made there, not from here (the mirror of the
extraction-era source-fix-request rule).

## Read in order
1. `000-l3-consumption-spec.md` — the working spec: the DELETE/KEEP/REWIRE seam, decisions
   D1–D5, and the sub-phasing (L3a → L3b → L3c → L3d → L3e).
2. `001-l3a-implementer-prompt.md` — the current task (**L3a**): the Traderton REST client +
   config + HMAC signer. No rewire, no deletion yet.

## Where the authority lives (until cutover)
State, decisions, and invariants are the source of truth in the sibling **Traderton** repo,
not here: `traderton/docs/CANONICAL-STATE.md` (and the 005 contract it points to). This folder
is the herobids-side *working* record and defers to CANONICAL-STATE. At cutover the
repo-of-record moves to herobids (a working-location change — Traderton is NOT absorbed).

## Progress
- [x] Spec + L3a prompt written.
- [x] L3a — REST client + config + signer.  ← **DONE** (committed on `consume-traderton`)
- [ ] L3b reads → L3c writes → L3d delete trading packages → L3e differential + staging + merge gate.

## Handoff note (read this — you are picking up mid-project)
This work began in the **traderton** repo (extraction + the M2 REST boundary F, all complete) and
**handed off to here** at the start of L3. Nothing in the consumption work is implemented yet —
**no rewire, no deletion; only this spec + the L3a prompt exist.** Your first action is **L3a**
(`001-l3a-implementer-prompt.md`): build the Traderton REST client + config + signer, unit-tested
against a stubbed boundary. Run the loop — investigate → (the prompt is the plan) → implement →
review → test → **pause for the human before L3b.** Do not skip ahead to rewiring/deleting trading
code; the slice order is deliberate (read path before write path; delete last).

The full decision record (D1–D5, the repo-of-record/doc-placement plan) is authoritative in the
sibling repo: `traderton/docs/CANONICAL-STATE.md` §3.1 (L3 decisions) + §5.1 (doc placement +
repo-of-record moves to herobids AT CUTOVER — a working-location change; Traderton is NOT absorbed).
Treat CANONICAL-STATE as the source of truth for state/decisions/invariants until cutover.

## Outstanding Issues

Non-blocking findings from the L3a code review (no CRITICAL/HIGH). Recorded per the coordinator loop.

### L3a — Traderton REST client + config + signer
- **M1 (deferred to L3e):** the signer parity test replicates the verifier algorithm inline rather than importing the real `@traderton/boundary` `buildCanonicalString` (the sibling package is not workspace-resolvable). Risk: silent drift if Traderton changes its algorithm. Mitigation: add a shared frozen test vector (fixed method/path/timestamp/body/secret → expected signature) copied from a Traderton unit-test vector during L3e's differential/staging step so both repos assert the same literal.
- **M2 (FIXED):** `signStatus` hard-coded a 30s fallback deadline — extracted to the named constant `STATUS_DEADLINE_FALLBACK_MS` in `sign.ts`.
- **M3 (clarity, non-defect):** `poll()` `remaining <= 0` branch uses `continue` and relies on the next iteration's deadline check to exit; at most one extra iteration, cannot hot-spin. Consider restructuring so the deadline check and the "no time left" case share one exit. Address opportunistically (likely in L3c when poll is wired to `submit_decision`).
- **L1 (style):** `poll()` does not explicitly narrow the `in_progress` state after the `terminal` check. Safe today (closed two-state union); an explicit `else if`/exhaustive check would be more defensive.
- **L3 (style):** `contract.ts` `TradertonActorType` intentionally duplicates the domain actor types to keep the wire-contract mirror decoupled; add a one-line comment noting the intentional duplication.

### L3a — cross-repo reviewer verification (2026-09-10, traderton-side review)
Reviewed from the **traderton** repo (which holds the boundary + the 005 verifier), so a check the
herobids-side tests structurally cannot do was possible:
- **Signer byte-parity PROVEN.** Computed a signature for a fixed vector (method/path/timestamp/body/
  secret) using BOTH the herobids signer algorithm (`apps/worker/src/traderton/sign.ts`
  `buildCanonicalString`+HMAC) AND the traderton verifier algorithm
  (`traderton/packages/boundary/src/auth.ts` `buildCanonicalString`+HMAC): canonical string identical,
  `sha256=<hex>` signature identical → **BYTE-PARITY CONFIRMED.** This substantially de-risks the
  deferred **M1** (a request signed by herobids passes the traderton verifier today); M1's frozen-vector
  test is still worth adding at L3e to catch *future* drift, but the current algorithm is verified equal.
- **Guardrails held:** traderton was NOT edited during L3a (still `f-m2-rest` @ `b976533`, clean tree);
  herobids changes are confined to `consume-traderton` (`3c4833c3` feat + `edcf0d0e` docs); `main` +
  the stray `watch-summary.js` untouched. (NOTE: the docs still lack an explicit "the herobids agent must
  not edit traderton" guardrail — the agent respected it anyway, but consider stating it.)
- **Client conformance:** the client's envelope + response mapping match the 005 contract as implemented
  in traderton's boundary; `code`+`retryable` are preserved for the L3b/L3c callers. One minor note: in
  `poll()` the deadline-expiry failure synthesizes `deadline.expired` client-side (the boundary didn't
  return it) — sensible, but it conflates "boundary rejected on deadline" with "I stopped polling"; fine
  for now, revisit when poll is wired to `submit_decision` at L3c.
- **Verdict: L3a APPROVED.** No CRITICAL/HIGH. Proceed to L3b on human green light.
