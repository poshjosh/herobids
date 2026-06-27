# Follow-Up — Broker-Side Billing Notifications

Telegram and email notification dispatch for soft-cap and hard-cap billing events.

## Context

The agent container now emits the right signals:

| Event | Reason code | Gate | Includes open positions |
|-------|------------|------|------------------------|
| `TICK_SKIPPED` | `billing.soft_limit_reached` | `billing_warning` | No |
| `TICK_SKIPPED` | `billing.limit_exceeded` | `billing` | Yes (`openPositions` field) |

The broker currently treats ALL `TICK_SKIPPED` events as audit-only — persisted to the journal but with no side effects. This plan adds billing-specific notification dispatch.

## Implementation Steps

### Step 1 — Detect billing events in the broker

In `AgentMessageBroker`'s event handler (around line 313), add a billing-specific branch inside the `TICK_SKIPPED` case:

```typescript
case AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED:
  // Billing events trigger user notification
  if (envelope.payload.reason === 'billing.soft_limit_reached'
      || envelope.payload.reason === 'billing.limit_exceeded') {
    await this.handleBillingNotification(effectiveAgentId, envelope.payload);
  }
  break;
```

### Step 2 — Implement `handleBillingNotification`

New method on `AgentMessageBroker`:

```typescript
private async handleBillingNotification(
  agentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const reason = payload.reason as string;
  const openPositions = payload.openPositions as string[] | undefined;

  // 1. Look up the agent's user for notification routing
  const agent = await this.agentRepo.getAgent(agentId);
  if (!agent) return;

  // 2. Deduplicate — only notify on status transition, not every tick
  const dedupKey = `agent:billing:notified:${agentId}`;
  // (use Redis to store last-notified status)

  // 3. Build the message text
  const isHard = reason === 'billing.limit_exceeded';
  const message = isHard
    ? this.buildHardLimitMessage(agent.name, openPositions)
    : this.buildSoftLimitMessage(agent.name);

  // 4. Send Telegram notification
  const chatId = await this.agentRepo.getEffectiveTelegramChatId(agentId);
  if (chatId && this.telegram) {
    await this.telegram.sendText(chatId, message);
  }

  // 5. Send email notification (if configured)
  if (this.emailClient) {
    const recipientEmail = await this.agentRepo.getUserEmailByAgentId(agentId);
    if (recipientEmail) {
      await this.emailClient.send({
        to: recipientEmail,
        subject: isHard
          ? `⚠️ ${agent.name} stopped — spending cap reached`
          : `ℹ️ ${agent.name} approaching spending cap`,
        text: message,
      });
    }
  }
}
```

### Step 3 — Message templates

**Soft cap message:**

```
ℹ️ Agent "{name}" has reached its soft spending cap.

Your agent is still running and trading normally. No behavior has changed.

To raise or remove the cap, visit Billing → Spend Controls.
```

**Hard cap message (no open positions):**

```
⚠️ Agent "{name}" has stopped — hard spending cap reached.

No further LLM calls will be made until you top up or raise the cap.

Visit Billing → Spend Controls to adjust your caps.
```

**Hard cap message (with open positions):**

```
⚠️ Agent "{name}" has stopped — hard spending cap reached.

Open positions are no longer monitored: {positions}

These positions will remain unmanaged until you take action. The agent will not close them automatically.

Visit Billing → Spend Controls to top up or raise the cap.
```

### Step 4 — Deduplication

Avoid spamming the user on every tick. Store the last-notified status per agent in Redis:

```
Key: agent:billing:notified:{agentId}
Value: "soft_limited" | "hard_limited" | null
TTL: 24h (same as the billing period cycle)
```

Only dispatch when the current status differs from the cached status. Update the cache after successful dispatch.

### Step 5 — Tests

Add unit tests in `apps/worker/src/agents/agent-broker-billing.test.ts`:

| Test | Description |
|------|-------------|
| Soft cap emits Telegram notification | Verify `telegram.sendText` called with warning message |
| Soft cap does NOT call telegram when no chat ID | Verify graceful skip |
| Hard cap emits Telegram notification with open positions | Verify positions appear in message |
| Hard cap emits email with open positions | Verify `emailClient.send` called |
| Dedup: second hard-limit tick does not resend | Verify notification fires once per status transition |
| Dedup: status change from soft to hard resends | Verify new notification on transition |
| Neither billing reason triggers non-billing path | Verify non-billing `TICK_SKIPPED` still audit-only |

## Files Touched

| File | Change |
|------|--------|
| `apps/worker/src/agents/agent-message-broker.ts` | Add billing notification dispatch in `TICK_SKIPPED` handler; add `handleBillingNotification`, `buildSoftLimitMessage`, `buildHardLimitMessage` methods |
| `apps/worker/src/agents/agent-broker-billing.test.ts` | New test file for billing notification behavior |
| (optional) `docs/tech/agents/billing-enforcement-semantics.md` | Update implementation contract section to reflect broker-side notification |

## Dependencies

- Redis client already available in the broker
- `TelegramClient` already injected via constructor
- `EmailClient` already injected via constructor
- `AgentRepository` already injected via constructor (has `getAgent`, `getEffectiveTelegramChatId`, `getUserEmailByAgentId`)

## Clarifying Questions

1. **Notification frequency**: Should the notification fire once per status transition (active→soft_limited, soft_limited→hard_limited) or on every tick while in that state? The plan above assumes once-per-transition with Redis dedup. Is that the desired behavior?

2. **Email cooldown**: The broker already has an email fanout rate limit (3/minute per agent). Should billing emails respect the same limit, or should they bypass it since billing stops are urgent?

3. **Billing page link**: Should the notification include a direct link to the Billing page (e.g. `https://app.herobids.com/billing`)? If so, what is the base URL and should it be configurable?

4. **Soft-cap notification priority**: Should the soft-cap notification use the `alert` message class (which is email-eligible under the existing `send_message` policy) or should these system-generated notifications bypass the agent's notification policy entirely?

5. **Agent names in notifications**: The plan uses the agent's display name. Does the `AgentRepository.getAgent()` return the name, or should we use a more specific identifier?

## Outstanding Issues

### H2 — Unresolved clarifying questions (from code review)

The five clarifying questions in the plan remain unresolved. The implementation makes the following assumptions:

| Q | Topic | Assumption made |
|---|-------|----------------|
| 1 | Notification frequency | Once-per-transition with Redis dedup (24h TTL) |
| 2 | Email cooldown | Billing emails **bypass** the existing `handleEmailFanout` rate limiter (3/min) — they use `emailClient.send()` directly |
| 3 | Billing page link | No link included (base URL not yet configurable) |
| 4 | Notification policy bypass | System-generated billing notifications bypass `notificationPolicy.sendMessage.email.enabled` entirely |
| 5 | Agent names | Uses `agent.name` from `AgentRepository.getAgent()` — verified available |

**Action:** Resolve these questions with product owner before deploying to production. If assumptions are correct, update the plan to reflect final decisions. If not, adjust the code accordingly.

### L2 — Test naming inconsistency

Some tests use `does NOT` while others use `does not`. Minor cosmetic issue — pick one convention.

### L3 — Empty agent.name edge case

If `agent.name` is an empty string, the notification reads `Agent "" has reached...`. Harmless but odd. Not worth a separate code path at this time.
