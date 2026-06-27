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

1. `isHardLimited()` — if true, skip the tick entirely (emit event, notify user, return)
2. `isSoftLimited()` — if true, emit event and notify user; **do not alter the tick flow**

### Activity events

| Event | Reason code | When |
|-------|------------|------|
| `TICK_SKIPPED` | `billing.limit_exceeded` | Hard cap reached — tick halted |
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

## Testing

- Unit: `scout-gating.test.ts` covers the pure decision logic
- Unit: `usage-billing-service.test.ts` covers the service-level cap checks
- Integration: tick-level test verifying soft cap does not suppress scout or judge dispatch
- Integration: tick-level test verifying hard cap halts before any LLM call
- UAT: `user-acceptance-tests.md` section 14 covers the billing page and spend-state banners
