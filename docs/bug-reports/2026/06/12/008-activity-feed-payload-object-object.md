# 008 — Activity feed shows "payload: [object Object]" in expanded detail view

**Status:** CLOSED
**Severity:** Low
**Date:** 2026-06-12

## Summary

In the agent activity timeline (expanded detail view), the `payload` detail entry rendered as `payload: [object Object]` instead of showing the actual payload contents.

## Root Cause

`AgentActivityTimeline.tsx` renders all `entry.detail` key/value pairs via a formatter that previously used `String(value)` directly. The `mapProtocolMessage` function in `agent-activity-mapper.ts` includes `payload: row.payload` in the `detail` object, where `row.payload` is a `Record<string, unknown>`. Calling `String()` on a plain object produces `"[object Object]"`.

## Fix

In `AgentActivityTimeline.tsx`, changed the detail row rendering to use `JSON.stringify` for object values while keeping primitive values visible with `String(value)`:

```typescript
// Before
<DetailRow key={key} label={key} value={String(value)} />

// After
<DetailRow
  key={key}
  label={key}
  value={typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}
/>
```

The expanded detail block was also extracted into a pure renderer so the regression test can assert on the actual UI output instead of a duplicated formatter helper.

## Files Changed

- `apps/web/src/features/agents/AgentActivityTimeline.tsx`

## Verification

The `payload` detail field now renders as a JSON string (e.g. `{"toolName":"list_positions","status":"ok"}`) instead of `[object Object]`. Primitive values, including `null` and `undefined`, continue to render as visible strings.
