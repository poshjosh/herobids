# 082 Email notification fallback: implementation plan

**Status:** Accepted 2026-10-24. Owner accepted the recommended defaults (E-D1 to E-D8). E-D3 (email opt-out default) is flagged for review against the seamless-communication goal. Ready to implement.
**Date:** 2026-10-24
**Parent:** [080-web-push-notifications](./080-web-push-notifications.md) · **Plan:** [900-implementation-plan](./900-implementation-plan.md), Phase E
**Depends on:** [081-web-push-implementation-plan](./081-web-push-implementation-plan.md) (Phase W) must pass its gate first.
**Entrypoint:** task E in [AGENT-ENTRYPOINT](./AGENT-ENTRYPOINT.md) §3 (unchecked). Do not implement until the Open decisions below are answered.

## Goal

Send the same agent notification by email when push cannot reach the user, using the existing SES email path. The rule is strict: **never send both push and email for one event**, and never send email in place of a push that succeeded.

## Non-goals

- Changing the SES transport or the `EmailClient` interface.
- Email replies or inbound email. Email is one-way, like push.
- Changing the existing billing and platform-alert email paths (see E-D6).
- Reviving the removed `send_message` email fanout (removed 2026-07-17; see `packages/db/src/schema/agents.ts`).
- Telegram or WhatsApp changes.

## Current state (verified 2026-10-24)

- **Transport:** Amazon SES v2 (`@aws-sdk/client-sesv2`), not Resend. Worker: `apps/worker/src/alerting/ses-email-client.ts` (`SesEmailClient`), behind the `EmailClient` interface in `apps/worker/src/alerting/email-client.ts`. Returns `Result<EmailSendResult, { code, message }>`.
- **Factory:** `createEmailClient` in `apps/worker/src/alerting/create-email-client.ts` returns `undefined` unless `provider`, region, keys, and `fromEmail` are all set. The worker wires it at `apps/worker/src/index.ts:682`. When undefined, email is off. E must treat this as "no email", not as a silent skip.
- **Config:** transport lives under `alerts.email` (`packages/domain/src/config/schema.ts` ~644; `config/default.yaml` ~771). Env overrides in `apps/api/src/config.ts:52–57` and `apps/worker/src/config.ts:37–42`. Public base URL is `auth.publicBaseUrl` (`config/default.yaml`).
- **Recipient lookup:** `agentRepo.getUserEmailByAgentId(agentId)` is already used by the broker and returns the account email.
- **Rendering:** `renderEmail` from `@herobids/domain` with optional `brandImageUrl`.
- **Existing email callers (not governed by 082 unless the owner says so):**
  - Billing notifications: `apps/worker/src/agents/agent-message-broker.ts` (~lines 1300–1345) send Telegram, then email, for the same event.
  - Platform safety alerts: `apps/worker/src/alerting/platform-alert-service.ts` (~lines 109–146) send email.
  - Agent `send_email` tool: `apps/worker/src/tools/email.ts`.
- **Send message:** `handleSendMessage` sends no email (fanout removed; comment at the end of the function).
- **Legacy user preference:** `users.notificationPreferences.sendMessage.email` (`packages/db/src/schema/users.ts` ~26–34) and `agents.notificationPolicy.sendMessage.email` (`packages/db/src/schema/agents.ts` ~33–45). The comments say the agent-side value is no longer used at runtime.
- **Not present:** no notification delivery ledger, no per-user email cap, no per-class email list. `alerts.email` is transport only.
- **Depends on W, which is not built:** no `NotificationChannel` port, no `push_subscriptions` table, no failure state. See [081](./081-web-push-implementation-plan.md) W2, W3, W4.

### Conflicts between 080 and the code

1. 080 says email is sent when "every push to that user failed in the last window". No window is defined, and no push failure is recorded yet (W3 adds `last_failure_at`). See E-D1.
2. 080 says "never send both for one event". The billing path already sends Telegram and email for one event, and platform alerts send email. Read broadly, 080's rule conflicts with these paths. See E-D6.
3. 080 says the email fallback applies when "the event class is on the email list". No such list exists. This plan adds one under `messaging.notifications.email` (E1).
4. 080 does not say whether email fallback needs a user opt-in. The existing `sendMessage.email` key is legacy. See E-D4.

