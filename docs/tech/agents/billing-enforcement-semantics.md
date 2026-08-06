# Billing Enforcement Semantics for Agents

Canonical technical reference for how usage-billing caps affect agent runtime behavior.

Companion to [Agent Mode Purity](./runtime-boundary-and-message-contract.md#agent-mode-purity).

## Purpose

Define the exact semantics of soft-cap and hard-cap enforcement in the agent runtime, so implementers and reviewers have one authoritative source for what billing enforcement may and may not do.

## Core Policy

| Cap | Agent behavior change | Notification | Reversible |
|-----|----------------------|--------------|------------|
| **Soft cap** | **None** — agent continues reasoning and trading as normal | Yes — warning sent via Telegram and/or email | Yes — user may raise/remove cap, top up, or ignore |
| **Hard cap** | **Tick stop** — agent halts on the next tick; no further LLM calls | Yes — stop notification sent with open-position context | Yes — user may top up, raise cap, or wait for next billing period |
| **Zero balance / no available credit** | **Tick stop** — agent halts before any paid LLM call (independent of cap-derived status) | Yes — stop notification sent | Yes — user may add credit |

### Soft cap: warn, do not mutate

The soft cap is a notification-only boundary. It must not:

- Skip ticks
- Downgrade the model selection
- Suppress scout or judge dispatch
- Gate tool access
- Change the agent's tick interval or cost preset
- Alter any risk limit or trading parameter

It may only trigger a user notification and an activity event.

### Hard cap: stop, notify, document

The hard cap stops the agent's reasoning loop. It must:

- Halt the tick before any LLM call is made
- Emit a `tick_skipped` activity event with reason `billing.limit_exceeded`
- Send a user notification that includes open-position context

It must not:

- Close or modify open positions
- Submit orders
- Change the agent's config
- Prevent the user from raising the cap or topping up

## Zero-Balance (No Available Credit) Enforcement

Zero-balance enforcement is independent from cap-derived status. It blocks paid work (agent runtime and Guided Setup chat) when `availableMicrousd <= 0`, even if the account status is still `active`.

**Rule**: `availableMicrousd = balanceMicrousd - reservedMicrousd`. When this value is `<= 0`, all paid LLM dispatch is blocked regardless of cap status.

This uses the shared `canSpendNow()` guard in `packages/db/src/usage-billing-repository.ts`, which checks both account status AND available credit in a single call. The guard returns:

> **Fail-open**: The service layer (`UsageBillingService.canSpendNow()`) fails open on infrastructure errors — billing infra issues never block agent operations.

```typescript
interface CanSpendNowResult {
  canSpend: boolean;
  availableMicrousd: number;
  status: AccountStatus;        // 'active' | 'soft_limited' | 'hard_limited' | 'suspended'
  reason: 'ok' | 'no_available_credit' | 'hard_limited' | 'suspended';
}
```

### Enforcement points

`canSpendNow()` is applied at every point where the agent would incur a paid LLM cost:

| Enforcement point | Location | Behavior when blocked |
|-------------------|----------|----------------------|
| Session start | `AgentSessionManager` (after reconciliation) | Session launch is blocked; agent does not begin reasoning. Emits `guardrail_triggered` (not `TICK_SKIPPED`) with the appropriate reason code. |
| Scout/Judge LLM dispatch | `agent.ts` scout loop (before scout; judge is skipped if blocked) | Tick skipped before any LLM call |
| Hybrid evaluator LLM dispatch | `agent.ts` hybrid path | Tick skipped before any LLM call |
| Guided Setup chat (message send) | `apps/api/src/routes/chat.ts` `POST /chat/threads/:id/messages` | Message rejected with HTTP 402 `billing.top_up_required` before LLM call |
| Guided Setup chat (action result) | `apps/api/src/routes/chat.ts` `POST /chat/threads/:id/actions/:actionId` | Action rejected with HTTP 402 `billing.top_up_required` before LLM resume |
| Guided Setup `create_agent` tool | `apps/api/src/routes/chat.ts` `executeChatAction` | Tool returns `billing.top_up_required` error (defense-in-depth) |

### Reason code

Blocked operations emit `TICK_SKIPPED` with reason `billing.insufficient_funds` (see activity events table below).

This is consistent with assessment request reservations, which already check available credit before reserving spend.

### Inactivity when blocked

An agent blocked by zero-balance enforcement remains in its current status. It does not:

- Close or modify open positions
- Submit orders
- Change its config or tick schedule
- Transition to a different account status

The agent resumes normally on the next tick once the user adds credit and `availableMicrousd > 0`.

## Guided Setup Chat Enforcement

The `canSpendNow()` guard also applies to the Guided Setup (AI-assisted agent creation) chat. The product rule is "no money, no form": a user with no available billing credit must not consume paid platform resources (LLM calls) through the chat.

### Enforcement points (chat)

`canSpendNow()` is checked before every paid LLM call in the Guided Setup chat:

| Enforcement point | Location | Behavior when blocked |
|-------------------|----------|----------------------|
| Message send | `POST /chat/threads/:id/messages` | Returns HTTP 402 with error code `billing.top_up_required`. User message is **not** persisted, LLM is **not** invoked. |
| Action result (e.g. OAuth callback) | `POST /chat/threads/:id/actions/:actionId` | Returns HTTP 402 with error code `billing.top_up_required`. Connection-link metadata updates are still persisted (not a paid action), but the LLM resume is blocked. |
| `create_agent` tool call | `executeChatAction` (tool loop) | Returns a `billing.top_up_required` error as the tool result (defense-in-depth — the message-send gate is the primary block). |

### Frontend gate

The frontend (`GuidedSetupPanel`) fetches `GET /billing/usage-summary` on mount and renders a top-up gate (instead of the chat) when:

- The billing account status is `hard_limited` or `suspended`, OR
- (Frontend-only, approximate) available credit appears exhausted

The frontend gate is **approximate** (balance-based, does not account for reservations). The backend guard (`402` with `billing.top_up_required`) is the **authoritative** enforcement.

### Fresh users

Users with no billing account (new signups) are **never blocked** by the chat. The billing account is created lazily on first activity. The guard allows through when no account exists or no open period is found.

### HTTP contract

| Status | Error code | When |
|--------|------------|------|
| 402 | `billing.top_up_required` | `canSpendNow()` returns `canSpend: false` for any reason |

## Open Positions at Hard Cap

When the hard cap stops an agent with open positions, those positions become unmanaged. This is a user-visible event, not a silent side effect.

The notification must include:

- A list of open position symbols and sides
- A clear statement that these positions are no longer monitored
- Guidance on user actions (top up, raise cap, manually manage)

The system must not assume the user wants positions closed. It must not auto-liquidate.

## Relationship to Agent Mode Purity

This policy extends [Agent Mode Purity](./runtime-boundary-and-message-contract.md#agent-mode-purity). Billing enforcement is **operational mechanics**, not a trading constraint:

- Soft cap: data to the user (notification), not a constraint on the agent
- Hard cap: operational stop (infrastructure), not a trading decision

The distinction matters because constraints that change how an agent trades — even indirectly — violate the principle that user intent is supreme. A billing cap set by the platform or the user is a spending guardrail, not a trading policy override.

## Implementation Contract

### Runtime check order

In `apps/worker/src/agent.ts`, billing checks run before any LLM dispatch:

1. `canSpendNow()` — if `canSpend === false`, skip the tick entirely (emit `TICK_SKIPPED` with the appropriate reason code, notify user, return). This single guard checks both account status (`hard_limited` / `suspended`) AND available credit (`balanceMicrousd - reservedMicrousd <= 0`), replacing the previous separate `isHardLimited()` check.
2. `isSoftLimited()` — if true, emit event and notify user; **do not alter the tick flow**

### Activity events

| Event | Reason code | When |
|-------|------------|------|
| `TICK_SKIPPED` | `billing.limit_exceeded` | Hard cap reached — tick halted |
| `TICK_SKIPPED` | `billing.insufficient_funds` | No available credit (`balanceMicrousd - reservedMicrousd <= 0`) — tick halted |
| `TICK_SKIPPED` | `billing.account_suspended` | Account suspended — tick halted |
| `TICK_SKIPPED` | `billing.soft_limit_reached` | Soft cap reached — notification only; tick proceeds normally |

### User notification contract

Notifications are dispatched through the alert delivery system (Telegram, email, or both based on user preferences). The payload includes:

```typescript
{
  type: 'billing.cap_reached',
  cap: 'soft' | 'hard',
  currentSpend: number,      // microusd
  capValue: number,          // microusd
  hasOpenPositions: boolean,
  openPositions?: Array<{ symbol: string; side: string }>,
}
```

## Config Sources

| Cap value | Source | Overridable by user |
|-----------|--------|---------------------|
| Soft cap | Plan config (`plans.<id>.usage.softCapCents`) → billing account | Yes — Billing page |
| Hard cap | Plan config (`plans.<id>.usage.hardCapCents`) → billing account | Yes — Billing page |

If neither the plan nor the user sets a cap, the value is `null` and no enforcement occurs.

Zero-balance enforcement is always active — it requires no config toggle. The `canSpendNow()` guard runs unconditionally before any paid LLM dispatch, regardless of cap configuration. Available credit is derived from the billing period's `balanceMicrousd` and `reservedMicrousd` columns, which are always present.

## Testing

- Unit: `scout-gating.test.ts` covers the pure decision logic
- Unit: `usage-billing-service.test.ts` covers the service-level cap checks
- Integration: tick-level test verifying soft cap does not suppress scout or judge dispatch
- Integration: tick-level test verifying hard cap halts before any LLM call
- UAT: `user-acceptance-tests.md` section 14 covers the billing page and spend-state banners
