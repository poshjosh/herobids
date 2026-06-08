# 010 — Rename `tradingInstanceId` → `botId`

## Status
`done`

## Goal
Align internal field names with the published domain language. `tradingInstanceId` is an implementation detail that leaked into domain interfaces. The canonical user-facing term is `botId`.

## Scope

Full file list from `009-re-assessment/000-current-state.md`:

| File | Change |
|---|---|
| `packages/domain/src/models/decision.ts` line 16 | Rename field `tradingInstanceId` → `botId` |
| `packages/domain/src/agent-protocol.ts` line 23 | Rename field |
| `packages/engine/src/planner.ts` lines 15, 215 | Rename field + usages |
| `packages/engine/src/journal.ts` | Rename parameter in 8 event-builder functions |
| `packages/engine/src/paper-executor.test.ts` lines 21, 153, 159 | Update test fixtures |
| Callers in `packages/engine/`, `apps/worker/` | Update all references |

## Acceptance criteria

- [ ] `grep -r "tradingInstanceId" packages/ apps/worker/` returns zero results
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (no new failures)

## Notes

- This is a pure rename — no logic changes.
- Do not rename the database column in this pass (that requires a migration with a rename + backfill). Only rename TypeScript field names and runtime usage.
- If a DB column rename is needed, create a separate migration task and track it here.
