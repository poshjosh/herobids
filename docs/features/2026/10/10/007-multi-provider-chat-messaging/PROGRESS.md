# Progress log

Append-only. Newest entries at the bottom. Each entry: date, task ID, files changed, commands and results, tier-2 decisions, next ready item.

## 2026-10-25: authoring and verification

- **Authored** this entrypoint set, replacing the queue and rules in AGENT-ENTRYPOINT.md (now a pointer).
- **Verified P3.1 and P3.2 in code.** Route: `apps/api/src/routes/agent-interactivity.ts` (`POST` and `GET /messaging/chat/:provider/webhook`). Bypass: `apps/api/src/plugins/auth.ts`, pattern `^/messaging/chat/[a-z0-9-]+/webhook$`. Status set to done (DEC-14).
- **Verified the Telegram constant-time secret check.** `apps/api/src/routes/telegram-channel.ts` uses `timingSafeEqual`. `apps/api/src/routes/telegram-channel.test.ts`: 15 of 15 passed. Bug report 001 filed (FIXED). Defect origin `919f9ec7`, fix `d553c64e`.
- **Reviewed other secret and signature checks.** Stripe and Creem use a length-checked `timingSafeEqual`. No change needed.
- **Recorded** that W and E are implemented (W1 to W8, E1 to E7) with manual checks still open (W9, E8). Recorded in the 900 "W and E implementation status" section.
- **Found** that CH2W (002 two-way chat) is a draft with no code. A2A-B depends on it. Added as a blocked item.



## 2026-10-25: owner records W9 and E8 manual checks

- **W9 (M1 to M5)** and **E8 (M-E1 to M-E4)** were run by the owner on 2026-10-24 and reported passed. Recorded in [user-acceptance-tests §19](../../../../../tech/user-acceptance-tests.md). W and E are ticked in QUEUE.md (DEC-29).
- **Open:** M-E5 (SES bounce and complaint metrics after the first run). Owner.
- **Open:** EM-02 (email cap) and EM-03 (toggle default) are in the UAT file and not recorded.
- The agent did not re-run these checks.

Next ready item: C0.

## 2026-10-25: owner decisions recorded

- Recorded D01 to D09 as DEC-30 to DEC-39 in DECISIONS.md. The open list is closed.
- Queue rewritten: C2-R (independent review) and E-R1 (email rule) added. The two-way chat item (CH2W) now runs after C1.
- C1 spec: clarified that `agent_outbound_messages` keeps its delivery columns.
- C2 spec: `POST /agents/verify-telegram` is removed (DEC-34). No web caller exists. Confirmed by search.
- Plan 002: status updated and section 9 answers recorded (section 11).

Next ready item: C0.

## 2026-10-25: MVP scope change for agent-to-agent (DEC-40 to DEC-46)

- Owner decisions recorded in DECISIONS.md: same-user agents may message by default; the trading-tool risk is accepted for the MVP (DEC-41); one per-user rate limit of 10 per minute (DEC-42); owner view and a per-user stop switch (DEC-43); prompt-injection stance deferred (DEC-44).
- Deferred with specs kept: C2, C2-R, E-R1, U, the grant table and screen, A2A-C, A2A-D (DEC-45).
- A2A-A reduced to the same-user check. Its old grant spec file was removed and replaced by `A2A-A-same-user-check.md`.
- A2A-B rewritten as the MVP send path.
- Queue order: C0, C1, CH2W, A2A-A, A2A-B (DEC-46).
- Known gap accepted: chat address claims are unverified until C2 ships. Recorded for the owner.
- No code changed. No tests run.

Next ready item: C0.

## 2026-10-25: C0 baseline