## Decisions needed from the owner

All items are **Open**. The recommended default applies if the owner does not object.

| ID | Question | Recommended default |
| --- | --- | --- |
| E-D1 | **Fallback trigger.** 080 says "every push failed in the last window". What is the window? | Per event, with no time window. Email is sent only when the user has no active subscription, or when every push attempt for this event failed. This is simpler, testable, and needs no scheduler. |
| E-D2 | **Which event classes are emailed?** | `["agent.question"]` only. `agent.reply` is delivered by chat and push. Add `task.completed` if W4 adds it (081 D4). Set in `messaging.notifications.email.eventClasses`. |
| E-D3 | **Telegram-only users** (no push subscription). Does email fallback apply? | Yes, under the same opt-in rule as E-D4 (`userDefaultEnabled`). This is 080's literal rule. Telegram delivery does not suppress email. |
| E-D4 | **Email default.** Is email fallback on by default? | Opt-in by default. The instance default is `messaging.notifications.email.userDefaultEnabled: false`, which applies to users with no explicit choice. A user's choice at `users.notificationPreferences.notifications.emailFallback.enabled` (JSONB, instance config) overrides the default in either direction. Setting `userDefaultEnabled: true` makes email on by default with per-user opt-out. Do not reuse the legacy `sendMessage.email` key. |
| E-D5 | **Per-user cap.** How many fallback emails per user per day? | `maxPerUserPerDay: 10`, counted from the delivery ledger (E4). This number is a proposal, not from any existing doc. |
| E-D6 | **Existing email paths** (billing dual send, platform alerts, `send_email`). Are they in scope? | Out of scope. 082 governs only the new `NotificationChannel` flow. Owner to confirm, since 080's "never both" rule would otherwise cover them. |
| E-D7 | **Email content.** | `renderEmail` with subject "New message from <agent name>" and a fixed body with no message text. The link is `auth.publicBaseUrl` + `/agents/<id>`. |
| E-D8 | **Delay before email.** | None. Email is sent right after the push attempts for the event fail. A delay needs a scheduler and is not in v1. |

## Task breakdown

Tasks are ordered. Test files named "new" are proposed; confirm the name when you create them.

### Phase E-A: config, pure policy, transport adapter

**E1. Email config keys.**
- Description: add `messaging.notifications.email` to `MessagingConfigSchema`: `enabled` (false), `eventClasses` (E-D2), `maxPerUserPerDay` (positive int, E-D5), `userDefaultEnabled` (false; the opt-in default for users with no explicit choice, E-D4). Transport stays under `alerts.email`. Do not duplicate `fromEmail` or SES keys. Defaults go in `config/default.yaml` under `messaging:`. No new env var, so no `.env.example` change. (If W1 has added `messaging.notifications`, extend it; do not create a second block.)
- Files: `packages/domain/src/config/schema.ts`, `config/default.yaml`; new `packages/domain/src/config/notifications-email-config.test.ts`.
- Test: defaults parse with email off; a non-positive `maxPerUserPerDay` is rejected; `alerts.email` parses unchanged.
- Gate: config tests green. Depends on W1.

**E2. Fallback policy (pure).**
- Description: `decideFallback(input)` returns `{ route: 'none' | 'email', reason }`, where `reason` is a dot-string such as `notification.push_succeeded`, `notification.no_subscription`, `notification.push_all_failed`, `notification.class_not_emailed`, `notification.opted_out`, `notification.rate_limited`. The return type can express one route only, so push and email can never both be chosen. Inputs: class, `hasActiveSubscriptions`, `pushAttempted`, `pushSucceeded`, `emailClassEnabled`, `userOptedOut`, `dailyEmailCount`, `maxPerUserPerDay`.
- Files: new `packages/domain/src/notifications/fallback-policy.ts`, `packages/domain/src/index.ts` (confirm export).
- Test: new `packages/domain/src/notifications/fallback-policy.test.ts`. Table-driven across all rules, including the no-duplicate case (one success means `none`).
- Gate: domain tests green. Depends on W2.

