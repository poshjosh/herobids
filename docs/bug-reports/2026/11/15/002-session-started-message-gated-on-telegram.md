# Bug Report: "<agent> is now ready for your instructions" missing from web chat when the owner has no Telegram chat linked

- **Status:** FIXED (in code, not deployed)
- **Severity:** Medium
- **Date:** 2026-11-15
- **Discovered By:** Manual report. A newly started agent no longer posted its first message ("<agent> is now ready for your instructions…") in web chat, although it had appeared there many times before.
- **Summary:** The session-started message is written to the web thread, but the write sat behind two Telegram checks (bot configured, owner has a Telegram chat address). An owner with no Telegram chat linked got no message in web chat at all. After a local reset no Telegram chat gets linked any more (see Contributing cause), so every agent hit this.

## Symptom

A fresh agent start shows no "Session started" platform message in the web chat. No error or warning is logged.

## Investigation (local docker stack, read-only)

- `agent_runtime_sessions`: one session (`job-searcher`, `running`, started 2026-11-15 14:19).
- `conversation_messages`: **0 rows**. The message was never written.
- `chat_addresses`: **0 rows**. The only user was created at 14:16:49 by today's reset.
- Worker logs: no "session-started" warnings or errors, which fits a silent early return.
- The web UI does not filter platform or `reminder` messages (`AgentConversation.tsx`, `conversation-thread.ts`), so the web side was not hiding it.

## Root Cause

