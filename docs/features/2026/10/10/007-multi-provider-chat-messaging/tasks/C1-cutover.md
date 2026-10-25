# C1: Cutover to chat_addresses and chat_suppressions

**Depends on:** C0. **Approvals:** DEC-01 to DEC-05, DEC-08 to DEC-10, DEC-12, DEC-13, DEC-23, DEC-24. **Design:** [095 §0](../095-chat-address-migration-plan.md) (decision record) and §2 (reader and writer inventory, line numbers in 095 are historical, as of 2026-10-24. Locate each site by the symbol or string named in this spec, not by line number).

## Objective

Remove the Telegram-named columns and dual-read. After C1, every address is read from `chat_addresses`, every opt-out from `chat_suppressions`, and the API returns `chatAddresses`. This is one change, not a staged rollout. No backward compatibility is needed (DEC-01).

## Scope

In scope:

1. **Schema.** Add `packages/db/src/schema/chat-suppressions.ts` per DEC-03: `provider`, `address`, `status` (`revoked` | `pending_optin`), `created_at`, unique `(provider, address)`, no foreign keys. Remove the Drizzle fields `users.telegramChatId` (`packages/db/src/schema/users.ts`), `agents.telegramChatId` (`agents.ts`), and `telegramMessageId` and `telegramChatId` (`agent-outbound-messages.ts`).
2. **Migration.** Generate with `db:generate`. Review the SQL by hand. Drop the four legacy columns: `users.telegram_chat_id`, `agents.telegram_chat_id`, and the two Telegram-named columns of `agent_outbound_messages` (`telegram_message_id`, `telegram_chat_id`). `agent_outbound_messages` keeps its delivery columns and is not rewritten. Its later retirement belongs to CH2W (DEC-31). Keep the existing 0076 and 0077 migrations unchanged, since they must still apply on a fresh database.
3. **Repository** (`packages/db/src/agent-repository.ts`):
   - Replace `setTelegramChatAddress` with a provider-neutral `setChatAddress(executor, scope, provider, address | null)`. A null address deletes the active row (DEC-02). A non-null address upserts an active row and never touches a suppression row (DEC-04). Normalise the address (DEC-08).
   - Add `revokeChatAddress(executor, scope, provider)`. It deletes the active row and writes the suppression row (DEC-03). No production caller exists yet. Tests cover it.
   - Delete `getEffectiveTelegramChatId` and every legacy fallback. Remove the `''` branch and the blank filters.
   - `isChatAddressSuppressed` reads `chat_suppressions`.
   - `resolveAgentForChatReply` uses only the delivery columns, plus the suppression check. Remove the legacy pair fallback. `resolveAgentForTelegramReply` is deleted.
4. **Writers to change** (95 §2.1 W1 to W10): `agents.ts` create and PATCH, `auth.ts` PATCH `/auth/me` and the four user-insert sites, `agent-instantiation-service.ts`, and `agent-repository.ts` `markOutboundMessageSent`.
5. **Readers to change** (95 §2.2 R1 to R14): `apps/worker/src/index.ts` (session anchor uses `getEffectiveChatAddress(agentId, 'telegram')`), `apps/worker/src/agents/agent-message-broker.ts` (send path), `agent-interactivity.ts` (search for `processWebhookUpdate`, `processWebhookDocument`, and `resolveReply`), `blueprints.ts` (search for `Same-user pre-fill`), `agent-go-live-service.ts` (search for `sourceAgent`).
6. **API output.** Add one batched helper that returns `chatAddresses` for a list of agent IDs and a user ID. Every response that returns an agent or a user adds `chatAddresses` from it. Route sites to cover, from a search of `select().from(agents)` in `apps/api/src/routes/agents.ts`: the create response, `GET /agents`, `GET /agents/:id`, PATCH responses, and the blueprint create response. Check `agent-interactivity.ts` and `exports.ts` for raw-row emission. Remove `telegramChatId` from the PUT agent schema (DEC-10).
7. **Web.** `apps/web/src/features/agents/agent-form-state.ts` (search for `telegramChatId`), `AgentFormBody.tsx`, `EditAgentModal.tsx`, `CreateAgentFlow.tsx`, `SettingsPage.tsx`, and `apps/web/src/lib/api-client.ts`. Read `chatAddresses` and send it on save. i18n keys stay as they are.
8. **Config.** Remove the `alerts.telegram.*` config alias (DEC-12): `packages/domain/src/config/messaging-chat.ts` legacy fallback, and the env mapping in `apps/api/src/config.ts` and `apps/worker/src/config.ts`. Point the Telegram env vars at `messaging.chat.telegram.*`. Update the committed `.env*.example` twins in the same commit. Keep the `/telegram/webhook` route alias (DEC-12).
9. **Worker tool docs.** Update `apps/worker/src/tools/platform-docs-data.ts` (search for `telegramChatId (string, optional)`) to describe `chatAddresses`. Check `apps/worker/src/agent.ts` (search for `telegramChatId?: string;`).
10. **Tests.** Update the test files that reference the legacy names (95 §5 M9 list). Rewrite `packages/db/src/agent-repository.test.ts` for neutral rows. Add these cases:
    - Revoke X, then save Y. X remains blocked by its suppression row.
    - Clear the address. No row remains.
    - Inbound from a suppressed address resolves to nothing.
    - The list endpoint returns `chatAddresses` for two agents in one query.
    - Telegram send and reply routing pass on neutral rows.

## Out of scope

- The bind flow and the 409 rule (C2).
- Any change to webhook secret verification.
- Any new provider.
- Deleting the Telegram route alias.

## Steps

1. Locate each site by its symbol or string, not by line number. If a symbol has moved or been renamed, record the new location in PROGRESS.md.
2. Make the schema and migration changes. Commit.
3. Make the repository changes and their tests. Run `npx tsc -p packages/db/tsconfig.json --noEmit` and `pnpm exec vitest run packages/db`. Commit.
4. Make the reader and writer changes in the worker and the API. Run the type checks for `apps/api` and `apps/worker`. Commit.
5. Make the API output and web changes. Commit.
6. Make the config and `.env` changes. Commit.
7. Run the verification below. Record the results in PROGRESS.md.

## Acceptance (all required)

- `grep -rnE "telegram_chat_id|telegramChatId|telegram_message_id" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist` returns hits only in tests that assert the response field name, and in migrations 0076 and 0077. Record the output in PROGRESS.md. Any other hit fails the gate.
- Type checks pass for `packages/db`, `apps/api`, `apps/worker`, and the web project.
- `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` passes (I1).
- `pnpm exec vitest run packages/db` passes, including the new cases.
- All seven `packages/db/src/*.integration.test.ts` files pass against a disposable Postgres 17. Record the container command, then remove the container (DEC-24).
- `pnpm test` passes, with counts compared to the C0 baseline. Any drop is explained.
- The migration applies to a fresh local database from zero (`db:migrate`), and the legacy columns are absent afterwards.

## Rollback

Revert the commits. Local and dev can be re-provisioned from migrations (DEC-13).

## Hand-off

Staging and production teardown and re-provisioning are owner-run (DEC-13). Write the exact steps for the owner in PROGRESS.md. Do not run them.
