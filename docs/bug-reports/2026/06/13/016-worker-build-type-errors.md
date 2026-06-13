# 016 — Worker Build Type Errors

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-13
- **Summary:** `apps/worker` failed to build due to two TypeScript type incompatibilities.

## Root Cause

Two type mismatches in the worker package:

1. **`agent-message-broker.ts:856`** — The local type annotation for `positions` declared `actorId: string`, but `BotRepository.getOpenPositionsByCreator()` returns rows from the `positions` table where `actorId` is `text('actor_id')` (nullable in the DB schema), yielding `actorId: string | null`.

2. **`agent.ts:1209`** — `buildToolResultMetadata()` returns `ToolResultMetadata | undefined`, but `emitToolResultEvent` expects `metadata?: Record<string, unknown>`. The `ToolResultMetadata` interface lacked an index signature, making it incompatible with `Record<string, unknown>`.

## Fix

1. Changed the local type in `agent-message-broker.ts` to `actorId: string | null` to match the repository return type.
2. Added `[key: string]: unknown` index signature to `ToolResultMetadata` interface so it satisfies `Record<string, unknown>`.

## Files Changed

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/tool-result-metadata.ts`

## Verification

`pnpm build` completes successfully with no errors.
