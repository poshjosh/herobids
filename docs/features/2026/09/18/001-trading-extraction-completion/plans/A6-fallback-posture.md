# Plan A6: Transitional fallback posture — boundary-first completion vs availability shims

- **Task:** A6 — decide, per fallback, whether to complete the boundary-first posture (delete the local path) or consciously keep it as an availability shim
- **Repo:** herobids
- **Status:** PLAN — no implementation authorized. **Decision required: YES (small, per item)** — options + recommendation per fallback below.
- **Defect class:** Inconsistent posture (audit tier 3 / §8-Q5).

## Context

The extraction's declared posture is **boundary-first, fail-closed** — nearly every trading read/write enforces it. Four transitional paths still route around the boundary. Each is defensible as an availability shim or as leftover migration scaffolding; the current state is that they exist *undecided*, which is the worst option. This plan pre-loads a per-item decision so the chat can settle them quickly.

One structural dependency: **A3's outcome changes A6-item-4**. If A3 lands Option 1 (boundary serves risk reads), the in-process `get_risk_limits` fallback should be deleted; if A3 lands Option 2, the fallback is load-bearing and must be *promoted* to the documented behavior. Sequence A6 after A3's decision.

## The four fallbacks — options & recommendations

### 1. `list_watches` local-Redis fallback (`agent.ts` `loadActiveWatches`/`loadRawActiveWatches` + `tools/watch.ts`)

Boundary `list_watches` first; on absence/error falls back to the legacy local Redis hash `agent:watches:{agentId}` — the same store the migrated `watch_token` no longer writes (writes are boundary fail-closed). The fallback can therefore only ever serve **stale** pre-migration data, never fresh.
- **Option keep:** protects tick-gating/watch summaries if the boundary blips.
- **Option delete (RECOMMENDED):** the fallback is a stale-data trap — silently feeding the LLM and the tick gate watches that no longer update. Fail-closed is strictly more honest.
- Blast radius if deleted: tick-gate watch digest unavailable when boundary down (tick degrades, does not break); `resolve_watch` (below) loses its store.

### 2. `resolve_watch` / `resolve_task` local-Redis resolution (`tools/resolvers.ts`)

Resolves fuzzy IDs against the same legacy hash (and a task store).
- **Option keep:** fuzzy-ID convenience for the LLM.
- **Option delete (RECOMMENDED):** resolution should use the boundary's current watch list (list_watches → in-app substring match, exactly like `resolve_bot` does against boundary `list_bots`). Deleting the legacy hash read makes `resolve_watch` *correct* rather than removing it. `resolve_task` has no boundary counterpart — verify task tools still exist; if tasks are platform-local (not trading), move that resolver out of scope here.
- Blast radius: none if re-pointed to boundary list; the two tools remain LLM-visible.

### 3. Exit-price reconstruction in `capabilities/trading` positions route (`routes/capabilities/trading.ts`)

In-app O(positions×fills) scan over boundary fills to reconstruct exitPrice — parity with an old DB correlated subquery.
- **Option keep:** zero server-side change; UI parity today.
- **Option move to traderton (RECOMMENDED, but defer to B-track):** exitPrice is a *derivable trading fact*; the natural owner is the boundary read (a `get_agent_positions` enhancement or a derived field). Until B decides where derived trading reads live, **keep as-is** — record as a B4-adjacent candidate, don't churn it in Track A.
- This is the one item where the recommendation is **keep for now** — it is working, boundary-sourced, and its end-state is genuinely decision-dependent.

### 4. In-process `get_risk_limits` read fallback (`tools/risk-limits.ts:30+`)

Routes boundary-first; falls back to `ctx.riskContractOps` (in-process read of `agents.capital/risk/overrides`).
- **RESOLVED (2026-09-18) — DELETE the fallback.** A3 decided Option X: the boundary now serves real risk reads (`get_risk_limits`/`get_account_summary`) from the payload-sourced `RiskSource` seam. So the in-process fallback is redundant and becomes a split-brain trap (consumer reads its own numbers while traderton enforces from the same payload) — delete it, fail closed when the boundary is absent, consistent with the adjust-write posture. Sequence after A3.

## Steps (post-decision)

1. Record the four outcomes in this plan's decision log (chat transcript link).
2. Implement deletions/re-pointings per outcome; boundary-first fail-closed messaging aligned with existing `mapReadResultToToolResult` codes.
3. Tests: delete-fallback tests for watch tools; re-point test for `resolve_watch` (boundary list → match); no changes for item 3 if kept.
4. Audit doc §2 rows for `tools/watch.ts`/`resolvers.ts`/`risk-limits.ts` updated (fallback column cleared or marked "documented shim").

## Verification

- Full herobids suite; live cross-stack (A8 gate): with boundary up, watches/resolvers behave identically (regression check); with boundary down, watch reads fail closed with typed codes (manual fault-injection during gate run).

## Risks

- Deleting the watch fallback changes tick-gate behavior when the boundary is down — verify the gate treats "watches unavailable" as digest-absent (it does per code reading) rather than erroring.
- `resolve_task` scope check must not accidentally delete platform task tooling — confirm task stores are non-trading first.

## References

- Audit §2 rows (`tools/watch.ts`, `tools/resolvers.ts`, `tools/risk-limits.ts`), §6, §8-Q5
- `agent.ts:787-845` (watch loads), `tools/watch.ts` (`list_watches`), `tools/resolvers.ts`, `routes/capabilities/trading.ts`
