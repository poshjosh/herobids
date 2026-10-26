# Queue

The only list of what to do next. Work top to bottom. Take the first item whose dependencies are ticked and whose status is `ready`. Tick an item only when its evidence is in [PROGRESS](./PROGRESS.md).

Scope: the messaging MVP and the agent-to-agent MVP (DEC-40 to DEC-46). Deferred items are listed below and are not part of the current scope.

| # | ID | Item | Depends on | Status | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | C0 | Baseline: `pnpm test` counts recorded | none | done (2026-10-25) | [C0](./tasks/C0-baseline.md) |
| 2 | C1 | Cutover to `chat_addresses` and `chat_suppressions`; drop the four legacy columns (DEC-01 to DEC-12) | C0 | done (2026-10-25) | [C1](./tasks/C1-cutover.md) |
| 3 | CH2W | Two-way agent chat (002): conversation store, write path, owner view (DEC-31, DEC-32) | C1 | done in code (2026-10-25); owner e2e gate and phase reviews open | [CH2W](./tasks/CH2W-two-way-chat.md) |
| 4 | A2A-A | Same-user check: both agents belong to the same user. No grant table, no screen (DEC-40) | none (may run early) | done (2026-10-25) | [A2A-A](./tasks/A2A-A-same-user-check.md) |
| 5 | A2A-B | MVP peer messaging: send path, peer wake, per-user rate limit, owner view, stop switch (DEC-40 to DEC-43) | A2A-A, CH2W | done (2026-10-25); DEC-53, DEC-54, DEC-56 and DEC-57 approved by the owner (2026-10-25) | [A2A-B](./tasks/A2A-B-peer-send.md) |

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
- (low) The literal acceptance grep still matches the web i18n label keys (`agents.create.telegramChatId`, `.placeholder`, `agents.telegramChatId.help`), the operator alert key `alerts.operator.telegramChatId`, and the 0077 backfill test. See the C1 PROGRESS entry. **Resolved:** DEC-55 signs the grep off with these exceptions; the keys stay.
- (low) `markOutboundMessageSent` still records `telegram` as the provider. CH2W retires the table. **Fixed in CH2W slice 3:** the method is removed with the table.
- (low) `packages/db` integration files race when run in parallel (shared `users` truncate). Use `--fileParallelism=false` as `test:integration` does.
- (owner) Staging and production teardown and re-provisioning, and the YAML move of `alerts.telegram.{botToken,webhookSecret,webhookUrl}` to `messaging.chat.telegram.*`. Steps are in the C1 PROGRESS entry.

### C1
- (medium, I4) `agent-interactivity.ts` `sendTelegramText`/`processWebhookUpdate`: a suppressed chat still gets replies (help, "bind first"). Check suppression at the top of `processWebhookUpdate` and drop silently; add a test. Latent until a revoke writer exists. **Fixed in CH2W slice 3:** `processWebhookUpdate` and `processWebhookDocument` drop a suppressed chat silently before any reply; a lookup error drops the update (fail closed). Tests added.
- (medium, I2) `agent-repository.ts` `markOutboundMessageSent` hardcodes `deliveryProvider: 'telegram'`. Add a `provider` parameter; update callers in `agent-message-broker.ts`, `platform-alert-service.ts`, `worker/src/index.ts`. **Fixed in CH2W slice 3:** the method no longer exists; `markThreadDelivery` sets the channel from the delivery result's provider.
- (medium, DEC-08) Phone providers (whatsapp, sms) are not E.164-validated or canonicalised; `15555550100` and `+15555550100` differ. Validate in `ChatAddressInputSchema` and `normalizeChatAddress` before any phone provider ships.
- (low) `apps/web/src/features/agents/agent-payloads.ts` return type still declares `telegramAddress?`; should be `chatAddresses?`.
- (low) `auth.ts` PATCH `/auth/me`: user update and address write are separate transactions.
- (low) `auth.ts` ~343 and ~674: indentation of `aiModelConfig: null,`.
- (low) Owner hand-off: environments setting `alerts.telegram.*` must move to `messaging.chat.telegram.*` (silently ignored otherwise).
- (low) `listChatAddressesForOutput` reports a suppressed address as `active`.
- (info) Acceptance grep still matches i18n keys and `alerts.operator.telegramChatId` (by design). **Resolved:** signed off with exceptions in DEC-55.