**E3. Email notification channel (adapter).**
- Description: `EmailNotificationChannel implements NotificationChannel`. Wraps the existing `EmailClient` and `renderEmail`. Recipient from `getUserEmailByAgentId`. Missing address returns `notification.no_recipient`. A missing client returns `notification.email_disabled`. Provider errors map to `notification.provider_failed`. Constructor injection only.
- Files: new `apps/worker/src/notifications/email-notification-channel.ts`; `apps/worker/src/alerting/index.ts` only if an export is needed.
- Test: new `apps/worker/src/notifications/email-notification-channel.test.ts` with a fake `EmailClient`. Covers success, provider failure, missing recipient, missing client. The subject and body contain no message text.
- Gate: tests green; `npx tsc -p apps/worker/tsconfig.json --noEmit` exit 0. Depends on W2, E1.

### Phase E-B: ledger and dispatch

**E4. Delivery ledger.**
- Description: new table `notification_deliveries`: `id`, `user_id`, `agent_id`, `event_key` (unique with `channel`), `channel` (`web_push | email`), `status` (`sent | failed | skipped`), `reason`, `created_at`. Methods: `recordIfAbsent(eventKey, channel)` (insert-or-skip), `countEmailSince(userId, since)`, `reserveEmailIfUnderCap(...)` (duplicate check, cap check, and insert in one transaction under a per-user `pg_advisory_xact_lock(hashtext(userId))`, so concurrent decisions cannot both take the last slot), `updateStatus`. The unique key is the duplicate guard across retries and replicas.
- Files: new `packages/db/src/schema/notification-deliveries.ts`, `packages/db/src/schema/index.ts`, new migration (next number after W3's), new `packages/db/src/notification-delivery-repository.ts`.
- Test: new `packages/db/src/notification-delivery-repository.test.ts`. Integration test for the unique key and the daily count, skipped without `DATABASE_URL`. Unit test for the mapping.
- Gate: `cd packages/db && pnpm db:generate` produces one new migration; no existing migration is edited. Depends on W3.

**E5. Dispatcher.**
- Description: `NotificationDispatcher.dispatch(event)` runs in this order: (1) if the class is not on the push list, return. (2) Send push to each active subscription via `WebPushChannel` (W4). (3) Build push outcomes. (4) Call `decideFallback` (E2). (5) If `route` is `email`, call `reserveEmailIfUnderCap` first; if the row already exists or the cap is reached inside the transaction, stop. With no email client, return `notification.email_disabled` before any database read. Otherwise send via `EmailNotificationChannel` and update the status. Returns a `Result`. Failures are logged, not thrown.
- Files: new `apps/worker/src/notifications/notification-dispatcher.ts`; new `apps/worker/src/notifications/notification-dispatcher.test.ts`.
- Test: matrix covering (a) no subscription sends email once; (b) push success sends no email; (c) all pushes failed sends email once; (d) a repeat event key sends nothing; (e) email failure is recorded as `failed` and is not retried in this task; (f) the daily cap blocks email.
- Gate: tests green. Depends on W4, E2, E3, E4.

**E6. Broker wiring.**
- Description: in `handleSendMessage`, replace the direct W5 push call with `NotificationDispatcher.dispatch(...)`. The chat result is unchanged. Wire the dispatcher where the broker is constructed in `apps/worker/src/index.ts`. The event key is `<agentId>:<msgId>` (the outbound message ID already exists in the function).
- Files: `apps/worker/src/agents/agent-message-broker.ts`, `apps/worker/src/index.ts`, `apps/worker/src/agents/agent-message-broker.test.ts`.
- Test: fallback is called only when push has no success; Telegram assertions in the existing broker tests are unchanged.
- Gate: `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` green. Depends on E5, W5.

### Phase E-C: user control and verification

**E7. Per-user email opt-out.**
- Description: accept `notificationPreferences.notifications.emailFallback.enabled` (boolean) in the existing `PATCH /me` handler, validated with Zod. Store it in the `users.notificationPreferences` JSONB. This is instance config, so it is not in YAML. The legacy `sendMessage.email` payload must still be accepted unchanged. Add a toggle to the settings page next to the W8 opt-in. Extend the `updateMe` type in `apps/web/src/lib/api-client.ts` (~line 279). No `as unknown as`.
- Files: `apps/api/src/routes/auth.ts` (~lines 915–980), `apps/api/src/routes/auth.test.ts`, `apps/web/src/lib/api-client.ts`, the settings page, `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`.
- Test: a valid toggle is saved; a non-boolean returns 400; the legacy payload still passes. Settings UI test covers the toggle.
- Gate: `pnpm exec vitest run auth` green; web tests green. Depends on W8 and E-D4. **Owner check:** this is an additive change to the `PATCH /me` contract (AGENT-ENTRYPOINT §0 item 3).

**E8. Manual checks and gate record.**
- Description: run the manual checks below, then record results in 900 Phase E. Tick task E in AGENT-ENTRYPOINT §3 only when the gate passes.

### Dependencies

```
W2 ──► E2 ──┐
W2, E1 ──► E3 ──┤
W3 ──► E4 ──┤
W4 ─────────┴──► E5 ──► E6 ──► E8
W8 + E-D4 ──► E7 ──► E8
```

- E2, E3, and E4 can be built in parallel after W's gate.
- **Ordering:** W first, then E. E has no push condition to test without W's subscriptions, failure state, and push outcomes. The Telegram guard runs after E6.

## Verification

| When | Command or check |
| --- | --- |
| After E1–E2 | `pnpm exec vitest run notifications-email-config fallback-policy`; `npx tsc -p packages/domain/tsconfig.json --noEmit` |
| After E3 | `pnpm exec vitest run email-notification-channel`; `npx tsc -p apps/worker/tsconfig.json --noEmit` |
| After E4 | `cd packages/db && pnpm db:generate`; `pnpm exec vitest run notification-delivery`; with `DATABASE_URL` set, rerun for the integration test |
| After E5–E6 | `pnpm exec vitest run notification-dispatcher agent-message-broker`; `npx tsc -p apps/worker/tsconfig.json --noEmit` |
| Telegram guard | `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` |
| After E7 | `pnpm exec vitest run auth`; `npx tsc -p apps/api/tsconfig.json --noEmit`; `npx tsc -p apps/web/tsconfig.json --noEmit` |
| Phase gate | `pnpm lint`; `pnpm test` (full suite must stay green) |

**Manual checks (not automated):**

- **M-E1 SES sandbox:** if SES is in sandbox, send only to a verified recipient. Confirm the email arrives, the subject has no message text, and the link opens `/agents/<id>`.
- **M-E2 No push:** a user with no subscription receives exactly one email per `agent.question`.
- **M-E3 Push succeeds:** a user with a working subscription receives push and no email for the same event.
- **M-E4 Opt-out:** after the toggle is off, no fallback email is sent.
- **M-E5 Deliverability:** check SES bounce and complaint metrics for the configuration set (`alerts.email.ses.configurationSetName`) after the first run.

## Risks and open points

- **Duplicates:** the ledger row is written before the email send. A crash between the insert and the send loses that email (at-most-once). The alternative (resend on retry) can duplicate. Owner to confirm the trade-off.
- **Multi-replica workers:** the unique `(event_key, channel)` key prevents two replicas from both sending. Confirm the replica model when E4 lands.
- **Provider limits:** SES sandbox limits, sending quotas, and throttling are not modelled in v1. Bounces and complaints can damage sender reputation. Use the existing configuration set.
- **Volume:** agent-initiated notifications can be frequent. The daily cap (E-D5) is the only guard in v1.
- **Privacy:** email is less private than push. Anyone with access to the inbox sees the agent name. Owner to confirm that the agent name is acceptable in email.
- **Deliverability:** `alerts.email.fromEmail` must be SES-verified. Without an email client, `createEmailClient` returns `undefined` and E returns `notification.email_disabled`.
- **Legacy paths:** the billing and platform-alert email paths are unchanged (E-D6). If the owner wants them under the "never both" rule, that is a separate task.
- **Legacy preference:** do not revive `sendMessage.email` or the removed `send_message` fanout.
- **Stop triggers:** E7 changes the `PATCH /me` contract (additive). Owner approval may be needed per AGENT-ENTRYPOINT §0 item 3.

## Outstanding Issues

- Opt-in default conflicts with the seamless-communication goal; owner to confirm or flip the default.
