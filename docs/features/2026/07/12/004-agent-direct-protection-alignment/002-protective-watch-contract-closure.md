# Protective Watch Contract Closure

**Status:** Done  
**Created:** 2026-07-12

**Related reports and plans:**

1. [Agent-direct protection alignment](./001-plan.md)
2. [Watch system redesign follow-up](../../../07/07/002-watch-system-redesign/002-followup-plan.md)
3. [Bug report: agent-direct protection identity and watch linkage](../../../../../bug-reports/2026/07/12/002-agent-direct-protection-identity-and-watch-linkage.md)

## Goal

Close the remaining implementation gaps left after shipping [001-plan.md](./001-plan.md), specifically the parts that still prevent the runtime from fully satisfying:

1. worker-owned protective-watch linkage
2. canonical identity-only matching for protected positions
3. a single supported structured watch contract at runtime

The immediate outcome should be:

1. no protective auto-link success based on symbol heuristics
2. no parser repair path that silently upgrades malformed structured watches
3. one end-to-end contract from `watch_token` creation through persistence, monitor, and coverage evaluation

This is a narrow closure plan. It does not reopen the already-shipped work on native exit-level coverage, agent-direct `instrumentId` preservation, or truthful `list_positions` payloads.

---

## Summary

The July 12 implementation shipped most of the required protection-alignment behavior, but two verified gaps remain:

1. `watch_token` still retries protective auto-linking by `venue + symbol` when canonical `instrumentId` matching fails.
2. `parseWatch()` still defaults a missing `purpose` to `alert`, preserving a compatibility mode for malformed structured records.

Those two gaps matter because they keep the runtime in a partially transitional state:

1. protective linkage is mostly worker-owned, but not strictly canonical
2. persisted watches are mostly single-shape, but the parser still repairs some invalid records into validity

The minimum correct fix is to remove both fallback behaviors rather than layering more checks around them.

---

## Current Verified Gaps

### 1. Protective auto-link still has a symbol fallback

Current state:

1. [apps/worker/src/tools/watch.ts](../../../../../apps/worker/src/tools/watch.ts) first tries to auto-link protective watches by exact `venue + instrumentId`.
2. If that returns zero matches, it retries by `venue + symbol`.
3. A current test explicitly asserts this fallback success path.

Why this is still wrong:

1. it reintroduces the same-symbol heuristic that the follow-up redesign was supposed to remove from normal protected-position behavior
2. it allows protective success in cases where canonical identity disagreement should instead force explicit disambiguation
3. it makes creation-time linkage less strict than coverage-time matching, which is already canonical

### 2. Structured-watch parsing still repairs malformed records

Current state:

1. [apps/worker/src/watch-types.ts](../../../../../apps/worker/src/watch-types.ts) requires `schemaVersion >= 2`.
2. The same parser still treats `purpose` as optional and defaults missing `purpose` to `alert` after parse.
3. Current tests explicitly cover and expect that repair behavior.

Why this is still wrong:

1. it keeps a runtime compatibility branch alive after the codebase already declared the structured shape as the only supported model
2. it hides malformed persisted data instead of failing loudly
3. it means the runtime contract is still “structured shape plus parser forgiveness”, not one actual persisted shape

### 3. Tests still encode transitional semantics

Current state:

1. the watch-tool suite still asserts symbol-fallback success for protective auto-linking
2. the watch-types suite still asserts missing-purpose repair
3. several test names still describe these behaviors as backward compatibility

Why this matters:

1. the tests currently protect the exact behavior that needs to be removed
2. future maintainers will read those tests as intended steady-state semantics unless they are rewritten

---

## Desired Outcome

After this follow-up:

1. protective auto-link succeeds only when the worker can prove canonical identity from live runtime data
2. when that proof is unavailable, the request fails with an actionable error directing the caller to `coverage.targetPosition`
3. coverage evaluation and watch creation both rely on the same canonical contract
4. malformed structured watch records are discarded rather than repaired into validity
5. the remaining tests describe one steady-state watch contract, not a transitional compatibility mode

---

## Scope

In scope:

1. removing protective symbol-fallback auto-link behavior
2. making `purpose` mandatory for supported persisted structured watches
3. removing parser repair for missing `purpose`
4. updating tests and wording to reflect the strict canonical contract

Out of scope:

1. further changes to native exit-level coverage or scout/judge semantics
2. venue-native stop-order support
3. a one-time Redis migration or cleanup command for old watch records
4. broader watch-stack simplification beyond the remaining gaps verified here

---

## Product Decisions And Implementation Defaults

### Decisions encoded by this plan

1. **Protective success must be canonical-only.**
   For `stop_loss`, `take_profit`, and `exit`, the worker may only auto-link when canonical live-position identity is proven. Prompt-facing symbol text is not sufficient.

2. **Explicit target resolution remains the escape hatch.**
   When canonical instrument lookup and automatic matching are insufficient, the caller must provide `coverage.targetPosition` so the worker can resolve the intended open position directly.

3. **Write-time defaults are acceptable; parse-time repair is not.**
   The tool may continue defaulting omitted new-watch purpose to `alert` before persistence. The runtime parser should not silently repair already-persisted malformed records.

4. **Rejecting malformed records is preferable to masking them.**
   If an old persisted record does not meet the supported structured contract, the runtime should discard it and log the failure rather than reinterpret it.

### Default implementation direction

1. prefer a narrow change in `tools/watch.ts` over a broader redesign of watch creation
2. prefer stricter parser validation in `watch-types.ts` over a Redis migration
3. keep non-protective monitoring behavior unchanged unless it directly conflicts with the canonical protective contract