### CH2W (slice 1: P0+P1)
- (medium, fixed in slice 2) `conversation-repository.ts` `recordUserAgentMessage`: a first write whose message id belongs to another conversation committed an empty conversation + participants. Now throws a rollback sentinel (like owner mismatch); integration test added and checked by mutation.
- (medium, owner, tier 3) Telegram reply lookup needs an index on (`channel`, `provider_message_id`) before `agent_outbound_messages` is retired (P3 migration). Also decide dropping `session_id` and `context_ref` (no columns in the schema note). Recommendation in PROGRESS.md. **Resolved in slice 3:** DEC-51 (index in migration 0086) and DEC-52 (both dropped).
- (low, fixed in slice 2) Port and service docs now say `markDelivery` is for delivery workers only and that a repeated mark returns `invalid_delivery_transition`, which a retrying worker treats as "already marked".
- (low, fixed in slice 2) P2 route validates the message id (UUID) with Zod, encodes the (createdAt, id) cursor, and answers 404 for another user's agent.
- (low) No DB CHECK constraints on enum columns (matches repo convention); agent/platform bodies are uncapped; body length counts UTF-16 units; idempotent retry does not compare body.

### CH2W (slice 2: P2 Web)
- (medium, owner, tier 3) Confirm `conversation_messages.queued_at` (migration 0085, DEC-50, `proposed — pending owner confirmation`). It is a column outside the approved schema note (DEC-47); schema note section 7 requires a decision. Not approved by the implementer. Accepted risk: clock skew across API instances vs `staleQueuedAfterSeconds`. See PROGRESS slice 2. **Resolved:** DEC-50 approved 2026-10-25.
- (medium, transitional, P3) Two bridges keep the old readers and the web chat working until P3 moves the writers; P3 must delete both. (1) `POST /agents/:id/message` still inserts the same id into `agent_outbound_messages` (readers: `conversation-turn`, the activity feed, the old `GET /agents/:id/messages`). (2) `OutboundConversationMirror` (worker) copies agent and platform rows into the conversation after delivery, called from the broker `send_message` path, `PlatformAlertService.fireAlert` and the session-started anchor. Mirrored rows use the mirror time as `created_at`, and `channel` follows the old `delivery_provider` (`web` when none). `chat.no_address` and `chat.not_configured` are mirrored as `not_applicable`, not `failed`. **Fixed in slice 3:** both bridges are deleted.
- (low) The runtime does not de-duplicate `platform->agent` envelopes by `messageId` (see PROGRESS, review fixes). A stuck-queued re-publish is at-least-once: if the first publish reached Redis but the `sent` mark failed, the agent can see the message twice.
- (medium, P3) Telegram inbound is still not recorded in the conversation, so Telegram user messages do not appear in the web thread until P3. **Fixed in slice 3.**
- (low) The web falls back to 4000 characters until the first page reports `maxMessageChars` (the operator limit). The server enforces the configured limit.
- (low) Platform docs (`get-started` help, worker `platform-docs-data.ts`) still say "Talk to your agent"; P4 platform docs review. **Fixed in slice 3 (P4).**
- (low) The web retry for a failed message cannot be component-tested (no DOM test tooling in `apps/web`); the pending/retry logic is in the pure `conversation-thread.ts` and is unit tested.
- (info) The plan's e2e gate (`run-all-tests.sh --e2e`) is deferred to the owner (ENTRYPOINT section 7).

### CH2W (slice 2: P2 web)
- (owner, tier 3) DEC-50 (`conversation_messages.queued_at`) is proposed, not approved. Also add to its accepted risk: if `xadd` succeeds but `markDelivery('sent')` fails, a stale-queued retry republishes (duplicate delivery). **Resolved:** DEC-50 approved; the accepted risk (including a `xadd` success followed by a failed `sent` mark) stands.
- (owner) P2 closes only after the plan's e2e gate (`run-all-tests.sh --e2e`) is run by the owner; deferred per ENTRYPOINT.
- (medium) Broker `chat.address_lookup_failed` after redelivery exhaustion leaves the legacy row `pending` and no thread row; confirm consumer retry is finite and mirror once on the final attempt. **Decided in slice 3:** the stream consumer acknowledges every message, so there is no redelivery. The row is recorded first, marked `failed` (fail closed, I4) and the envelope fails as before.
- (medium) Session anchor (`worker/src/index.ts` ~733) swallows `markOutboundMessageSent` failure; mirror then records `not_applicable`. Log the error or pass `'sent'` to the mirror. **Fixed in slice 3:** the anchor records the row, sends, and `markThreadDelivery` logs an error when the mark fails (a repeated mark is not an error).
- (low) Mirrored rows use mirror-time `createdAt`; Retry shows on a stopped agent (API returns 409); reused `clientMessageId` with different body silently returns the stored row; unused `AgentRepository.deleteAgent` bypasses conversation cleanup; plan 001 status wording "P2 done in code" needs owner confirmation; Retry/Sending/Show earlier states need a visual pass.