`sendSessionStartedTelegramAnchor` in `apps/worker/src/index.ts` (wired as `AgentSessionManager`'s `onSessionStarted`):

```ts
if (!workerTelegram) return;                          // no bot token → nothing recorded
const agent = await agentRepo.getAgent(agentId);
const chatAddress = await agentRepo.getEffectiveChatAddress(agentId, 'telegram');
if (!chatAddress) return;                             // no linked Telegram chat → nothing recorded
const recorded = await conversations.recordPlatformMessage({ ..., channel: 'web', ... });
await chatDelivery.send(...);                         // Telegram
```

The function was written in `b440c9e1` (2026-06-15) as a Telegram-only reply anchor, so both gates made sense then. `c86f0694` / `71fa231d` (2026-10-25, CH2W P2–P4) moved the message into the conversation store and recorded it on the `web` channel, but kept the Telegram gates in front of the record. From then on, the web message existed only for owners with Telegram linked.

`PlatformAlertService.fireAlert` already does this correctly: it records first, tries chat, and marks the row `not_applicable` when there is nowhere to send it.

## Contributing cause (why it showed up now)

The gate has been in the code since 2026-10-25. You still saw the message because your user had a Telegram chat address. That stopped being true after today's local reset:

- `2062b0eb` (2026-10-25) cut `PATCH /auth/me` over from `telegramChatId` to `chatAddresses: [{ provider, address }]`. Unknown fields are ignored, and the call still returns 200.
- `scripts/shell/ops/quick-setup.sh` (step "Telegram", lines ~931–942), run by `reset-and-run.sh`, still sends `{ telegramChatId }`. It logs "Telegram chat ID set", but nothing is stored. Its "already set" check also reads `.telegramChatId` from `/auth/me`, a field that no longer exists.
- So a reset leaves the user without a `chat_addresses` row, and the gate above drops the web message.

`e27c9525` (2026-10-26) also made Telegram user-level only. Agent create, update and instantiation drop Telegram chat addresses. `CreateAgentSchema` is a non-strict `z.object`, so the `telegramChatId` that `create-agents.sh` and `create-eval-agents.sh` still sent was stripped without an error. It has done nothing since then.

## Fix

- New `apps/worker/src/session-started-message.ts` with `announceSessionStarted(deps, agentId)`. It has the same ordering as `PlatformAlertService.fireAlert`:
  1. Load the agent (warn and return if it is gone).
  2. **Always** record the message in the web thread (`channel: 'web'`, `subject: 'Session started'`, `messageClass: 'reminder'`). If the record fails, log an error and do not send.
  3. Send through `ChatDelivery` with `replyRequested: true`, so Telegram owners still get the reply anchor.
  4. `markThreadDelivery`: `sent` on Telegram, `not_applicable` for no address or no bot (`chat.no_address`, `chat.not_configured`), `failed` otherwise. It warns only for real send failures.
- `apps/worker/src/index.ts`: removed `sendSessionStartedTelegramAnchor`. `onSessionStarted` now calls `announceSessionStarted({ agents: agentRepo, conversations, chatDelivery }, agentId)`. The message text is unchanged.
- Unchanged: when the callback fires (`AgentSessionManager.handleHeartbeat`, first boot and activation established), the Telegram reply-anchor behavior, and the web UI.

Scripts (contributing cause):

- `scripts/shell/ops/quick-setup.sh` and `scripts/shell/ops/quick-setup-remote.sh`, Telegram step:
  - Send `PATCH /auth/me { chatAddresses: [{ provider: "telegram", address: $TELEGRAM_CHAT_ID }] }`.
  - Read the current address from `chatAddresses` (first active `telegram` entry) for the "already set" check.
  - After a 200, check that the response's `chatAddresses` holds `TELEGRAM_CHAT_ID`, and fail the step if not. A silently ignored write can no longer pass as success.
  - `quick-setup.sh` header comments updated.
- `scripts/shell/run/create-agents.sh`: removed `telegramChatId` from all four payload builders (thyper, t1inch, tintel, non-trading). A header note says Telegram comes from the user-level link that `quick-setup.sh` sets.
- `scripts/shell/run/create-eval-agents.sh`: removed the hardcoded `AGENT_TELEGRAM_CHAT_ID` (`6846862012`) and the `telegramChatId` payload field. The summary now prints `telegram : user-level (linked by quick-setup.sh)`.
  - Behavior note: the API was already dropping that hardcoded chat, so eval agents used the owner's user-level chat anyway. Nothing changes at runtime.
- `scripts/ts/build-docs-index.ts`: the agent update-schema doc entry listed `telegramChatId (string, optional): Update Telegram chat ID.` That was wrong since `e27c9525` and visible to agents through `read_app_docs`. It now documents `chatAddresses` (whatsapp, sms) and says Telegram is user-level only. `apps/worker/src/tools/platform-docs-data.ts` was regenerated, and only that line changed.

## Files Changed

- `apps/worker/src/session-started-message.ts` (new)
- `apps/worker/src/session-started-message.test.ts` (new)
- `apps/worker/src/index.ts`
- `scripts/shell/ops/quick-setup.sh`
- `scripts/shell/ops/quick-setup-remote.sh`
- `scripts/shell/run/create-agents.sh`
- `scripts/shell/run/create-eval-agents.sh`
- `scripts/ts/build-docs-index.ts`
- `apps/worker/src/tools/platform-docs-data.ts` (regenerated)
- `CHANGELOG.md`
- this report

## Verification

Done:

- `pnpm exec vitest run src/session-started-message.test.ts src/thread-delivery.test.ts src/agents/agent-session-manager.test.ts` in `apps/worker`: 3 files, 90 tests pass.
- New tests cover: the message is recorded in the web thread and marked `not_applicable` with no Telegram chat linked (no warning); the same with no bot configured; with a chat linked it is sent with `replyRequested: true` and marked `sent` on `telegram`; a failed Telegram send is marked `failed` and warned; no send when the thread record fails; nothing when the agent is gone.
- `pnpm lint` (`tsc --noEmit`): passes.
- `pnpm --filter @herobids/worker build`: passes.
- Scripts:
  - `bash -n` passes on all four shell scripts.
  - `--dry-run` passes for `quick-setup.sh`, `create-agents.sh` and `create-eval-agents.sh`.
  - The `jq` filter returns the address for an active telegram entry among others. It returns empty for a revoked entry, an empty list, and the old `{ telegramChatId }` shape.
  - The PATCH body renders as `{"chatAddresses":[{"provider":"telegram","address":"…"}]}`.
  - No `telegramChatId` payload remains under `scripts/`.
- `build-docs-index` regenerated `platform-docs-data.ts` with a one-line diff. Platform-docs tests pass (with the new test file: 2 files, 23 tests). `pnpm lint` passes again.

Not verified:

- No live run. The worker runs from a built image, so the fix needs a worker image rebuild and a fresh agent start to show up in the local stack.
- The scripts' `PATCH /auth/me` step was not run against the API. Dry-run skips API calls, and I did not write to the local DB unasked. Its request and response shape matches `apps/api/src/routes/auth.ts` (the `chatAddresses` branch and response) and `auth.test.ts`. The next `reset-and-run.sh` exercises it.
- Not checked on staging or production.

## Follow-ups

- `PATCH /auth/me` and `POST/PATCH /agents` ignore unknown fields without a warning, which is why the scripts kept "succeeding". Consider rejecting `telegramChatId` with a 400 that points to `chatAddresses`.
- Your current local user still has no Telegram chat linked. Re-run `scripts/shell/ops/quick-setup.sh`, or connect Telegram in account settings, to restore the Telegram copy and reply anchor.
