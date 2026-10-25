# E-R1: Email fallback sends only when no other channel delivered

**Status:** deferred (DEC-45). Do not start. Kept for later.

**Depends on:** C2-R. **Approvals:** DEC-35 (D05 option B), DEC-36, DEC-38.
**Design context:** [082](../082-email-fallback-implementation-plan.md) (E-D1 to E-D8), [080](../080-web-push-notifications.md).

## Objective

For one event, a user receives an email only if the platform could not reach them by push and could not reach them by chat. A user who received the message on Telegram gets no email for it.

## Rule (DEC-35)

Send the fallback email for an event only when all of these hold:

1. The event is in the email event classes (E-D2, unchanged).
2. The user has opted in (E-D4, unchanged, `userDefaultEnabled: false`).
3. No push subscription delivered the event.
4. No chat message was sent for the event on any chat channel.
5. The per-user daily cap is not reached (E-D5, unchanged, 10 for system fallback emails).

The decision is made at event time. There are no timers and no delayed retries.

## Steps

1. Find the existing fallback decision in the notification code. Search for the fallback and for `notification_deliveries`. Record the file and function in PROGRESS.md.
2. Confirm how a chat send is linked to an event. The chat send is recorded in `agent_outbound_messages` with `delivery_status`. If there is no reliable link between a chat send and the event, stop this item and write an open question. That is tier 3.
3. Change the decision so that conditions 3 and 4 are checked. Do not add a configuration key for this rule.
4. Keep the "never both" rule for the new path only. Do not change billing, platform-alert, or `send_email` paths (DEC-36).

## Tests (required)

- Telegram delivered, no push: no email.
- Telegram failed, no push: email sent (if opted in and under the cap).
- Push delivered: no email.
- Opted out: no email, whatever the channels did.
- Cap reached: no email.
- Agent `send_email` is unaffected.

## Gate

- Targeted tests for the notification and email code. Name the files in PROGRESS.md.
- Type checks for `apps/worker` and `apps/api`.
- `pnpm test`, compared with the C0 baseline.
