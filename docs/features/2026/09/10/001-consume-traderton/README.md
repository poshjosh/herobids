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
- [x] L3b — rewire the READ path to the client.  ← **DONE** (committed on `consume-traderton`; prompt: `002-l3b-implementer-prompt.md`)
- [ ] **L3c — rewire the SIDE-EFFECTING path.  ← NEXT** (plan: `003-l3c-plan.md`)
- [ ] L3-P1 provision_venue_account (Traderton-side; before L3e) → L3d delete trading packages + `bots` table → L3e differential + staging + merge gate.

## Handoff note (read this — you are picking up mid-project)
This work began in the **traderton** repo (extraction + the M2 REST boundary F, all complete) and
**handed off to here** at the start of L3. **L3a (REST client + signer) and L3b (read path) are DONE**
and committed on `consume-traderton`. **Your next action is L3c** — rewire the side-effecting path per
`003-l3c-plan.md`. Run the loop: investigate → implement → review → test → **pause for the human before
L3d.** Do not skip ahead to deleting trading packages (L3d) or building provisioning (L3-P1, Traderton-side);
the slice order is deliberate (reads before writes; delete last).

**Cross-boundary decisions settled 2026-09-08 (authority: `traderton/docs/CANONICAL-STATE.md` §3.1/§3.2):**
inject **`ownerId`+`actor` ONLY** (Traderton resolves the venue account; nothing else crosses the wire —
D2 corrected); **`pending_approval` is produced pre-boundary in herobids, never crosses the wire** (D3);
**herobids owns NO `bots` table / NO maxBots** — `create_bot`/`start_bot` are boundary-only, Traderton owns
bots + the limit (#4); venue-account provisioning into Traderton is its own later slice (L3-P1, P1).

The full decision record (D1–D5, the repo-of-record/doc-placement plan) is authoritative in the
sibling repo: `traderton/docs/CANONICAL-STATE.md` §3.1 (L3 decisions) + §5.1 (doc placement +
repo-of-record moves to herobids AT CUTOVER — a working-location change; Traderton is NOT absorbed).
Treat CANONICAL-STATE as the source of truth for state/decisions/invariants until cutover.

## Outstanding Issues

Non-blocking findings from the L3a code review (no CRITICAL/HIGH). Recorded per the coordinator loop.

### L3b — rewire the READ path to the client
Non-blocking findings from the L3b code review (no CRITICAL/HIGH).
- **L1 (test style):** read-tool test stubs use `as unknown as ToolContext['botRepo']`. Acceptable in test files (the strict-TS ban targets source), but a typed `Partial<>`/factory would read cleaner. Optional.
- **L2 (style):** `traderton-read.ts` `in_progress` message wording differs slightly from the prompt's suggestion — semantically identical (`errorCode: boundary.in_progress`, retryable non-fault). Fine.
- **L3c CANDIDATE:** `executionConfig` on `TradingToolContext` is now used by zero in-process tools once `get_account_summary` routes over the boundary. Left in place per the L3b scoping correction (§2); safe to drop in L3c/L3d once the boundary is required. `agentRepo`/`riskContractOps` still used by `risk-limits.ts`; `botRepo` still used by the L3c write tools + `resolve_bot`/`watch.ts`/`risk-limits.ts` — all KEPT.
- **Transitional dual-path (intentional):** read tools use the boundary when configured (`baseUrl`+`hmacSecret`+`userId` all present) and fall back to direct-DB otherwise. L3c/L3d remove the fallback + the now-unused fields.

#### L3b — cross-repo reviewer verification (2026-09-10, traderton-side review)
Reviewed from the **traderton** repo (holds the 005 boundary the tools now call). Confirmed independently:
- **Guardrails held:** traderton UNCHANGED (still `f-m2-rest` @ `b976533`, clean); herobids changes
  branch-only (`e99cd62b` feat + `605d6ba6` docs); `main` + `watch-summary.js` untouched.
- **Scoping correction is SOUND (verified):** grepped the L3b-untouched tools — `risk-limits.ts` uses
  `ctx.riskContractOps`, `resolvers.ts` uses `ctx.botRepo`, `watch.ts` uses `ctx.botRepo`. Removing those
  `ToolContext` fields in L3b WOULD have broken them, so deferring field-removal to L3c/L3d is correct
  sequencing, not scope-dodging. The diff confirms L3b is add-only (849 insertions, 6 deletions).
- **Boundary-vs-fallback branching CORRECT:** each rewired tool checks `ctx.tradertonBoundary` first
  (REST via the shared `traderton-read.ts` mapper); the ORIGINAL direct-DB path remains fully intact
  below (not a stub) → boundary-unconfigured deployments behave exactly as herobids-today (parity).
- **Layering clean:** domain gets a structural port (no worker/HMAC/HTTP leak); the adapter binds the
  subject VALUES + deadline and holds the client — **the HMAC secret never reaches a tool** (ports-carry-
  values honored consumer-side). The mapper preserves `code`+`retryable` and derives `fault` sensibly
  (content-level codes → non-fault, so they don't trip the tool circuit breaker).
- **Parity nuance to confirm at L3e (LOW, not blocking):** the direct-DB `get_account_summary` can
  *partially succeed* (returns `success:true` + `warnings` when risk-contract/agent-config are
  unavailable); the boundary path is all-or-nothing (Traderton assembles the whole summary). Same `data`
  shape, different failure granularity. Almost certainly fine (Traderton now owns the summary), but the
  **L3e differential should assert the two paths agree** rather than assume it.
- **Verdict: L3b APPROVED.** No CRITICAL/HIGH. Proceed to L3c on human green light.

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
