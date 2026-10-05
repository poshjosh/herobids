# Bug 004 — Backend-approved skill tools wiped on every tick by a stale tool-visibility baseline

- **Status:** FIXED (code; not yet deployed)
- **Severity:** High
- **Date:** 2026-10-05
- **Summary:** Even when MCP `tools/list` discovery succeeds at agent start, the first tick resets the external trading skill's tools to `[]`, so `get_account_summary`, `get_risk_limits`, `submit_decision` etc. are rejected with `tool rejected: <tool> is not available in the current skill set`.

> Supersedes the first draft of this report, which blamed a missing `venueAccountId` on the read path. That was wrong: on the failing runs the agent never reached the boundary (see 007 for the separate payload observation). Related: 005 (staging MCP route off), 006 (portfolio block never populated), 007 (empty read payload contract).

## Evidence

- Local (docker compose, agent `73f2ac55`): discovery logged `toolCount: 18` for `traderton/skills/crypto-trading`; tick 1 then logged `Tool not in active skill set — ignoring` for `get_account_summary`, `get_risk_limits`, `get_market_overview` (15:55:37). The same call succeeded at 15:56:46, after a skills hot-reload (15:56:10, crypto-trading 18 + crypto-bot-management 9) rebuilt the descriptor.
- Staging DB: `skill_revisions.required_tools = {}` for all three `traderton/skills/*` external skills, so their DB baseline is empty.

## Root Cause

`createRuntimeToolVisibilityController` snapshots each skill's `requiredTools` as a baseline and only re-snapshots when the descriptor **object** changes. `main()` assigns the discovered skills onto the **same** descriptor (`runtimeState.runtimeDescriptor.resolvedSkills = await resolveBackendApprovedSkills(...)`) and never re-snapshots. Every tick starts with `refreshToolCircuits() → applyToolVisibility()`, which rewrites each skill's `requiredTools` from the stale (empty) baseline. The `onSkillsChanged` and `config_update` paths build a new descriptor and re-snapshot, which is why a later `add_skills`/`remove_skills` accidentally recovered.

The rejection itself is herobids' own gate (`apps/worker/src/agent.ts`, `executeTool`), not a separate image.

## Fix

- `runtime-tool-visibility.ts`: `snapshotToolBaselines()` also re-snapshots when the descriptor's `resolvedSkills` array was replaced (not only the descriptor object).
- `agent.ts` `main()`: call `toolVisibility.snapshotToolBaselines()` + `applyToolVisibility()` right after startup discovery. (Calling `snapshotToolBaselines()` alone would have been a no-op under the old identity check.)

## Files Changed

- `apps/worker/src/runtime-tool-visibility.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/runtime-tool-visibility.test.ts`

## Verification

- New test `keeps backend-discovered tools across ticks when resolvedSkills is replaced on the same descriptor` fails on the old controller, passes on the fix.
- `pnpm lint`, `pnpm build`, worker suite (2988 passed) green.
- Not yet verified live: rebuild the agent image and confirm tick 1 calls `get_account_summary` successfully on local. Staging additionally needs 005.
