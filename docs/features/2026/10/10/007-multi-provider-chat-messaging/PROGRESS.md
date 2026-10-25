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

## 2026-10-25: CH2W slice 1 (P0 inventory and P1 store). CH2W is not finished and is not ticked

Scope of this slice: plan phases P0 and P1 of [002 two-way agent chat](../../15/002-two-way-agent-chat/001-plan.md), using the approved [schema note](../../15/002-two-way-agent-chat/002-schema-note.md) (DEC-47). No callers, no route or web change, `agent_outbound_messages` untouched. P2, P3 and P4 are not started.

### P0 result

Inventory recorded in the plan appendix (section 10 of the plan): 4 writers, 7 readers, the tests, and the five gaps between the schema note and the readers. Go or no-go:

- P1: go (done in this slice).
- P2: go, provided the agent-delete cleanup (plan 10.6 item 2) lands in the same phase, because P2 is the first phase that writes rows.
- Retirement of `agent_outbound_messages` (P3): conditional go, blocked on the two owner questions below.

Findings that correct the plan text (plan 10.1): the web POST already stores the user's message in `agent_outbound_messages` (the "never stores them" claim in plan section 1 is stale); Telegram inbound is not recorded; replies reach the thread through `send_message` (R2 is not a gap for replies; plain-text output is never delivered, as before).

### Files changed

- Migration: `packages/db/drizzle/0084_long_agent_zero.sql`, `drizzle/meta/0084_snapshot.json`, `drizzle/meta/_journal.json` (generated; creates `conversations`, `conversation_participants`, `conversation_messages`, their indexes and foreign keys, and `users.peer_messaging_paused boolean not null default false`).
- Schema: `packages/db/src/schema/{conversations,conversation-participants,conversation-messages}.ts` (new), `schema/index.ts`, `schema/users.ts` (one column).
- Repository: `packages/db/src/conversation-repository.ts` (`ConversationRepository`, implements the domain port), `packages/db/src/index.ts` (export).
- Domain: `packages/domain/src/conversations/{conversation,conversation-service}.ts` (types, error codes, `ConversationService`), `packages/domain/src/ports/conversation-store.ts` (port), exports in `ports/index.ts` and `src/index.ts`; config `messaging.conversations.*` in `packages/domain/src/config/schema.ts` and `config/default.yaml`.
- Tests: `packages/domain/src/conversations/conversation-service.test.ts` (new), `packages/domain/src/config/messaging-conversations-config.test.ts` (new), `packages/db/src/conversation-repository.integration.test.ts` (new).
- Docs: plan `001-plan.md` (status line and appendix 10), this entry.

Not staged, not committed.

### Commands and results

| Command | Result |
| --- | --- |
| `pnpm --filter @herobids/db run db:generate` | `0084_long_agent_zero.sql` generated; contains only the tables and column in the schema note |
| `pnpm --filter @herobids/domain run build`, `pnpm --filter @herobids/db run build` | pass (needed so db sees the new domain exports) |
| `npx tsc -p packages/domain/tsconfig.json --noEmit`, `packages/db`, `apps/api`, `apps/worker` (and `apps/web`, `pnpm lint`) | all clean |
| `cd packages/domain && pnpm exec vitest run conversation messaging-conversations` | 2 files, 26 tests passed (service 22, config 4) before a later trim of two redundant guards; re-run as part of the next row |
| `pnpm exec vitest run packages/db packages/domain` (no `DATABASE_URL`) | 71 files passed, 9 skipped; 1474 tests passed, 88 skipped |
| `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` (I1) | 9 files passed, 1 skipped; 196 tests passed, 31 skipped |
| Disposable container: `docker run -d --name herobids-ch2w-pg -e POSTGRES_PASSWORD=ch2w -p 55432:5432 postgres:17-alpine` | started; the already-running `herobids-postgres-1` was not used or touched |
| `DATABASE_URL=postgres://postgres:ch2w@localhost:55432/postgres pnpm exec vitest run --fileParallelism=false packages/db/src/conversation-repository.integration.test.ts` | 1 file, 24 tests passed (scratch database, all migrations 0000 to 0084 applied) |
| `DATABASE_URL=… pnpm --filter @herobids/db run db:migrate` (container only) | applied, 85 migrations recorded |
| `DATABASE_URL=… pnpm exec vitest run --fileParallelism=false --pool=forks --poolOptions.forks.singleFork packages/db` | 27 files passed, 1 skipped; 343 tests passed, 9 skipped (all db integration files incl. the other seven). A first run before `db:migrate` failed 11 tests in files that expect a migrated `DATABASE_URL` database; the failure was the empty database, not code |
| `docker rm -f herobids-ch2w-pg` | container removed (0 left) |

