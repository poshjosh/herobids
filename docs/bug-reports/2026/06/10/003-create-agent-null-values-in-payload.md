# Bug Report 003 — Create Agent Sends Null Values for Optional Fields

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-10
- **Summary:** `POST /agents` returned 400 ("Expected string, received null") because `AgentsPage.tsx` sent `null` for optional optional fields (`costPreset`, `telegramChatId`, etc.) and for model fields (`provider`, `lightModel`, `heavyModel`). The API schema uses `.optional()` (accepts `undefined`) not `.nullable()` (accepts `null`).

## Root Cause

Two issues:
1. Optional configuration fields like `costPreset`, `capital`, `dailyLossLimit`, etc. were set to `null` when empty: `costPreset: intent.costPreset || null`. The Zod schema used `.optional()` which accepts `undefined` but not `null`.
2. `resolveCreateAgentModelPayload()` returned `{ inherits: false, provider: null, lightModel: null, heavyModel: null }` when no models were selected (all empty strings). The API rejected these null values.

## Fix

1. In `AgentsPage.tsx`: Changed optional field assignments from `field: value || null` to conditional spread `...(value ? { field: value } : {})`.
2. In `AgentsPage.tsx`: Only spread model fields when `modelPayload.provider` is non-null.
3. In `create-agent-models.ts`: Added early return `{ inherits: true }` when `selection.provider` is empty (no model selection = inherit operator defaults).

## Files Changed

- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/create-agent-models.ts`

## Verification

E2E journeys 1, 4, 7, 8 now pass. Agent creation no longer shows "Expected string, received null" error in the UI.