- **Files changed (docs only, no code):** `900-implementation-plan.md` (new "C0 baseline record (2026-10-25)" section), `095-chat-address-migration-plan.md` (§6 conflicting figures replaced with a pointer to 900), `QUEUE.md` (C0 ticked), `PROGRESS.md`.
- **Tree:** `git status` clean at start (HEAD `f0f5c2ad`). No install needed (dependencies present, no manifest change).
- **`pnpm test`:** completed, exit 1. 413 files: 1 failed, 376 passed, 36 skipped. 7457 tests: 2 failed, 6991 passed, 464 skipped. Duration about 31 s.
- **Failures:** both in `packages/domain/src/config/schema.test.ts` (`AppConfigSchema — agentCreation`, "defaults the agent-creation limits to 10 / 10 / 6 when the block is absent" and "accepts zero and positive operator overrides"). Cause: `platformApiTimeoutMs` (schema.ts:565, default 10000; config/default.yaml:101) was added in `4089b51f` and the tests' expected objects were not updated. Pre-existing, unrelated to messaging, not touched by this item.
- **Type checks:** `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0; `apps/worker` exit 0; `packages/db` exit 0.
- **Tier-2 decisions:** (1) Did not fix the 2 stale tests, because the acceptance says no code changed. They are recorded as known baseline failures. Fixing them is a one-line-per-test change for a later item or the owner. (2) Ticked C0: its acceptance is that `pnpm test` completes and counts are recorded, not that it is green. (3) The old 362/28 and 6816/6829 figures count differently from the current run (413 total files). They are marked superseded rather than reconciled.
- **Not committed.** Changes are left unstaged for the coordinator.

Next ready item: C1.

## 2026-10-25: C1 cutover

All changes are unstaged and uncommitted, for review by the coordinator. Start state: `git status` clean at `874d6949`.

### Files changed

- **Schema and migration (`packages/db`):** new `src/schema/chat-suppressions.ts`; removed `users.telegramChatId`, `agents.telegramChatId`, and `agent_outbound_messages.telegramMessageId` and `.telegramChatId`; new migration `drizzle/0083_lying_zaran.sql` (+ journal and snapshot). 0076 and 0077 are unchanged.
- **Repository (`packages/db/src/agent-repository.ts`, `index.ts`):** `setTelegramChatAddress` replaced by `setChatAddress(executor, scope, provider, address | null)`; new `revokeChatAddress`, `normalizeChatAddress`, `listChatAddressesForOutput` (one batched query); deleted `getEffectiveTelegramChatId`, `resolveAgentForTelegramReply`, the legacy fallbacks and the `''` and blank filters; `isChatAddressSuppressed` reads `chat_suppressions`; `resolveAgentForChatReply` checks suppression first and uses the delivery columns only; `markOutboundMessageSent` writes the delivery columns only.
- **API (`apps/api`):** new `src/agents/chat-addresses.ts` (Zod input schema, apply helper, batched output helper); `routes/agents.ts` (create and PATCH accept `chatAddresses`; create, list, get, PATCH and go-live responses return it); `routes/auth.ts` (PATCH `/auth/me` accepts `chatAddresses`; GET and PATCH return the user-level rows; four user inserts no longer set a legacy column); `routes/agent-interactivity.ts` (new `findUserByTelegramChatId` on `chat_addresses` plus suppression, used by `processWebhookUpdate` and `processWebhookDocument`; `resolveReply` uses `resolveAgentForChatReply`; dead `telegramChatId` removed from the PUT schema; PUT response returns `chatAddresses`); `routes/blueprints.ts` (same-user pre-fill copies the author's user-level rows); `services/agent-instantiation-service.ts`, `services/agent-go-live-service.ts`, `agents/agent-create-normalization.ts`, `services/blueprint-projection.ts` (comment); `config.ts` (env mapping).
- **Worker (`apps/worker`):** `index.ts` session anchor uses `getEffectiveChatAddress(agentId, 'telegram')`; `alerting/chat-delivery.ts` error text `no_chat_address`; `alerting/telegram-chat-wiring.ts` and `alert-dispatcher.ts` (new `AlertDispatcherConfig` type); `config.ts` env mapping; `tools/platform-docs-data.ts` and `agent.ts`.
- **Domain (`packages/domain`):** `CHAT_PROVIDERS` constant in `ports/chat-channel.ts`; `config/messaging-chat.ts` (no legacy fallback); `config/schema.ts` (`alerts.telegram` keeps only `channels`); `config/default.yaml`.
- **Web (`apps/web`):** `lib/chat-addresses.ts` (+ test); `lib/api-client.ts` types (`ChatAddressEntry`, `ChatAddressInput`, `chatAddresses` on `Agent` and `MeResponse`); form field renamed `telegramChatId` to `telegramAddress` in `agent-form-state.ts`, `agent-payloads.ts`, `AgentFormBody.tsx`, `EditAgentModal.tsx`, `CreateAgentFlow.tsx`, `SettingsPage.tsx`; payloads send `chatAddresses: [{ provider: 'telegram', address }]`; locale error key `auth.profile.invalid_chat_addresses` (en, ar, hi) replaces the removed `invalid_telegram_chat_id`.
- **Tests:** rewritten `packages/db/src/agent-repository.test.ts` (chat part) and `chat-address-resolution.integration.test.ts` (now also covers migration 0083); `chat-addresses-backfill.integration.test.ts` loses the dual-read parity case; updated tests in `apps/api` (auth, agents, agent-interactivity, slash-commands webhook and functional, blueprints and child-create integration, go-live, instantiation, three fixtures), `apps/worker` (chat wiring, env drift, broker), `packages/domain` (messaging-chat, notifications-config), `apps/web` (payloads, form state, six fixtures).
- **Separate small change (C0 Outstanding Issue):** `packages/domain/src/config/schema.test.ts` expected objects gained `platformApiTimeoutMs: 10000` in the two stale `agentCreation` tests. No production code touched.
- **Docs:** this entry and QUEUE.md.

### Commands and results

| Check | Result |
| --- | --- |
| `npx tsc -p packages/db/tsconfig.json --noEmit` | exit 0 |
| `npx tsc -p apps/api/tsconfig.json --noEmit` | exit 0 |
| `npx tsc -p apps/worker/tsconfig.json --noEmit` | exit 0 |
| `cd apps/web && npx tsc --noEmit -p tsconfig.json` (web, includes tests) | exit 0 |
| `pnpm lint` (root `tsc --noEmit`) | exit 0 |
| `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` (I1) | 9 files passed, 1 skipped (needs DB and Redis); 196 passed, 31 skipped |
| `cd packages/db && pnpm exec vitest run` | 19 files passed, 8 skipped (integration, no DB); 264 passed, 64 skipped |
| `pnpm test` (final run) | exit 0. 414 files: 0 failed, 378 passed, 36 skipped. 7469 tests: 0 failed, 7001 passed, 468 skipped |
| `pnpm --filter @herobids/db run db:generate` after the hand edit | "No schema changes, nothing to migrate" |

**Comparison with the C0 baseline** (413 files: 1 failed, 376 passed, 36 skipped; 7457 tests: 2 failed, 6991 passed, 464 skipped): no drop in passing tests. Passed rose by 10: 2 are the fixed stale tests, and 8 are net new (repository, route, webhook, config, web). Skipped rose by 4: the rewritten DB integration files have more cases, and they skip without a local `DATABASE_URL`. Total files rose by 1 (new web helper test). The 2 known `schema.test.ts` failures are fixed (see above).

**DB integration (DEC-24).** Container: `docker run -d --name herobids-c1-pg17 -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -p 55432:5432 postgres:17-alpine` (plus a throwaway `redis:7-alpine` on 56379 for the functional test). Dev compose Postgres on 5432 was not touched. Database `herobids_c1` was created in it and migrated with `DATABASE_URL=postgres://postgres:postgres@localhost:55432/herobids_c1 pnpm --filter @herobids/db run db:migrate`.
- All seven `packages/db/src/*.integration.test.ts`: `DATABASE_URL=...:55432/herobids_c1 pnpm exec vitest run --fileParallelism=false src/*.integration.test.ts` gives 7 files, 55 tests passed. Run in parallel, `push-subscription-repository.integration.test.ts` fails because several files truncate `users` at once. That is a pre-existing race. The repo's own `test:integration` script uses `--fileParallelism=false`.
- `pnpm test:integration` (the repo script, 9 files): 106 tests passed.
- API integration files touched by C1, `blueprints.integration.test.ts` (81) and `agent-child-create.integration.test.ts` (29): passed. `telegram-slash-commands.functional.test.ts` (31, needs Redis): passed.
- Both containers removed with `docker rm -f herobids-c1-pg17 herobids-c1-redis` (verified: only the compose `herobids-postgres-1` and `herobids-redis-1` remain).