Full `pnpm test` was not run: the item is not being ticked.

Re-run after the review fixes below (same commands, fresh container `herobids-ch2w-pg`, removed afterwards): tsc for `packages/domain`, `packages/db`, `apps/api`, `apps/worker` and `pnpm lint` clean (domain and db were rebuilt first so db sees the new domain exports); `pnpm exec vitest run packages/domain packages/db` 71 files passed, 9 skipped, 1488 tests passed, 100 skipped; conversation integration file against the container 36 tests passed (was 24); I1 gate `telegram chat-inbound agent-message-broker platform-alert` 9 files passed, 1 skipped, 196 tests passed, 31 skipped. The race test was checked by mutation: with the old participant insert and a returned (not thrown) refusal it fails with a third, foreign participant row.

### What the DB tests prove

Migration shape (columns, nullability, the four indexes including the partial unique `peer_key` index, `users.peer_messaging_paused` default); one `agent_agent` thread per peer key and unlimited `user_agent` threads; cascades from conversation to participants and messages and from owner to conversations; first write creates the conversation and two participants; eight concurrent first writes on separate connections create one conversation and two participants; a retried id (sequential and six concurrent) inserts once and returns `created: false` without moving `last_message_at`; an id owned by another conversation or sender is refused and the other row is not returned; a non-owner write is refused and writes nothing; `last_message_at` never moves backwards; `markDelivery` for sent, failed, refused and unknown ids; `listThread` ordering, before-cursor walk with no gaps or repeats, same-timestamp tie-break, per-agent separation, non-owner and empty reads, and the page-size clamp.

### Tier-2 decisions

1. **Layout (ports and adapters).** `ConversationService` and the `ConversationStore` port live in `packages/domain` (pure, no node imports, so the web bundle stays safe). The Postgres adapter `ConversationRepository` lives in `packages/db`. Ids and the clock are injected (`newId`, `now`). The service is the only caller of the store.
2. **Deterministic user-agent conversation id.** `user_agent:{agentId}`. The schema note enforces one thread per pair with `peer_key` but names no constraint for `user_agent`. A derived primary key makes concurrent first writes safe with `ON CONFLICT DO NOTHING`, with no advisory lock and no new key. Peer threads (A2A-B) use `peer_key` and are not built here.
3. **Hot path does not write the conversation.** The repository reads the conversation first and creates it (conversation, then two participants, then re-read for the owner check) only when absent. Per message: one read, one insert, one conditional update, in one transaction. Nothing loops over rows.
4. **Idempotency (002 D5).** Message insert uses `ON CONFLICT (id) DO NOTHING`. A repeat returns the stored row (`created: false`) only when the conversation, sender type and sender id match; otherwise `conversation.message_id_conflict`, so a guessed or reused id cannot read another thread's row.
5. **Owner check fails closed.** A conversation whose owner differs from the caller returns `conversation.owner_mismatch` and writes nothing (see review fix 1: the transaction is rolled back). `listThread` joins on `owner_user_id` in the same single query, so a non-owner reads an empty thread.
6. **Timestamps from the service clock.** Rows get millisecond `created_at` from `now()`, not the database default, so a `before` cursor built from a returned `Date` cannot skip rows that differ only in microseconds. `listThread` orders by `(created_at desc, id desc)` and returns ascending, and pages with a `(created_at, id)` cursor (review fix 2).
7. **Operator-config limits (I7).** New `messaging.conversations`: `userMessageMaxChars` 4000 (the existing cap), `threadDefaultPageSize` 50, `threadMaxPageSize` 200, with a refine that default does not exceed max. No env var, so no `.env*.example` change. The API route still has its own `max(4000)`; P2 switches it to this value.
8. **Channels and statuses.** `web | telegram | internal` and `queued | sent | failed | not_applicable | refused`, exactly as the schema note, typed in the domain. The three `record*` methods reject `internal` at the type level (peer sends belong to A2A-B). The service also checks both enums at runtime (review fix 5), as a cheap guard for untyped callers.
9. **Creator-agent messages.** `recordAgentMessage` takes an optional `senderAgentId`, so the existing creator-to-child message keeps its own authorship in the child's thread (today `authored_by = agent:{id}`).
10. **Errors.** `Result<T, DomainError>` with codes `conversation.{invalid_message,body_too_long,owner_mismatch,message_id_conflict,message_not_found,store_failed}`. Database errors are caught in the adapter and returned as `store_failed` with only the error name in context.
11. **Not built in P1:** agent-pair (`peer_key`) creation, thread-list-by-owner query, the stop-switch write path (A2A-B, DEC-48), and a repository method to delete an agent's conversations (plan 10.6 item 2; P2).

