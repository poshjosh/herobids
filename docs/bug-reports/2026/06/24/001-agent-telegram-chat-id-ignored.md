- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-24
- **Summary:** Agent-level `telegramChatId` was ignored — all outbound Telegram messages were delivered to the user-level chat ID instead. An agent configured with `telegramChatId = 6846862012` had its messages delivered to the user's `telegramChatId = 8681143261` instead.
- **Root Cause:** The repository method `getUserTelegramChatId` in `packages/db/src/agent-repository.ts` only queried `users.telegramChatId` via a JOIN, completely ignoring the `agents.telegramChatId` column. All three Telegram delivery call sites used this method:
  1. `apps/worker/src/index.ts` — `sendSessionStartedTelegramAnchor`
  2. `apps/worker/src/agents/agent-message-broker.ts` — `handleSendMessage` (agent `send_message` tool)
  3. `apps/worker/src/alerting/platform-alert-service.ts` — `PlatformAlertService.fireAlert`
- **Fix:**
  1. Renamed `getUserTelegramChatId` → `getEffectiveTelegramChatId` with updated query that selects both `agents.telegramChatId` and `users.telegramChatId`, resolving with priority: **agent-level > user-level > null**.
  2. Updated all 3 call sites to use `getEffectiveTelegramChatId`.
  3. Updated `apps/worker/src/agents/agent-broker-email.test.ts` mock to reference the renamed method.
- **Files Changed:**
  - `packages/db/src/agent-repository.ts` — replaced `getUserTelegramChatId` with `getEffectiveTelegramChatId`
  - `apps/worker/src/index.ts` — updated call site
  - `apps/worker/src/agents/agent-message-broker.ts` — updated call site + comment
  - `apps/worker/src/alerting/platform-alert-service.ts` — updated call site + log messages
  - `apps/worker/src/agents/agent-broker-email.test.ts` — updated mock reference
- **Verification:**
  - `pnpm lint` passes (TypeScript strict, no errors)
  - `pnpm test` — 3079 tests pass, 0 failures