### CH2W (slice 3: P3 Channels + P4 Close)
- (owner) The plan's e2e gate (`scripts/shell/tests/run-all-tests.sh --e2e`) before P2 closes and before P3 closes is not run (ENTRYPOINT section 7). The owner review after each phase is also open. CH2W is ticked as done in code, with the acceptance evidence in PROGRESS; the owner closes P2 and P3 after the e2e run.
- (owner) Environments with data in `agent_outbound_messages` lose it when migration 0086 runs (pre-launch, no backfill, plan section 3). Staging and production re-provisioning stays an owner hand-off.
- (medium) The Telegram document notice (`User sent document ...`, composed by the platform) is still published without a conversation row, so it is not in the web thread. Tier 2 choice: it is platform text, not the user's message. Record it as a platform message if the owner wants uploads in the thread.
- (low) A Telegram message longer than `messaging.conversations.userMessageMaxChars` (4000) is refused with a "too long" reply; Telegram itself allows 4096. A provider without a conversation channel is refused with "Could not deliver ...".
- (low) An agent or platform row is recorded `queued` on the `web` channel and marked after the chat send. If the process dies between the two, the row stays `queued` (nothing retries agent rows). The web shows it as queued, never as failed.
- (low, fixed in the slice 3 review fixes) Reply lookup now filters on the address in SQL (see PROGRESS, review fixes) and keeps a safety cap of 20 candidates; it no longer makes one query per candidate.
- (low) The webhook checks suppression twice per update (early drop, and again in `findUserByTelegramChatId`). Both are indexed point reads; the second is kept as defence in depth.
- (low) Activity feed `detail.authoredBy` is now the sender type (`agent` or `platform`); a creator agent's message was `agent:{id}` before. `/log` labels the user's own messages `YOU:` (they were shown as `AGENT:`).
- (low) The two migration test files that still read `agent_outbound_messages` (`chat-addresses-backfill.integration.test.ts` and two assertions in `chat-address-resolution.integration.test.ts`) exercise migrations 0077 and 0083 on purpose; they are the only remaining hits of the acceptance grep.
- (low) ar and hi: no new keys in P3. The `get-started` help line that named "Talk to your agent" was reworded in en, ar and hi; ar and hi stay pending native review, as before.
- (owner, medium) A suppressed chat is dropped silently, which also blocks `/help` and every other reply. Left as is for owner confirmation: either keep the silent drop (I4) or allow a fixed opt-out notice and `/help`.
- (owner, low) Telegram allows 4096 characters; the thread limit is 4000 (`messaging.conversations.userMessageMaxChars`). Left as is; the user gets the "too long" reply.
- (low) Reply correlation is time-based: a reply resolves through its message only if the replying address row's `updated_at` is not later than the message's `created_at`. Any change of that row (a rebind, or a revoked-then-saved address) makes older messages fall back to the address lookup, which resolves only a single agent-level address. Rows are stamped with the app clock (`setChatAddress`), messages with the service clock; skew between API instances larger than the gap between a bind and its first message would also fall back (fail safe). A column such as `chat_addresses.bound_at` or a stored chat id on the message would be exact, but needs an owner schema decision.
- (low) Message-id correlation only exists for providers that are a thread channel (`web`, `telegram`). A reply on whatsapp or sms skips the message lookup and uses the address rows until those channels exist in `ConversationChannel`.
- (low) A Telegram redelivery is idempotent only while the row is `queued` or `sent`: a `queued` replay is published again under the same id (the runtime does not de-duplicate by `messageId`, see slice 2), a `sent` replay is not, and a `failed` replay is answered "Could not deliver" without a retry. The replay id is `chat-inbound-` plus a SHA-256 of provider, chat address, provider message id and agent id.
- (low) `markDelivery('sent')` after an inbound publish is tried 3 times, then logged at error with the row left `queued`. Nothing re-marks it; a stale-queued retry from the web would republish (DEC-50 accepted risk).
- (low) `markThreadDelivery` marks a send on a provider with no thread channel `refused` and logs an error, although the message did reach the chat. Unreachable today (`ChatDelivery` is Telegram only); a pre-send channel check is the proper fix when a second provider ships.
- (low) Activity feed message rows pass `deliveryStatus` through unchanged: `not_applicable` and `refused` display as raw text in the timeline "Status" row and keep severity `info`. The conversation thread already handles `refused` for the user's own messages.