**Migration from zero (local, disposable).** `db:migrate` applied 84 migrations to the empty `herobids_c1` database: "migrations applied successfully". Afterwards `information_schema.columns` shows no column named `telegram%` in any table in `public`, and `chat_suppressions` exists with primary key `(provider, address)`. The migration is also covered by `chat-address-resolution.integration.test.ts` (data steps: blank and non-active rows, legacy columns dropped, delivery columns kept). The warning `25P01 there is no transaction in progress` during migrate comes from older migration `0029` (it contains its own `COMMIT`), not from 0083.

### Acceptance grep (`grep -rnE "telegram_chat_id|telegramChatId|telegram_message_id" apps packages --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=dist`)

Final run: 41 hits. None is a legacy-column read or write.

| Hits | Where | Why it stays |
| --- | --- | --- |
| 5, 5, 1, 1 | `agents.test.ts`, `auth.test.ts`, `agent-instantiation-service.test.ts`, `blueprint-projection.test.ts` | Tests that assert the field is gone from responses, rows, or blueprint payloads |
| 12 | `packages/db/src/chat-addresses-backfill.integration.test.ts` | It tests migration 0077 on a database stopped at 0076, where the legacy columns still exist. It runs only up to 0077 |
| 1 (+ 3 per locale file, 3 in `AgentFormBody.tsx`, 1 in `i18n-regressions.test.ts`) | web `agents.create.telegramChatId`, `agents.create.telegramChatId.placeholder`, `agents.telegramChatId.help` | UI label keys. The C1 spec says "i18n keys stay as they are" (also 095 §1). They are text keys, not field names. Renaming them is a later cosmetic change if the owner wants the gate to be literal |
| 1 | `packages/domain/src/config/schema.ts:683` (`alerts.operator.telegramChatId`) | Operator alert target (fault reports), operator config, unrelated to the legacy columns. Same for `apps/worker/src/index.ts` (2 hits) and `apps/worker/src/config.ts` (`OPERATOR_ALERT_TELEGRAM_CHAT_ID`) |

