# Queue

The only list of what to do next. Work top to bottom. Take the first item whose dependencies are ticked and whose status is `ready`. Tick an item only when its evidence is in [PROGRESS](./PROGRESS.md).

Scope: the messaging MVP and the agent-to-agent MVP (DEC-40 to DEC-46). Deferred items are listed below and are not part of the current scope.

| # | ID | Item | Depends on | Status | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | C0 | Baseline: `pnpm test` counts recorded | none | done (2026-10-25) | [C0](./tasks/C0-baseline.md) |
| 2 | C1 | Cutover to `chat_addresses` and `chat_suppressions`; drop the four legacy columns (DEC-01 to DEC-12) | C0 | done (2026-10-25) | [C1](./tasks/C1-cutover.md) |
| 3 | CH2W | Two-way agent chat (002): conversation store, write path, owner view (DEC-31, DEC-32) | C1 | ready | [CH2W](./tasks/CH2W-two-way-chat.md) |
| 4 | A2A-A | Same-user check: both agents belong to the same user. No grant table, no screen (DEC-40) | none (may run early) | ready | [A2A-A](./tasks/A2A-A-same-user-check.md) |
| 5 | A2A-B | MVP peer messaging: send path, peer wake, per-user rate limit, owner view, stop switch (DEC-40 to DEC-43) | A2A-A, CH2W | blocked until dependencies are ticked | [A2A-B](./tasks/A2A-B-peer-send.md) |

## Deferred (not in scope; specs kept for later, DEC-45)

| ID | Item | Why deferred | Spec |
| --- | --- | --- | --- |
| C2 | Proof-of-control binding, 409 rule, remove `verify-telegram` | Not needed for agent-to-agent. Known gap: a chat address can be claimed by the wrong user until C2 ships (see [C2](./tasks/C2-binding.md)) | [C2](./tasks/C2-binding.md) |
| C2-R | Independent review of C2 | Depends on C2 | [C2-R](./tasks/C2-review.md) |
| E-R1 | Email fallback sends only when no other channel delivered | Not needed for agent-to-agent | [E-R1](./tasks/E-R1-email-rule.md) |
| U | Messaging as a user capability | Not needed for agent-to-agent | [U](./tasks/U-messaging-capability.md) |
| A2A-C | Safety gate beyond the rate limit: cost cap, turn cap, ping-pong pause, per-pair limit, trade block | Replaced by DEC-42 and DEC-41 for the MVP | [A2A-C](./tasks/A2A-C-safety-gate.md) |
| A2A-D | Prompt-injection stance | Deferred by DEC-44. Owner visibility moved into A2A-B | [A2A-D](./tasks/A2A-D-injection-visibility.md) |
| A2A grants | Grant table and owner screen (from the original A2A-A) | Replaced by the same-user check (DEC-40) | none |

## Already done (do not redo; re-verify only if a later item touches them)

- Schema note for conversation and peer tables, approved (DEC-47): [schema note](../../15/002-two-way-agent-chat/002-schema-note.md).
- P0 baseline, P2.1 to P2.6 (dual-write, removed by C1), P3.1 to P3.4 (route, bypass, config, gate), T (typing indicator, `25f895fe`).
- W (web push) and E (email fallback). Automated gates green. Owner ran the manual checks on 2026-10-24 and reported them passed. M-E5 is open (owner).
- Telegram constant-time secret check (`d553c64e`), bug report [001](../../../../../bug-reports/2026/10/25/001-telegram-webhook-secret-compare-not-constant-time.md).

## Notes on the queue

- A2A-A can run at any time. It has no dependencies.
- CH2W cannot start until C1 is ticked. A2A-B cannot start until CH2W and A2A-A are ticked.
- The chat-binding gap (C2 deferred) is accepted for the MVP. It does not block agent-to-agent messaging.

## Outstanding Issues

Non-blocking issues from code reviews, grouped by item.

### C0
- (medium, fixed in C1) `pnpm test` baseline had 2 known failures in `packages/domain/src/config/schema.test.ts` (stale `agentCreation` expectations, missing `platformApiTimeoutMs`). Fixed by adding `platformApiTimeoutMs: 10000` to the two expected objects.
- (low) C0 added a new "C0 baseline record" section in 900 instead of editing "P0 baseline record".
- (low) 095 Q4 still says to use the M0 re-run as baseline; mark resolved by DEC-25 / C0.

### C1
- (low) The literal acceptance grep still matches the web i18n label keys (`agents.create.telegramChatId`, `.placeholder`, `agents.telegramChatId.help`), the operator alert key `alerts.operator.telegramChatId`, and the 0077 backfill test. See the C1 PROGRESS entry. Decide whether to rename the keys.
- (low) `markOutboundMessageSent` still records `telegram` as the provider. CH2W retires the table.
- (low) `packages/db` integration files race when run in parallel (shared `users` truncate). Use `--fileParallelism=false` as `test:integration` does.
- (owner) Staging and production teardown and re-provisioning, and the YAML move of `alerts.telegram.{botToken,webhookSecret,webhookUrl}` to `messaging.chat.telegram.*`. Steps are in the C1 PROGRESS entry.

### C1
- (medium, I4) `agent-interactivity.ts` `sendTelegramText`/`processWebhookUpdate`: a suppressed chat still gets replies (help, "bind first"). Check suppression at the top of `processWebhookUpdate` and drop silently; add a test. Latent until a revoke writer exists.
- (medium, I2) `agent-repository.ts` `markOutboundMessageSent` hardcodes `deliveryProvider: 'telegram'`. Add a `provider` parameter; update callers in `agent-message-broker.ts`, `platform-alert-service.ts`, `worker/src/index.ts`.
- (medium, DEC-08) Phone providers (whatsapp, sms) are not E.164-validated or canonicalised; `15555550100` and `+15555550100` differ. Validate in `ChatAddressInputSchema` and `normalizeChatAddress` before any phone provider ships.
- (low) `apps/web/src/features/agents/agent-payloads.ts` return type still declares `telegramAddress?`; should be `chatAddresses?`.
- (low) `auth.ts` PATCH `/auth/me`: user update and address write are separate transactions.
- (low) `auth.ts` ~343 and ~674: indentation of `aiModelConfig: null,`.
- (low) Owner hand-off: environments setting `alerts.telegram.*` must move to `messaging.chat.telegram.*` (silently ignored otherwise).
- (low) `listChatAddressesForOutput` reports a suppressed address as `active`.
- (info) Acceptance grep still matches i18n keys and `alerts.operator.telegramChatId` (by design; coordinator signs off).

### CH2W (slice 1: P0+P1)
- (medium) `conversation-repository.ts` `recordUserAgentMessage`: a first write whose message id belongs to another conversation commits an empty conversation + participants. Throw a rollback sentinel (like owner mismatch) and add a test.
- (medium, owner, tier 3) Telegram reply lookup needs an index on (`channel`, `provider_message_id`) before `agent_outbound_messages` is retired (P3 migration). Also decide dropping `session_id` and `context_ref` (no columns in the schema note). Recommendation in PROGRESS.md.
- (low) Port doc: `markDelivery` is internal-only; repeated mark returns `invalid_delivery_transition`, so delivery workers must treat "already sent" as success.
- (low) P2 route must validate message id format/length and encode the (createdAt, id) cursor; the route must 404 for another user's agent.
- (low) No DB CHECK constraints on enum columns (matches repo convention); agent/platform bodies are uncapped; body length counts UTF-16 units; idempotent retry does not compare body.