### Review fixes (same slice, still unstaged)

A code review of the slice found these; all are fixed and covered by tests.

1. **HIGH, ownership bypass in the first-write race** (`conversation-repository.ts`). The conversation insert now uses `.onConflictDoNothing().returning({ id })` and participants are inserted only by the writer that got a row back. A loser re-reads the conversation and compares the owner. A mismatch throws a private `OwnerMismatchRollback` inside the transaction, so Postgres rolls back and nothing is persisted (a returned refusal used to commit the foreign participant rows); the catch maps it to `conversation.owner_mismatch`. The mismatch on an already existing conversation takes the same path. Test: a second connection holds an uncommitted winner (conversation and participants), the intruder's insert is observed blocked in `pg_stat_activity` (wait event `Lock`), then the winner commits; the intruder is refused and only the winner's two participants and no messages exist.
2. **MEDIUM, cursor skipped rows sharing a timestamp.** The cursor is now the pair (`before`, `beforeId`) and the filter is the row comparison `(created_at, id) < (before, beforeId)`, matching the `created_at desc, id desc` order. `ListUserAgentThreadInput` gains `beforeId: string | null`; `ListThreadInput` gains `beforeId?: string`. Both halves or neither: one without the other is `conversation.invalid_cursor`. The service doc comment that claimed a `Date` cursor alone never skips a neighbour was wrong and is rewritten. Test: seven rows with one timestamp plus an older row, paged three at a time, with no gaps or repeats.
3. **MEDIUM, `markDelivery` had no guard.** One conditional `UPDATE ... WHERE id = ? AND delivery_status = 'queued'`, so the check and the write are atomic. Allowed: `queued` to `sent`, `failed` or `refused`. `sent`, `failed`, `refused` are final; nothing returns to `queued`; `not_applicable` rows are never marked. Omitted `detail` and `providerMessageId` are left out of `SET` (the port documents null as "unchanged"), so a later mark cannot null stored values. The domain exports `CONVERSATION_DELIVERY_FROM` and `CONVERSATION_DELIVERY_TARGETS`; the port type of `status` narrows to the targets.
   **Decision on reporting (tier 2):** a disallowed transition is `Result` error `conversation.invalid_delivery_transition` (message `invalid_delivery_transition`). From the repository the context is `{ from, to }`, where `from` is the stored status; from the service (target `queued` or `not_applicable`, rejected before the store call) the context is `{ to }`. An unknown id stays `conversation.message_not_found`. A repeat of the same mark (for example a worker retry after a crash) is also an invalid transition, not a silent success; callers that retry must treat that code as "already marked" after reading the row. This is strict on purpose and easy to relax to an idempotent same-status no-op if P2 or P3 needs it.
   Tests: each final state rejects every later mark and leaves the row unchanged; queued and `not_applicable` targets refused; a `not_applicable` platform row cannot be marked; two concurrent marks apply exactly one with that mark's own fields; omitted fields keep stored values; unknown id.
4. **MEDIUM, authorization contract documented.** The `ConversationStore` port and the `ConversationService` doc comments state that callers must verify the agent belongs to `ownerUserId` before recording, and that the P2 route must answer 404 for another user's agent. The store only checks the owner of an already existing conversation.
5. **LOW (cheap ones).** The service checks `channel` (must be `web` or `telegram`; `internal` is refused on all three `record*` methods), `deliveryStatus` on agent and platform messages, and `status` on `markDelivery`, with `invalid_channel` and `invalid_delivery_status` (code `conversation.invalid_message`). `listThread` returns `conversation.invalid_cursor` for an invalid `Date`, a blank `beforeId`, or half a cursor. The other lows were skipped as requested.

New error codes: `conversation.invalid_cursor`, `conversation.invalid_delivery_transition`.

Files changed by the fixes: `packages/domain/src/conversations/{conversation,conversation-service,conversation-service.test}.ts`, `packages/domain/src/ports/conversation-store.ts`, `packages/db/src/conversation-repository.ts`, `packages/db/src/conversation-repository.integration.test.ts`, this entry.

Note for P2: the next page cursor must carry both `createdAt` and `id` of the oldest returned row (the API cursor should encode the pair).

