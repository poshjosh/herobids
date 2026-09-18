# Plan A1 (+A2): Ensure-cache crash recovery & concurrent-reconstruction race

- **Task:** A1 — ensure-cache fast path trusts a possibly-stopped actor · A2 — concurrent-reconstruction race
- **Repo:** traderton (`packages/boundary/src/bin.ts`)
- **Status:** PLAN — no implementation authorized. Decision-gated: **No** (defect fix).
- **Defect class:** Stability defect in shipped fix (commit `6cb07d6`, bug-reports/2026/09/17 #001 phases 2–3).

## Context

`buildAgentDirectActorEnsure` (bin.ts:100–235) lazily constructs + starts the agent-direct `AgentTradingActor` per `(ownerId, actorId, venueAccountId)`, caching the ensure promise. Two defects:

**A1 — crash makes the failure permanent.** On a cache hit with an unchanged risk spec, the fast path awaits the cached promise and returns — never re-checking liveness (`bin.ts:138-153`). The actor's `onCrashed` hook (decision-intake.ts, `constructAndRegisterAgentActor`) deregisters it from `runtime.actorRegistry`, but **nothing evicts the ensure-cache entry**. Consequence: one actor crash → every subsequent `submit_decision` for that agent fails `instance_not_running` **until the boundary process restarts**. This reintroduces, via the cache, the exact failure mode the fix was meant to remove.

**A2 — concurrent reconstruction race.** On a spec change, the code deletes the cache entry, then the `ensure` IIFO stops+reconstructs the actor across awaits. A concurrent invocation (the LLM submits 2–3 decisions per tick — observed live: SOL+ZEC+HYPE in one tick) that arrives mid-teardown finds no cache entry and starts a **second rebuild against a half-torn-down actor**. The `ensureCache.set` after the IIFO cannot dedupe the window because the second caller checked before the first re-set.

## Approach (recommended)

Single surgical change set in `bin.ts`:

1. **A1 fix:** in the cache-hit fast path, after `await existing.ensure`, check `runtime.actorRegistry.get(injection.actorId)?.isRunning`; if falsy, fall through to the reconstruct path (evict + rebuild). This also covers "stopped by any other path" (not just crash).
2. **A2 fix:** make reconstruction single-flight. Replace delete-then-rebuild with: keep the cache entry keyed, store the in-flight promise *before* any teardown begins (set the new entry synchronously at branch entry), and have concurrent callers await whatever entry is current. Concretely: compute the new `ensure` promise and `ensureCache.set(key, …)` it **before** `await`ing any stop inside the IIFO body (the IIFO already defers execution to first await; re-order so the set happens first, or wrap the whole reconstruct in a per-key "rebuild token" — simplest: set the cache entry synchronously in the branch, and inside the IIFO perform stop→construct→start).
   - Ordering already correct inside the IIFO (stop old before registering new — preserved).
   - Failed reconstruction keeps the existing eviction (`ensureCache.delete(key)` in the catch) so the next attempt retries fresh.
3. Add a **stale-spec guard**: if the awaited cached entry's recorded spec differs from the *current* invocation's spec after all (late-arriving change), the existing diff logic already handles it on the next call — no extra work, but note it in tests.

## Tests (to write when implementation is authorized)

- Unit-level: extract the ensure into a testable factory seam if needed (or test via `TradingRuntime` fakes as `boundary.verification.integration.test.ts` does):
  1. cache hit + actor running → no reconstruct (fast path intact).
  2. cache hit + actor deregistered (simulate `onCrashed`) → reconstructs, decision succeeds.
  3. cache hit + actor stopped-not-crashed → reconstructs.
  4. concurrent invocation during reconstruction → exactly ONE stop+construct+start sequence (assert via construct-spy count).
  5. reconstruction failure → cache evicted → next invocation retries (existing behavior, pin it).
- Regression tie-in: extend the A1 test to assert the boundary log line `agent-direct actor constructed + started` appears exactly once per rebuild.

## Verification

- `npx tsc --noEmit -p packages/boundary` (root `pnpm lint` has a build-cache blind spot — per-package always).
- Full traderton suite green; then live cross-stack run (with A4/A3 if co-scheduled, else alone) confirming decisions still execute after a simulated actor crash (manual: deregister the actor in-container, submit again, expect recovery).

## Risks

- Minimal: the change is confined to the ensure; the reconstruct path is already exercised live. Biggest risk is over-engineering the single-flight — keep it to cache-entry ordering, no mutex machinery.

## References

- `packages/boundary/src/bin.ts:100-235` (ensure), `:138-153` (fast path)
- `packages/worker/src/composition/decision-intake.ts` (`onCrashed` dereg hook; guards at :104-121)
- Evidence: this chat session 2026-09-18 re-verification against HEAD `6cb07d6`.