### CH2W (slice 3: P3+P4)
- (medium) Reply correlation guard uses `chat_addresses.updated_at`, which the upsert bumps even when the address is unchanged (re-link, status flip). Replies to older messages then fall back to address-only resolution (safe, may drop replies). Consider an `address_changed_at` (owner decision, new column) or document as deliberate.
- (medium) Migration 0086 drops `agent_outbound_messages` with no backfill (pre-launch, no backward compatibility, DEC-01). Staging/prod history from before the mirror is lost; owner to confirm at re-provisioning.
- (owner) Remaining hand-offs: e2e gate, phase P3/P4 review, manual UAT rows OPT-02 and CH2W-01..10, ar/hi native review.

### A2A-A
- (low) `canPeerSend(agents, from, to)` takes the lookup port as first argument (spec shows two args). Rejects on lookup failure; A2A-B must catch it and refuse, with a test.

### A2A-B
- (owner, tier 3) DEC-53 (owner read routes `GET /agents/:id/peer-threads` and `.../:peerAgentId`) and DEC-54 (tool `message_peer_agent`, `agentRuntime.peer.messageMaxChars`, which refusals are recorded, stopped-recipient refusal) were proposed. **Resolved:** both approved by the owner on 2026-10-25. DEC-49 (the stop switch contract) is recorded and approved under DEC-48.
- (owner, medium) A peer message already in the recipient's stream when the owner turns the stop switch on is still delivered. **Resolved:** DEC-56 (approved) drops it at the receiving side; the agent re-checks the switch as it consumes the envelope (see PROGRESS, A2A-B review fixes).
- (owner, low) DEC-48 criterion 4 was read as "an unreadable or missing switch refuses sends; an invalid change is refused". Confirm.
- (medium) `platform-docs-data.ts` cannot be regenerated safely: the markdown sources and the hardcoded schema in `scripts/ts/build-docs-index.ts` predate the C1 and CH2W P4 hand edits. The A2A-B docs entry was merged by hand. Port the hand edits to the sources, then regenerate.
- (low, **fixed**: the test now stamps address and message from the database clock with a fixed gap; 12 of 12 reruns passed) `apps/api/src/__tests__/functional/telegram-conversation.functional.test.ts` ("routes a reply ... through the provider message index", "shows the thread ... in /log") was flaky against a Dockerised database: it seeds the address row with the app clock and the message with the database clock, and reply correlation needs the address row not to be newer. Stamp the seeded message explicitly ahead of the address save, as the db integration tests do.
- (low) The tool is in the base skill, so every agent sees `message_peer_agent` even when its user has one agent. It answers with an error and the (empty) peer list. Hiding it needs a peer count in the agent's allowance read.
- (low) A repeated agent-to-agent exchange has no turn cap, cost cap or ping-pong pause (DEC-42, DEC-45). The per-user limit of 10 per minute is the only bound.
- (low) The send tool waits for the broker reply up to 20 seconds; a broker or Redis outage shows as `broker.timeout` (retryable). A send whose publish succeeded but whose `sent` mark failed stays `queued` and is never re-published (nothing retries peer rows).
- (low) The peer card polls every 3 seconds like the conversation. A busy owner with many agents opened at once polls once per open card.
- (low) A peer message triggers the runtime's "User message received but no send_message reply was made" warning, because the shared wake counts it as a user message.