### Open questions (tier 3, for the owner)

Neither blocks P1 or P2. Both block retirement of `agent_outbound_messages` in P3.

1. **Reply-correlation lookup index.** Telegram reply routing finds the agent by (`delivery_provider`, `delivery_address`, `provider_message_id`) today. The new table can answer it with `channel` + `provider_message_id` + the owner check, but the schema note names no index for that lookup, so every reply would scan `conversation_messages`. Options: (a) add one non-unique partial index on (`channel`, `provider_message_id`) where `provider_message_id` is not null, in the P3 migration; (b) add `delivery_address` and a composite index (a new column, more data). Recommendation: (a). It is additive and needs no new column. Needs a decision under the schema note rule "any new key needs a new decision".
2. **`session_id` and `context_ref` have no column.** The activity feed reads `session_id` on message entries; nothing reads `context_ref`. Options: (a) drop both (feed entries carry `sessionId: null`, which the type allows); (b) add `session_id` to `conversation_messages`. Recommendation: (a).

### Notes for later slices

- P2 must add agent-delete cleanup for conversations and participants (no foreign key to `agents`), and must read the new config for the 4000 cap.
- `notification_deliveries.event_key` is `{agentId}:{messageId}` by value, so it follows the new row id when the broker moves (P3).
- Web type maps old `pending` to `queued` (P2).
- Existing Outstanding Issues items for CH2W (markOutboundMessageSent provider hard-code) disappear when the table is retired in P3.

Next ready item: CH2W P3 (slice 3, see the slice 2 entry below). A2A-A can run at any time.

## 2026-10-25: CH2W slice 2 (plan phase P2, Web). CH2W is not finished and is not ticked

Scope: plan phase P2 of [002 two-way agent chat](../../15/002-two-way-agent-chat/001-plan.md), plus the slice 1 review items in the QUEUE Outstanding Issues. P3 (channels, retire `agent_outbound_messages`, remove `GET /agents/:id/messages`) and P4 are not started. Nothing is staged or committed.

### What was built