The coordinator should decide whether the literal gate needs the i18n keys and the operator config key renamed. I did not, because the spec says to keep the i18n keys and DEC-12 only removes the `alerts.telegram.*` alias.

### Tier-2 decisions

1. **`chat_suppressions` key.** Composite primary key `(provider, address)` instead of a separate `id` plus unique constraint. It is the unique key DEC-03 asks for, with no surrogate column.
2. **Migration data steps (hand-edited 0083, run before the drops).** Non-active `chat_addresses` rows are copied to `chat_suppressions` (trimmed address, `revoked` wins over `pending_optin`) and then deleted. Blank (`''`) rows are deleted (DEC-02). No production writer sets these, so this is a safety net for environments that are not torn down.
3. **Address normalisation (DEC-08).** `normalizeChatAddress`: trim for all providers; phone-based providers (`whatsapp`, `sms`) also drop spaces, dots, dashes and parentheses. The leading `+` is not invented, since the country is unknown. Full E.164 validation belongs to C2.
4. **`chatAddresses` contract.** Request body (agent create and PATCH, `PATCH /auth/me`): `chatAddresses: [{ provider: 'telegram'|'whatsapp'|'sms', address: string | null }]`, at most one entry per provider, address up to 64 characters. A null or blank address clears that provider's address for the scope (deletes the active row). Providers are the domain `CHAT_PROVIDERS` constant (added so the type and the schema share one source). Response: `chatAddresses: [{ provider, address, scope: 'user'|'agent', status }]`. Agent responses carry the agent's own override rows (`scope: 'agent'`), which is what `telegramChatId` carried before. `GET` and `PATCH /auth/me` carry the user-level rows (`scope: 'user'`). An invalid body returns 400 `auth.profile.invalid_chat_addresses` on `/auth/me` and the standard `validation_error` on agent routes.
5. **Go Live and blueprint pre-fill** copy active rows as `chatAddresses` input: go-live copies the source agent's own rows (read inside the transaction), the blueprint pre-fill copies the installer's user-level rows when the installer is the blueprint author. Behaviour is the same as before.
6. **Inbound user lookup** (`findUserByTelegramChatId`): user-level, active, `telegram` row for the chat ID, joined to `users`, ordered by `created_at, id` for a deterministic pick. A suppressed address binds nobody. A suppression lookup error propagates, so the update is not processed (fail closed, I4). The stale "bind your Telegram account first" wording is C2 (DEC-11) and is unchanged.
7. **Alert dispatcher config.** `alerts.telegram` keeps only `channels`. The dispatcher still needs a bot token, so `resolveWorkerTelegramChat` returns a new `AlertDispatcherConfig` type (alerts config plus the resolved `botToken`). Unknown legacy keys in `alerts.telegram` are silently ignored by Zod. Env var names (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_URL`) are unchanged, so the committed `.env*.example` twins need no edit. Anyone who set the keys only in YAML must move them to `messaging.chat.telegram.*` (hand-off below).
8. **`markOutboundMessageSent`** keeps its signature (id, provider message ID, address) and still records `telegram` as the provider. A provider-aware signature belongs to CH2W, which retires the table.
9. **`/auth/me` PATCH write.** The profile update is unchanged and not transactional; the address writes run in one transaction (several providers apply together or not at all).
10. **Error text** `no_telegram_chat_id` became `no_chat_address` (delivery error stored on a failed outbound row, worker only).
11. **Go-live read order.** The source agent's chat addresses are read inside the transaction after the existing revalidation reads, so the existing mock order in the go-live tests only needed one more queued result.
12. **Not done:** a worker unit test for the session-start anchor (095 M2 said none exists). The anchor now calls `getEffectiveChatAddress`, which has repository tests; the function itself is module-private in the worker entrypoint.

### Open items for the coordinator

- Review the grep decision above (i18n keys, operator config key, backfill test).
- The `docs` 900 plan and 095 §5 still describe the old staged tasks. They are historical (095 §0 supersedes them). Not edited.
- `agent-repository.ts` still hard-codes `'telegram'` in `markOutboundMessageSent`. It existed before C1 and is not a new I2 hit.

### Owner hand-off (not performed, DEC-13)

Staging and production are owner-run. Local and dev were not torn down by this item (only a disposable container database was migrated).

1. **Before merging or deploying C1 to an environment:** if that environment has real chat addresses worth keeping, first check that 0077 ran there. Migration 0083 drops the four legacy columns without copying them.
2. **Config.** Move any `alerts.telegram.botToken`, `webhookSecret`, `webhookUrl` set in YAML or Terraform-rendered config to `messaging.chat.telegram.*`. Env vars with the old names keep working. Keep `alerts.telegram.channels` where it is.
3. **Teardown and re-provision per environment** (staging, then production), as chosen by the owner under DEC-13: stop the API and worker, drop or recreate the database, run `pnpm --filter @herobids/db run db:migrate` with that environment's `DATABASE_URL` (applies 0000 to 0083 from zero), start the services, and re-register the Telegram webhook (the worker does this at startup when `messaging.chat.telegram.webhookUrl` and `webhookSecret` are set). Users re-enter their Telegram chat ID in Settings (it is now stored as a `chat_addresses` row).
4. **Verify after deploy:** `GET /auth/me` returns `chatAddresses` and no `telegramChatId`; save a Telegram ID in Settings; send a message to the bot and confirm routing; reply to an agent message and confirm routing.
5. **Web.** The web app must deploy with the API in the same release (the field name changed, DEC-10).

Next ready item: CH2W.