### A2A-B (code review)
- (medium, **fixed**, DEC-56) Stop switch is checked only at send time; a peer envelope already in `agent:outbound:<id>` still wakes the recipient after the switch is turned on. The receiving agent now re-checks at consume time and fails closed.
- (medium, **fixed**) `message_peer_agent` body had no hard schema `.max()`. The tool, the brokered payload and the stream payload now cap it at `PEER_MESSAGE_SAFETY_MAX_CHARS` (20000), and `messageMaxChars` cannot exceed it.
- (medium, **fixed**) Refusals each stored a thread row with the full body. Repeats of one refusal (same code, same pair) inside the rate window are now one row.
- (medium, **fixed** wording) Peer prompt wording invited ping-pong; it now says not to reply to acknowledgements or pure notifications. Residual loop/cost risk is bounded only by 10/min/user (DEC-42/45).
- (medium, pre-existing) Parent→child `message_child_agent` (`agent.user.message` without `peer`) renders as `[USER]` in the prompt; tag every agent-initiated message.
- (low, **fixed**: a repeated id now reports its stored status and republishes a failed or stale queued message; guard test for `PATCH /auth/me` added) Retry of a refused/queued id returned ok without publishing. (low, open) rate slot is spent before record/publish; `PEER_SEND_REPLY_TIMEOUT_S` is a literal (I7).

### A2A-B (gap review fixes, 2026-10-26)
- (owner, tier 3, **resolved**) DEC-57 (the agent-key read `GET /agents/:id/peer-messaging`, the 20000-character safety cap, the one-row-per-window refusal id) was approved by the owner on 2026-10-25, with (c) changed: a dropped peer message's row becomes `refused`, detail `paused`.
- (low, **fixed**, DEC-57 c) A peer message dropped by the stop switch is now `refused` in the owner's thread (detail `paused`, or `paused_check_failed` when the switch could not be read), through `agent.peer.drop` and the store method `refuseDroppedPeerMessage`.
- (medium, **fixed**) The receive gate told `paused` from an unreadable switch only by log. It now retries a failed read (`agentRuntime.peer.switchReadRetries`, `switchRetryBackoffMs`) before dropping fail closed, and the two cases carry different row details.
- (medium, **fixed**) The switch was read per wake and again per tick. One read is now reused for `agentRuntime.peer.switchCacheMs`; a dropped peer envelope sets no pending-user-message flag and requests no wake; the tick-side check runs inside the 2 s outbound read budget.
- (medium, **fixed**) A repeat of a `sent` or `queued` peer message id took a rate-limit slot and could write a refusal. It is now answered from its stored row first; only a new message or a republish takes a slot, and a republish still passes the stop switch.
- (low, open) A drop report is fire-and-forget over the inbound stream. If the platform is down when the container reports, the row stays `sent`; the drop itself still stands.
- (low) A peer message read while the agent is paused by its owner is held and checked when consumed after resume; the agent key is refused while paused, so the check cannot run earlier.
- (owner) The CH2W e2e journey `tests/e2e/journeys/03-agent-send-message.spec.ts` was rewritten and type-checks, but it has not been run (e2e is an owner hand-off). The agent reply is seeded through `seedAgentChatReply` in `tests/e2e/helpers.ts`.

### MVP gap-fix round (DEC-56/57 receive-side stop switch)
- (medium) `agent.ts` `pollWakeSignals`: `peerReceiveGate.admits` awaits inside the single-flight wake loop; a failed read is not negative-cached, so a batch of peer envelopes can delay a following `agent.wake` by up to ~2 s each. Add a short negative cache or one check per batch.
- (medium) Wake path and tick path both report drops; a transient wake-side failure can mark a row `refused` that the tick later processes. Report drops only at consumption (`filter`).
- (medium, I8) Name `PeerSendResultSchema.deliveryStatus` in DEC-57(g).
- (medium, I9) Two new `as unknown as` casts in `apps/worker/src/__tests__/integration/peer-messaging.integration.test.ts` (~372, ~427); type the `db.execute` rows.

### E2E Journey 3 (owner run, 2026-10-26)
- Failed: `getByText(userMessage, {exact: true})` could not match the bubble body because the body was a bare text node beside the `<time>` element. Fixed by wrapping the body in its own `<div>` in `AgentConversation.tsx`. Web tests (534) and `tsc` pass. Owner to re-run `run-all-tests.sh --e2e`; not run by the agent.