---

## Why This Approach

### Chosen approach

The smallest change that truly closes the gaps is:

1. remove protective auto-link symbol fallback
2. require `purpose` on all supported structured watches at parse time
3. delete the tests that currently encode those fallback semantics as desired behavior

This works end to end because:

1. watch creation becomes as strict as coverage evaluation
2. persisted protective watches always carry worker-derived linkage or fail before write
3. runtime parsing stops mutating malformed records into valid ones

### Alternatives considered and rejected

1. **Require `coverage.targetPosition` for every protective watch.**
   Rejected because it is stricter than necessary. Exact `instrumentId` auto-link is already safe and useful.

2. **Keep symbol fallback when it resolves to exactly one open position.**
   Rejected because uniqueness in one snapshot is still heuristic, not canonical identity.

3. **Add more alias-normalization logic before removing fallback.**
   Rejected because that is a larger redesign. The minimal correct move is to fail closed and require explicit target resolution when canonical identity does not line up.

4. **Keep parser repair indefinitely for old records.**
   Rejected because it keeps a mixed contract alive and hides malformed state that should be visible.

5. **Perform a one-time migration of old Redis watches as part of this feature.**
   Rejected because it is not required for correctness. Rejecting unsupported records on read is sufficient for this closure.

---

## Likely Repo Surfaces

| Area | Likely files |
|---|---|
| Protective auto-link hardening | `apps/worker/src/tools/watch.ts` |
| Structured watch parsing | `apps/worker/src/watch-types.ts` |
| Watch tool tests | `apps/worker/src/tools/watch.test.ts` |
| Watch parser tests | `apps/worker/src/watch-types.test.ts` |
| Focused validation | existing worker vitest suites |

---

## Implementation Plan

### Slice 1 — Remove protective symbol fallback from auto-linking **[DONE]**

Goal: ensure that protective auto-link success depends only on canonical live-position identity.

Tasks:

1. update [apps/worker/src/tools/watch.ts](../../../../../apps/worker/src/tools/watch.ts) so protective auto-link first attempts exact `venue + instrumentId` matching and does not retry by symbol if that returns zero matches
2. keep the current success path when exactly one canonical live-position match exists
3. if exact canonical matching fails, return an actionable error telling the caller to provide `coverage.targetPosition`
4. keep the existing explicit `coverage.targetPosition` resolution path as the worker-owned disambiguation mechanism
5. keep non-protective watch behavior unchanged unless a small wording cleanup is needed

Expected result:

Protective auto-link either proves canonical linkage and persists a worker-derived `coverage.positionKey`, or fails closed without any symbol-only success path.

### Slice 2 — Finalize the structured watch parser contract **[DONE]**

Goal: remove the remaining runtime compatibility repair for malformed structured watches.

Tasks:

1. update [apps/worker/src/watch-types.ts](../../../../../apps/worker/src/watch-types.ts) so `purpose` is required in the supported persisted watch schema
2. remove the post-parse repair that defaults missing `purpose` to `alert`
3. leave write-time defaulting in [apps/worker/src/tools/watch.ts](../../../../../apps/worker/src/tools/watch.ts) intact so newly created watches still persist a valid `purpose`
4. preserve malformed-record logging so discarded records remain diagnosable

Expected result:

The runtime supports one structured persisted watch shape only: `schemaVersion >= 2` plus required semantic purpose and existing structured fields.

### Slice 3 — Rewrite tests to lock the final contract **[DONE]**

Goal: make the test suite enforce the intended steady-state semantics.

Tasks:

1. update [apps/worker/src/tools/watch.test.ts](../../../../../apps/worker/src/tools/watch.test.ts) so the current symbol-fallback success case becomes a rejection case
2. keep or add a success test for exact canonical `instrumentId` auto-link
3. update [apps/worker/src/watch-types.test.ts](../../../../../apps/worker/src/watch-types.test.ts) so missing `purpose` is rejected instead of repaired
4. rename or remove test titles that describe the removed behaviors as backward compatibility when they are no longer intended
5. add one focused end-to-end test proving that omitting `purpose` at tool input still persists `purpose: 'alert'` and therefore still parses cleanly afterward

Expected result:

The tests protect the final contract rather than the transitional behavior that this follow-up removes.

---

## Validation Plan

### Automated

1. `apps/worker/src/tools/watch.test.ts`
2. `apps/worker/src/watch-types.test.ts`
3. any focused worker suites that cover watch-trigger monitoring or coverage evaluation if touched indirectly
4. `pnpm --filter @herobids/worker run test`
5. `pnpm lint`

### Manual review checks

1. confirm every successful protective watch write now has either canonical instrument identity or worker-derived `coverage.positionKey`
2. confirm no code path silently converts a persisted structured watch with missing `purpose` into `alert` at read time
3. confirm error messages direct callers toward `coverage.targetPosition` when canonical auto-link proof is unavailable

---

## Exit Criteria

1. protective auto-link no longer retries by symbol after canonical match failure
2. protective watch creation succeeds only on proven canonical linkage or explicit live-position resolution
3. `parseWatch()` no longer repairs missing `purpose`
4. supported persisted structured watches require `purpose`
5. watch tool and watch parser tests reflect the strict single-contract design
6. focused worker tests and lint pass

---

## Open Questions

1. Should the new protective auto-link failure text mention the resolved `instrumentId` mismatch explicitly to help debugging alias issues?
2. Do we want a later operator tool to scan Redis for malformed watches, or is discard-and-log sufficient for now?
3. Should non-protective `coverage.targetPosition` with no live match continue deriving a best-effort `positionKey`, or should that also become strict in a later follow-up?