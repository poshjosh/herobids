# 001 — Session stopped without visible stop reason

**Status:** Fixed  
**Created:** 2026-08-03  
**Fixed:** 2026-08-03 (commit `99efbba8`)  
**Severity:** Medium  
**Category:** UX / Activity Feed

## Summary

When an agent session is blocked by a platform guardrail (e.g., billing `hard_limited`), the user sees a generic *"Session stopped"* / *"Agent runtime shut down gracefully"* message in the activity feed. The actual reason — *"Usage limit reached — agent session start blocked"* — is only logged to worker stdout and never surfaced in the UI.

This makes it impossible for users to understand why their agent stopped without digging through server logs.

## Reproduction

1. Exceed the daily spend budget for a user account (billing status → `hard_limited`).
2. Create and start a trading agent for that user.
3. Open the agent detail page → Activity feed.

**Expected:** The feed shows the reason the session was blocked (e.g., "Daily spend limit reached").

**Actual:** The feed shows only "Session stopped" / "Agent runtime shut down gracefully."

## Root Cause

Two problems converge:

### 1. `mapRuntimeSession` always uses a hardcoded generic summary

**File:** `apps/api/src/routes/agent-activity-mapper.ts:453–462`

```typescript
// Session stopped normally
if (session.status === 'stopped' && session.stoppedAt) {
  entries.push({
    ...
    title: 'Session stopped',
    summary: 'Agent runtime shut down gracefully.',  // ← ALWAYS this, regardless of cause
    ...
  });
}
```

There is no mechanism to pass a `stopReason` into this function, so every stop — whether user-initiated, crash, billing block, health monitor kill, start timeout, or config failure — produces the identical entry.

### 2. The guardrail event exists but isn't surfaced prominently

**File:** `apps/worker/src/agents/agent-session-manager.ts:349–360`

```typescript
await this.eventPublisher.emitGuardrailTriggered(agent.id, {
  scope: 'agent_guardrail',
  code,          // e.g., 'billing.limit_exceeded'
  message,       // e.g., 'Usage limit reached — agent session start blocked'
  details: { ... },
});
```

This guardrail event is published to Redis and eventually persists in the `agent_messages` table. The activity mapper (`agent-activity-mapper.ts:156–161`) maps it to a separate activity entry with title *"Guardrail triggered"* and summary from `errorDetail.message`. However:

- The `eventType` is incorrectly set to `'decision.rejected'` (should be `'guardrail.triggered'`).
- The guardrail entry is a separate item in the feed, easily overlooked next to the more prominent "Session stopped" entry.
- If `errorDetail` is not populated during message processing, the summary falls back to a generic *"A platform guardrail blocked or constrained agent activity."*

### 3. Additional stop causes with the same problem

The same generic "Session stopped" message is shown for every stop cause. For example:

| Stop cause | Location | Message logged but not surfaced |
|---|---|---|
| Billing hard limit | `agent-session-manager.ts:340` | "Usage limit reached — agent session start blocked" |
| Account suspended | `agent-session-manager.ts:338` | "Account suspended — agent session start blocked" |
| Start timeout | `agent-session-manager.ts:989` | "Agent trading context failed while running — session stopped" |
| Init failure | `agent-session-manager.ts:1009` | "Agent trading context failed to initialize — session stopped" |
| User-initiated | API stop endpoint | (no guardrail — genuinely graceful) |

## Proposed Fix

### Approach

Add an optional `stopReason: string | null` field to `RawRuntimeSession` and thread it through the activity feed pipeline. The feed handler cross-references `agent_messages` rows for each session to find any relevant stop reason (guardrail, crash, timeout, etc.). When present, use it as the session-stopped summary instead of the hardcoded generic string.

This is generic (`stopReason`, not `guardrailReason`) — it handles all current and future stop causes without coupling to any specific event type.

### Changes

#### A. `apps/api/src/routes/agent-activity-mapper.ts`

**1. Add `stopReason` to `RawRuntimeSession` (line ~60):**

```typescript
export interface RawRuntimeSession {
  id: string;
  agentId: string;
  status: string;
  lastHeartbeatAt: Date | null;
  cpuPct: number | null;
  memoryBytes: number | null;
  startedAt: Date;
  stoppedAt: Date | null;
  stopReason: string | null;  // ← ADD
}
```

**2. Use `stopReason` in the session-stopped entry (line ~462):**

```typescript
// Session stopped
if (session.status === 'stopped' && session.stoppedAt) {
  entries.push({
    ...
    title: session.stopReason ? 'Session stopped' : 'Session stopped',
    summary: session.stopReason ?? 'Agent runtime shut down gracefully.',
    ...
  });
}
```

**3. Fix `GUARDRAIL_TRIGGERED` eventType (line ~158):**

```typescript
[INSTANCE_MESSAGE_TYPES.GUARDRAIL_TRIGGERED]: {
    category: 'risk',
    severity: 'warn',
    eventType: 'guardrail.triggered',  // ← was 'decision.rejected'
    title: 'Guardrail triggered',
    summaryFn: (row) => {
      if (row.errorDetail?.message) return row.errorDetail.message;
      const p = row.payload as Record<string, unknown> | null;
      if (typeof p?.['message'] === 'string') return p['message'];
      if (typeof p?.['code'] === 'string') {
        const codeMessages: Record<string, string> = {
          'billing.limit_exceeded': 'Daily spend limit reached — top up your account to resume.',
          'billing.top_up_required': 'Usage limit reached — top-up required before agent can start.',
          'billing.account_suspended': 'Account suspended — agent session start blocked.',
        };
        if (codeMessages[p['code']]) return codeMessages[p['code']];
      }
      return 'A platform guardrail blocked or constrained agent activity.';
    },
},
```

#### B. Activity feed handler (the file that builds `RawRuntimeSession` rows)

Add a query that looks up the most recent `agent_messages` row for each session where `error_detail` is not null and the message type indicates a stop reason:

```typescript
// Pseudo-code — the exact implementation depends on the handler file.
const stopReasons = await db
  .select({ sessionId: agentMessages.sessionId, reason: agentMessages.errorDetail })
  .from(agentMessages)
  .where(
    and(
      inArray(agentMessages.sessionId, sessionIds),
      isNotNull(agentMessages.errorDetail),
      inArray(agentMessages.type, [
        INSTANCE_MESSAGE_TYPES.GUARDRAIL_TRIGGERED,
        AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED,
      ]),
    ),
  )
  .orderBy(desc(agentMessages.createdAt));

const reasonBySession = new Map(
  stopReasons.map(r => [r.sessionId, (r.reason as { message: string }).message])
);
```

Then populate `stopReason` when building `RawRuntimeSession` objects:

```typescript
stopReason: reasonBySession.get(session.id) ?? null,
```

### No schema migration required

The `agent_messages.error_detail` column (JSONB, `{ code: string; message: string } | null`) already captures stop reasons for all failure types. The fix only needs to read this existing data and thread it through to the UI — no new columns or migrations.

## Acceptance Criteria

1. When billing blocks a session, the activity feed shows the billing reason (e.g., *"Daily spend limit reached — top up your account to resume."*) instead of *"Agent runtime shut down gracefully."*
2. User-initiated stops still show the generic graceful message.
3. Crashes, timeouts, and other stop causes show their respective reasons.
4. The `GUARDRAIL_TRIGGERED` eventType is `'guardrail.triggered'` not `'decision.rejected'`.
5. Existing tests pass (`agent-activity-mapper.test.ts`).

## Out of Scope

- Redesigning the activity feed UI layout
- Adding a stop reason column to `runtime_sessions` (schema migration)
- Changing how the worker emits guardrail events