- **`POST /agents/:id/message`** (`apps/api/src/routes/agent-interactivity.ts`): validates with Zod (message length from `messaging.conversations.userMessageMaxChars`; optional `clientMessageId` must be a UUID), keeps the 10/min user limit, the 404 for another user's agent, the 409 when stopped, and the creator-pair bucket. It then records the row first through `ConversationService` (user: `recordUserMessage`; creator agent: `recordAgentMessage` with `senderAgentId`), publishes the envelope under the same id, and marks the row `sent`. Responses: 202 `{ delivered: true, message }`; 400 validation; 409 `message_id_conflict` when the id belongs to another sender or thread; 503 `conversation_unavailable` when the store fails (nothing is published); 503 `message_delivery_unavailable` when the Redis publish fails (row marked `failed`, `publish_failed`). A repeated id returns the stored row and publishes nothing.
- **`GET /agents/:id/conversation?limit&before`**: thread oldest first, `{ messages, nextCursor, maxMessageChars }`. The cursor is opaque base64url of (`createdAt`, `id`) of the oldest row; a malformed one is 400. 404 for another user's agent. Rows expose explicit fields only (no `deliveryDetail`, `providerMessageId`, `conversationId`). Helpers in `apps/api/src/routes/conversation-http.ts`.
- **Retry of a failed send** (002 D5, D6): one new transition, `failed` to `queued`, for the user's own message (`ConversationStore.requeueFailedUserMessage`, `ConversationService.retryFailedUserMessage`, one conditional UPDATE, so one of several concurrent retries publishes).
- **Agent delete**: `deleteUserAgentConversations(tx, agentIds)` (`packages/db/src/conversation-repository.ts`) is called from `purgeAgentRows`, so a single-agent and a subtree delete remove the conversation, participants and messages in the same transaction.
- **Web**: `AgentConversation.tsx` reads `agentsApi.conversation` (polled every 3 s while the agent runs; react-query pauses it in a hidden tab), keeps fetched rows in a merged history, sends with a client UUID, shows the user's message at once as "Sending…", marks failures "Not sent" with Retry (same id), "Show earlier messages" through the cursor, and a load-error line. Authorship: user right, this agent left with its name, another agent (a creator) left as "Parent agent", platform centred with the existing safety-alert or OpenAIdom badge. Pure logic in `conversation-thread.ts`. `AgentOutboundMessage` and `agents.messages()` are removed from the web; `scripts/ts/run-connection-cycle.ts` reads the new endpoint (not run). The collapsed "Messages to user" section was already absent from the web at the start of P2 (grep of `apps/web/src`); nothing to remove there.
- **Slice 1 review fixes**: (1) `recordUserAgentMessage` throws a rollback sentinel on a message id conflict, so a first write refused for its id leaves no empty conversation (integration test added; mutation-checked: with the old `return` it fails with 1 conversation left). (2) Port and service docs: `markDelivery` is for delivery workers, a repeated mark is `invalid_delivery_transition` and means "already marked". (3) The P2 route items (id validation, cursor, 404) are done.
- **i18n**: five keys in en, ar, hi (`fromParentAgent`, `sending`, `notSent`, `loadEarlier`, `loadError`); the existing `retry` key is reused. ar and hi have real short translations (the repo's ar and hi catalogs are translated, and `catalog-consistency` needs equal keys); P4 translation review still applies.
- **Config**: no new keys. `MessagingConversationsSchema` is now exported from `@herobids/domain`; the API and worker pass `appConfig.messaging.conversations`.

### Files changed

- API: `routes/agent-interactivity.ts`, `routes/conversation-http.ts` (new), `routes/agents.ts`, `index.ts`; tests `routes/agent-interactivity.test.ts`, `routes/conversation-http.test.ts` (new), `__tests__/helpers/in-memory-conversation-store.ts` (new), `__tests__/functional/agent-interactivity.functional.test.ts`, `routes/agent-creator-actions.integration.test.ts`, `routes/agent-delete-subtree.integration.test.ts`.
- DB and domain: `packages/db/src/conversation-repository.ts` (sentinel, requeue, delete helper), `conversation-repository.integration.test.ts`, `index.ts`, `agent-repository.ts` (`getOutboundMessage`); `packages/domain/src/ports/conversation-store.ts`, `conversations/conversation-service.ts` and its test, `config/index.ts` (export).
- Worker: `agents/outbound-conversation-mirror.ts` and test (new), `agents/agent-message-broker.ts` and test, `alerting/platform-alert-service.ts` and test, `index.ts`.
- Web: `features/agents/{AgentConversation.tsx,AgentConversation.test.tsx,AgentDetailPage.tsx,conversation-thread.ts,conversation-thread.test.ts}`, `lib/api-client.ts`, `app/i18n/locales/{en,ar,hi}.ts`.
- Other: `scripts/ts/run-connection-cycle.ts`; docs: this entry, QUEUE Outstanding Issues, plan status line and appendix item 0.

### Commands and results

| Command | Result |
| --- | --- |
| `npx tsc -p <p>/tsconfig.json --noEmit` for `packages/domain`, `packages/db`, `apps/api`, `apps/worker`, `apps/web` (domain and db rebuilt first), `pnpm lint` | all clean |
| Disposable containers: `docker run -d --name herobids-ch2w2-pg -e POSTGRES_PASSWORD=ch2w -p 55432:5432 postgres:17-alpine` and `docker run -d --name herobids-ch2w2-redis -p 56379:6379 redis:7-alpine`; `db:migrate` against the first (all migrations applied) | the running `herobids-postgres-1` and `herobids-redis-1` were not used or touched |
| `DATABASE_URL=… pnpm exec vitest run --fileParallelism=false packages/db/src/conversation-repository.integration.test.ts packages/domain/src/conversations` | 2 files, 78 tests passed (integration 43, was 36; service 35, +4 retry tests) |
| `DATABASE_URL=… REDIS_URL=… vitest run src/__tests__/functional/agent-interactivity.functional.test.ts` (apps/api) | 28 tests passed (POST idempotency, 503 on publish failure and retry of the same id, 404 for another user's agent, 409 id clash without leak, malformed id 400, GET pagination and 404/401/400, agent delete cleanup) |
| `pnpm test:integration` (DB and Redis env set) | 9 files, 106 tests passed (includes the creator message and subtree delete conversation assertions) |
| `pnpm test:functional` (DB and Redis env set) | 16 files, 196 tests passed |
| `pnpm exec vitest run --fileParallelism=false --pool=forks --poolOptions.forks.singleFork packages/db` (DB env set) | 27 files passed, 1 skipped; 362 tests passed, 9 skipped |
| I1 gate `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` | 9 files passed, 1 skipped; 200 tests passed, 31 skipped (was 196; +4 mirror seam tests) |
| `docker rm -f herobids-ch2w2-pg herobids-ch2w2-redis` | removed (0 `ch2w` containers left) |
| `pnpm test` (no `DATABASE_URL`, as in C1) | exit 0. 420 files: 0 failed, 383 passed, 37 skipped. 7616 tests: 0 failed, 7094 passed, 522 skipped |

Comparison with the C1 final run (414 files, 378 passed, 36 skipped; 7469 tests, 7001 passed, 468 skipped): 0 failed in both. +6 files (slice 1: service test, config test, repository integration (skipped without a DB); slice 2: `conversation-http.test.ts`, `outbound-conversation-mirror.test.ts`, `conversation-thread.test.ts`), +93 passed, +54 skipped (the DB-gated tests of the new integration file and the new functional cases). No existing test was removed; the existing message-route unit tests were rewritten for the new behaviour.

E2E: not run (ENTRYPOINT section 7). The plan's gate "E2E journey" and `run-all-tests.sh --e2e` before P2 closes are **deferred for the owner**; P2 is not closed.

### Tier-2 decisions

1. **Message id format: UUID.** `clientMessageId` must be a UUID (Zod `uuid()`). It is the smallest accepted shape and it cannot collide with derived ids such as `user_agent:{id}`. Creator agents send none (the server generates one).
2. **Both 503 cases.** A store failure (before any publish) and a Redis publish failure are both 503, with different error codes; only the publish failure leaves a `failed` row.
3. **Retry reuses the id, through one `failed` to `queued` transition.** The 002 D6 text ("the row stays so the user can retry the same ID") needs a way back from `failed`; slice 1 made `failed` final for `markDelivery`. I added a separate, narrow, atomic method (`requeueUndeliveredMessage`, see Review fixes) that only re-queues the sender's own message in its own conversation, and left `markDelivery` strict. Any other repeat of an id returns the row and publishes nothing (D5).
4. **Transitional bridges instead of a one-sided chat.** The broker, alert service and session anchor still write `agent_outbound_messages` (P3). Without a bridge the web thread would show only the user's messages, which is a regression from today. So: (a) the POST also writes the old row under the same id (the old readers `conversation-turn` and the activity feed keep working), and (b) `OutboundConversationMirror` copies agent and platform rows into the conversation once their delivery outcome is known, with an optional trailing constructor argument on the broker and alert service, so no existing call site changes. It never throws and uses no provider literal (the channel comes from the old row's provider when it is a conversation channel, else `web`). Both bridges are listed in the QUEUE Outstanding Issues for P3 to delete.
5. **`conversation-turn` and the activity feed stay on the old table** until P3 (the plan lists them for P3 or P2 for `conversation-turn`; moving it would need a new store query while the old row still exists, so it moves with the bridge removal).
6. **`maxMessageChars` in the GET response** so the web does not hard-code the operator limit (I7). The web keeps 4000 only as the fallback before the first page loads.
7. **Web layout.** The view takes oldest-first messages (the old API was newest first) and an optimistic `PendingSend` list; the composer is no longer blocked while a send is in flight. Older pages are merged into a local history because the polled newest page slides forward and would otherwise drop rows.
8. **Creator messages** appear in the child's thread as an agent row whose sender is the creator, labelled "Parent agent" (the old UI labelled them like platform messages).
9. **Agent delete** uses an exported helper taking the transaction, called from `purgeAgentRows`, rather than raw table access in the route; the derived conversation id is the only key. Peer threads are A2A-B's.
10. **Response shape.** `delivered: true` stays (the worker's `messageChildAgent` parses it) and `message` is added.

### Review fixes (slice 2, still unstaged)

1. **HIGH, creator retry.** `requeueFailedUserMessage` is now `requeueUndeliveredMessage` and takes the sender (`user` or the creator `agent` id); the route claims under the same authorship it recorded with, so a retry of a failed creator message (same `clientMessageId`) publishes again instead of returning 202 `delivered:true` with nothing sent. Chosen over rejecting `clientMessageId` for agent keys because the store, route and web already treat the id as the retry key, and the fix is one parameter. The claim also checks the conversation owner.
2. **MEDIUM, stuck `queued`.** New operator setting `messaging.conversations.staleQueuedAfterSeconds` (Zod default 60, in `config/default.yaml`, validated positive). A `queued` message of the sender older than that is claimable by the same atomic update as a `failed` one. Age needs a stamp that a claim can refresh (a retried old message must not look stale again at once and be claimed by a racing second retry), so migration `0085_redundant_hammerhead` adds `conversation_messages.queued_at` (not null, default now; set to `created_at` on insert, set to the claim time on requeue). Existing rows get the migration time. The GET and POST responses carry `stuck` (queued and past the age, computed on the server clock); the web shows "Not sent" with Retry for a stuck row instead of "Sending..." forever, and the Retry resends under the same id.
3. **MEDIUM, mirror outcomes.** `OutboundConversationMirror.mirror(id, outcome?)`: the broker (`send_message`) and the session anchor pass `'not_applicable'` for `chat.no_address` and `chat.not_configured` (`isUndeliverableChatError`), so those are no longer recorded as `failed`. The row is now recorded with its final status in one insert (new optional `deliveryDetail` and `providerMessageId` on `recordAgentMessage` and `recordPlatformMessage`), so there is no `queued` window and no `markDelivery` call. A failed record, and an unexpected error, are logged at error level. The misleading "no delivery attempt" comment is rewritten. `PlatformAlertService` needed no change: it never marks those two outcomes `failed`.
4. **MEDIUM, retry of a delivered message.** The route looks the row up by id (own sender, own conversation and owner) before the rate limit and the `agent_not_running` gate, and returns it when it needs no publish (sent, in flight, refused). A repeat of a delivered message therefore works after the agent stops; a retry that must publish (failed or stuck) still gets 409 on a stopped agent. The 404 for another user's agent now comes before the rate limit. In `buildThread`, a stored status other than `queued` or `failed` is never overridden by a local pending state, so a failed local attempt cannot hide a server `sent`.
5. **MEDIUM, real DB tests.** Disposable containers (below). New cases: repository integration (creator requeue, stale claim, restamp, one winner under six concurrent claims, `findMessage` scoping), functional (recent queued is not re-published, stuck queued re-published once under three racing retries, repeat after stop returns the row, failed retry on a stopped agent is 409; the existing retry-after-503 case stays), creator integration (503, retry under creator authorship, one envelope, one row). Unit tests: service, route (in-memory store with an advanceable clock), mirror, broker, web.
6. **LOW.** (a) Rate limit: only a request that may publish spends the per-user token (an idempotent repeat returns before it). (b) The earlier-page mutation in `AgentConversation.tsx` shows "Could not load the conversation." beside the button when it fails (a bare `onError` would change nothing: `mutate` does not throw; the state comes from `isError`). (c) **Does the runtime de-duplicate by envelope `messageId`? No.** `readOutboundMessages` (`outbound-message-reader.ts`) drains the group and `agent.ts` passes every envelope on; `messageId` is only echoed in `TICK_STARTED.userMessageIds`. (The broker de-duplicates agent to platform envelopes by `messageId`, not this direction.) So the stuck-queued re-publish is at-least-once: if the first `xadd` succeeded and only the `sent` mark failed, the agent can see the message twice. Accepted for now; a runtime de-dupe is listed in QUEUE.

| Command (review fixes) | Result |
|---|---|
| `docker run` Postgres 17 (`herobids-ch2w2b-pg`, 55432) and Redis 7 (`herobids-ch2w2b-redis`, 56379); `db:migrate` | all migrations applied (0085 included); the running `herobids-postgres-1` and `herobids-redis-1` were not touched |
| `vitest run --fileParallelism=false packages/db/src/conversation-repository.integration.test.ts` | 51 tests passed (was 43) |
| `vitest run ... apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts apps/api/src/routes/agent-creator-actions.integration.test.ts` | 2 files, 49 tests passed (32 functional, 17 integration) |
| `pnpm exec vitest run --fileParallelism=false --pool=forks --poolOptions.forks.singleFork packages/db` | 27 files passed, 1 skipped; 370 passed, 9 skipped |
| `pnpm test:functional` | 16 files, 200 tests passed |
| `pnpm test:integration` | 9 files, 107 tests passed |
| `docker rm -f herobids-ch2w2b-pg herobids-ch2w2b-redis` | removed (0 `ch2w` containers left) |
| `tsc --build` domain and db; `tsc --noEmit` api, worker, web; `pnpm lint` | clean |
| `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` (I1 gate) | 9 files passed, 1 skipped; 202 passed, 31 skipped |
| `pnpm test` (no `DATABASE_URL`) | exit 0. 420 files: 0 failed, 383 passed, 37 skipped. 7656 tests: 0 failed, 7121 passed, 535 skipped (was 7094 passed, 522 skipped; the new DB-gated cases are the extra skips) |

E2E scripts were not run.

### Re-review fixes (slice 2, still unstaged)

1. **HIGH (docs), `queued_at` has no decision.** Added the column to the schema note section 2.3 (marked proposed) and a DEC-50 row in DECISIONS.md under "Proposed by an implementer", status `proposed — pending owner confirmation` (not approved; DEC-49 stays reserved for the stop-switch contract per DEC-48). The row has the reasoning (claim restamps the age so a retried old message is not instantly stale and one racer wins), the migration-time value of existing rows, and the accepted clock-skew risk vs `staleQueuedAfterSeconds`. Tier-3 note added below and in QUEUE Outstanding Issues.
2. **MEDIUM, `chat.address_lookup_failed` mirror.** The broker no longer mirrors before throwing (chosen over letting the mirror upgrade a `not_applicable` row: simplest, and the redelivery inserts a new old-table row that is mirrored with its real outcome). Test in `agent-message-broker.test.ts`. The alert service has the same lookup-failure branch but does not throw and is not redelivered, so it is unchanged.
3. **MEDIUM, legacy write retry.** The legacy `agent_outbound_messages` insert in `POST /agents/:id/message` now runs on every publish, not only when the row was just created. `AgentRepository.insertOutboundMessage` is `ON CONFLICT (id) DO NOTHING` so a repeat is a no-op. Tests: route test (first legacy write fails, publish fails, retry recreates the row) and a repository test for the conflict clause. The test db mock in `buildMessageApp` now models `.values().onConflictDoNothing()`.
4. **LOW, Retry for `refused`.** `AgentConversation.tsx` shows Retry only for `failed` and stuck `queued` (a republish is possible); a `refused` message shows "Not sent" without Retry. Component test added.

| Command (re-review fixes) | Result |
|---|---|
| `tsc --build` domain and db; `tsc --noEmit` api, worker, web; `pnpm lint` | clean |
| Disposable Postgres 17 and Redis 7 (`herobids-ch2w2c-*`, ports 55432 and 56379), `db:migrate`; removed afterwards (0 `ch2w` containers left) | the running `herobids-*` containers were not touched |
| Targeted: broker, route, mirror, web agents, `agent-repository.test.ts`, conversation repository integration, agent-interactivity functional, creator and subtree integration | all passed |
| `packages/db` (single fork, DB env) | 27 files passed, 1 skipped; 371 passed, 9 skipped |
| `pnpm test:functional` / `pnpm test:integration` (DB env) | 16 files, 200 passed / 9 files, 107 passed |
| I1 gate `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` | 10 files passed; 234 passed (DB env set) |
| `pnpm test` (no `DATABASE_URL`) | exit 0. 420 files: 0 failed, 383 passed, 37 skipped. 7660 tests: 0 failed, 7125 passed, 535 skipped |

Files: `apps/api/src/routes/agent-interactivity.ts` and test, `apps/worker/src/agents/agent-message-broker.ts` and test, `packages/db/src/agent-repository.ts` and test, `apps/web/src/features/agents/AgentConversation.tsx` and test, schema note, DECISIONS, PROGRESS, QUEUE. CH2W is not ticked.

### Tier-3 questions for the owner

**New (tier 3, owner): confirm `conversation_messages.queued_at` (DEC-50, `proposed — pending owner confirmation`).** Migration 0085 added the column outside the approved schema note, which requires a decision for any new column (note section 7). It is recorded in the schema note section 2.3 and DECISIONS as proposed, not approved. It lets a retry claim restamp the age so a retried old message is not instantly stale and only one racer wins. Existing rows get the migration time. Accepted risk: clock skew across API instances larger than `staleQueuedAfterSeconds` (60 s) could allow an early or late claim. If declined, the alternative is to age from `created_at` and drop the column.

None other new block P2 or P3. The two from slice 1 still block retirement of `agent_outbound_messages` in P3: (1) the (`channel`, `provider_message_id`) index for Telegram reply correlation (recommend option a), (2) dropping `session_id` and `context_ref` (recommend option a). One more to confirm, low risk: the bridges in decision 4 are an addition beyond the plan text for P2; the alternative is to ship P2 with agent replies missing from the web thread until P3, which I did not choose because it regresses today's chat.

### Owner hand-offs and gates still open

- E2E journey and `scripts/shell/tests/run-all-tests.sh --e2e` before P2 closes (deferred, ENTRYPOINT section 7).
- Owner review after P2 (plan section 5).

Next ready item: CH2W P3 (slice 3), blocked only on the two slice 1 tier-3 answers for the table retirement; the Telegram inbound/outbound and broker moves can start before. A2A-A can run at any time.
