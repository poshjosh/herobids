# Bug Report: Positional `db.select()` Test Mocks Silently Break When a Route Handler Gains a New Query

- **Status:** OPEN (three known instances patched; underlying pattern is unfixed and will recur)
- **Severity:** Medium
- **Date:** 2026-07-14
- **Discovered By:** Fixing agent execution-mode code review findings (adding a `hasAgentConnections` lookup and a `validateConnectionRequirement` check to the agent create/PATCH/PUT write paths)
- **Summary:** Several route test files hand-roll a `db.select()` mock keyed by a manually incremented counter (`selectCount`) instead of the table-keyed `buildDb()` helper. Adding, removing, or reordering a `db.select()` call anywhere earlier in the handler silently shifts every subsequent stage, producing confusing, unrelated-looking assertion failures (e.g. `"Unknown skillIds: task-management"`) instead of a clear signal that the mock is out of sync.

## Observed Behavior

While adding a new `db.select({ id: agentConnections.id }).from(agentConnections)...` lookup (`hasAgentConnections`) partway through the `PUT /agents/:id` and `PATCH /agents/:id` handlers, three previously-passing tests started failing with `400` instead of `200`:

- `apps/api/src/routes/agent-interactivity.test.ts` → `PUT /agents/:id > clears execution mode when trading skills are removed on PUT`
- `apps/api/src/routes/agent-interactivity.test.ts` → `PUT /agents/:id > preserves an already-assigned non-selectable skill when updating unrelated fields`
- `apps/api/src/routes/agents.skill-preservation.test.ts` → `agent routes skill preservation > allows PATCH to preserve an already-assigned non-selectable skill while updating unrelated fields`

The failure bodies reported `Unknown skillIds: task-management` / `Unknown skillIds: paid-skill` — errors from `resolveSkillAssignmentsForUser`, a completely different code path from the one being changed. Nothing in the diff touched skill validation, which made the root cause non-obvious until the mock's call-order assumptions were traced by hand.

## Root Cause

These three tests mock `db.select` like this:

```ts
let selectCount = 0;
const db = {
  select: vi.fn().mockImplementation(() => {
    selectCount++;
    if (selectCount === 1) return makeChain([agentRow]);
    if (selectCount === 2) return makeChain([existingSkillIdsRow]);
    if (selectCount === 3) return makeChain([skillMetadataRow]); // ← assumed stage
    if (selectCount === 4) return makeChain([]); // entitlements
    if (selectCount === 5) return makeChain([]); // revisions
    if (selectCount === 6) return makeChain([existingAgentSkillsRow]);
    if (selectCount === 7) return makeChain([updatedAgentRow]);
    return makeChain([fallbackRow]);
  }),
  // ...
};
```

The mock is **positional, not table-aware** — it returns whatever data the author decided belongs at call N, based on the handler's call order *at the time the test was written*. It has no way to verify that call N is actually the query the author intended.

When a new `db.select(...)` call was inserted into the handler (the `hasAgentConnections` lookup, between the existing-skill-ids query and the skill-metadata query), every stage from that point on shifted by one:

- Stage 3 (intended: skill metadata row) received the *old* stage-2 data shape at the *new* stage-3 position was actually consumed by the connections lookup, and the skill-metadata query landed on stage 4 — the `[]` originally meant for entitlements. `skillById` ended up empty, so `resolveSkillAssignmentsForUser` reported the skill as unknown.

Because the mock doesn't check *which table* is being queried, this shift produces no type error, no lint error, and no obvious signal — it manifests as an assertion failure in a seemingly unrelated part of the response.

By contrast, `apps/api/src/routes/agents.test.ts` uses a table-keyed `buildDb()` helper (`rowsForTable(table)` switches on `table === agents`, `table === agentConnections`, etc.) that is immune to this class of regression — call order doesn't matter, only which table is queried.

## Fix (applied to the three known instances)

For each affected test, inserted a new numbered stage at the correct position (immediately after the existing-skill-ids lookup, matching where `hasAgentConnections` now queries `agentConnections`) and renumbered all subsequent stages:

- `agent-interactivity.test.ts:312` and `:442` — inserted stage 3 returning `[]` (no active connections), shifted stages 3–7 to 4–8.
- `agents.skill-preservation.test.ts:62` — inserted stage 3 returning `[]`, shifted stages 3–8 to 4–9.

All three tests pass again with correct semantics (not just a green checkmark obtained by guessing numbers — the inserted stage matches what the handler now actually queries at that position).

## Residual Risk / Why This Is Still Open

The underlying pattern is unchanged: these two test files still mock `db.select` positionally. **Any future change that adds, removes, or reorders a `db.select()` call anywhere in the `PUT /agents/:id` or `PATCH /agents/:id` handlers before the skill-assignment or connection-sync logic will silently break these tests again**, with the same misleading "unknown skillIds" style failure pointing away from the actual change.

This is not limited to agents — any other route test file using the same `selectCount` pattern carries the identical risk.

## Recommended Follow-up

1. Migrate `agent-interactivity.test.ts` and `agents.skill-preservation.test.ts` to the table-keyed `buildDb()` pattern from `agents.test.ts` (or extract it into a shared test helper both files can import), eliminating call-order sensitivity entirely.
2. Until migrated, when adding/removing a `db.select()` call to `agents.ts` PUT/PATCH or `agent-interactivity.ts` PUT:
   - Grep the corresponding test file for `selectCount` to find hand-rolled positional mocks.
   - Map the exact call order in the handler (including helper functions like `listSkillIdsForAgent`, `resolveSkillAssignmentsForUser`, which each make 1–3 selects) to determine which stage must shift.
   - Insert the new stage at the correct position and renumber all subsequent stages — do not just append at the end.
3. Consider a lint/test-authoring guideline discouraging new positional `selectCount` mocks in favor of the table-keyed pattern for any future route test file.

## Verification

- `pnpm lint` passes.
- `npx vitest run apps/api apps/web` — 81 test files passed, 1160 tests passed (133 pre-existing skips unrelated to this change).
