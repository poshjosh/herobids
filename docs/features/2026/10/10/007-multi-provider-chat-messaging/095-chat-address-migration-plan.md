# Chat address migration plan: retire the legacy Telegram columns

**Status:** Draft, awaiting owner approval
**Date:** 2026-10-24
**Parent:** [900-implementation-plan.md](./900-implementation-plan.md) · [040-data-model-and-migration.md](./040-data-model-and-migration.md)
**Related:** [060](./060-config-secrets-onboarding.md) ("Honour revocation"), [050](./050-inbound-routing.md)

## 1. Goal and non-goals

**Goal.** `chat_addresses` becomes the only store for a user's or agent's chat address. The legacy columns `users.telegram_chat_id` and `agents.telegram_chat_id` (and the outbound `telegram_message_id` / `telegram_chat_id`) are dropped at the end, in a separate PR, after owner approval.

**Non-goals.**
- No change to Telegram behaviour. Delivery, slash commands, `/to`, and reply routing stay as they are.
- No change to public API field names. `telegramChatId` stays in `PATCH /auth/me`, `GET /auth/me`, and the agent create, get, and update responses.
- No WhatsApp or SMS work. No STOP handling. No i18n key renames (`settings.telegram.*` and similar stay).
- No teardown is assumed. Teardown of staging or production is an owner choice (section 5, M10).

## 2. Current state (verified 2026-10-24)

The `ebacb5d0` commit already routes every write of a user or agent chat ID through `setTelegramChatAddress` (`packages/db/src/agent-repository.ts:223-258`). The legacy columns are still written in the same transaction, and still read by 14 reader sites.

### 2.1 Writers (10 sites write a legacy column)

| ID | File:line | What it does |
| --- | --- | --- |
| W1 | `packages/db/src/agent-repository.ts:287` | `createAgent` insert writes `agents.telegram_chat_id` (helper call at 292-293) |
| W2 | `packages/db/src/agent-repository.ts:691-692` | `markOutboundMessageSent` writes outbound `telegram_message_id` and `telegram_chat_id` (neutral columns at 693-695) |
| W3 | `apps/api/src/routes/agents.ts:830` | agent create insert (helper at 844-845) |
| W4 | `apps/api/src/routes/agents.ts:1953` | agent PATCH update (helper at 1963-1964) |
| W5 | `apps/api/src/routes/auth.ts:981` | `PATCH /auth/me` updates `users.telegram_chat_id` (helper at 983) |
| W6 | `apps/api/src/services/agent-instantiation-service.ts:126` | agent-from-payload insert (helper at 129-130); used by blueprints and go-live |
| W7-W10 | `apps/api/src/routes/auth.ts:304, 336, 667, 1093` | user insert with `telegramChatId: null` (four OAuth and local sign-up sites) |

Pass-through callers (no direct write, they feed W6): `apps/api/src/services/agent-go-live-service.ts:250` and `apps/api/src/routes/blueprints.ts:2359`.

### 2.2 Readers (14 sites read a legacy column, directly or through another reader)

| ID | File:line | Reads |
| --- | --- | --- |
| R1 | `packages/db/src/agent-repository.ts:748-760` | `getEffectiveTelegramChatId`: `agents` and `users` columns |
| R2 | `packages/db/src/agent-repository.ts:773-809` | `getNeutralChatAddressScope` reads `agents.telegram_chat_id` (select at 782) |
| R3 | `packages/db/src/agent-repository.ts:835` | `getEffectiveChatAddress` legacy fallback, calls R1 |
| R4 | `apps/worker/src/index.ts:700` | `sendSessionStartedTelegramAnchor`, calls R1 |
| R5 | `packages/db/src/agent-repository.ts:930-948` | `resolveAgentForTelegramReply` on outbound `telegram_message_id` and `telegram_chat_id` (944) |
| R6 | `packages/db/src/agent-repository.ts:1023` | `resolveAgentForChatReply` legacy pair fallback, calls R5 |
| R7 | `apps/api/src/routes/agent-interactivity.ts:814` | webhook dispatch `resolveReply`, calls R5 |
| R8 | `apps/api/src/routes/agent-interactivity.ts:628` | `processWebhookUpdate` finds the user by `users.telegram_chat_id` (slash commands, routing) |
| R9 | `apps/api/src/routes/agent-interactivity.ts:877` | `processWebhookDocument` finds the user the same way |
| R10 | `apps/api/src/routes/auth.ts:911` | `GET /auth/me` output (handler at 885) |
| R11 | `apps/api/src/routes/auth.ts:998` | `PATCH /auth/me` response (handler at 922) |
| R12 | `apps/api/src/routes/blueprints.ts:2285-2289` | same-user pre-fill reads `users.telegram_chat_id` |
| R13 | `apps/api/src/routes/agents.ts:934-945`, `1042-1046` | `GET /agents` and `GET /agents/:id`: select-star spreads the raw row, so `agents.telegram_chat_id` is emitted as `telegramChatId`. This is the agent edit form's source (web reads it at `apps/web/src/features/agents/agent-form-state.ts:140`) |
| R14 | `apps/api/src/services/agent-go-live-service.ts:69-70` and `250` | `sourceAgent` select-star, then copies `telegramChatId` into W6 |

Already neutral: `apps/worker/src/alerting/chat-delivery.ts:26` uses `getEffectiveChatAddress` and `isChatAddressSuppressed`.

### 2.3 Other facts that shape the plan

- **No inbound bind writer.** No code path writes a chat address from an inbound message. `processWebhookUpdate` only reads (R8). The reply "Please bind your Telegram account first. Use /start to begin." (`agent-interactivity.ts:659`) is stale: `/start` is the agent start command (`telegram-command-handlers.ts:586`).
- **No revocation writer.** No production code sets `revoked` or `pending_optin`. Only tests and the schema use them. `isChatAddressSuppressed` (`agent-repository.ts:843-856`) treats any non-active row as a platform-wide opt-out.
- **Overwrite problem.** The upsert in the helper (`agent-repository.ts:223-258`) uses `where trim(address) <> new address` and sets `status = 'active'`. A revoked row for number X, overwritten by a save of number Y, becomes active for Y, and X is no longer blocked. No current caller reaches this, because nothing sets `revoked` yet. It must be fixed before any STOP writer ships.
- **Stored addresses are not unique.** `idx_chat_addresses_provider_address` (`packages/db/src/schema/chat-addresses.ts`) is non-unique. Legacy lookups use `.limit(1)` with no order (R8, R9).
- **Blank-address workaround.** The blank branch of the helper sets `address = ''` on the active row instead of removing it (`agent-repository.ts:223-258`). Readers filter blanks out (`agent-repository.ts:795`).
- **Schema and migrations.** Legacy columns: `packages/db/src/schema/users.ts:22`, `agents.ts:31`, `agent-outbound-messages.ts:32,34`. Expand and backfill are in `drizzle/0076_absent_starhawk.sql` and `drizzle/0077_chat_addresses_backfill.sql`. No migration drops a legacy column.
- **Tests referencing legacy names:** 21 files, 128 occurrences. Full list in section 5, M9.

## 3. Design decisions needed

Each has a recommended default. None is recorded in [900](./900-implementation-plan.md) until the owner approves (AGENT-ENTRYPOINT §7).

**D1. How "no chat ID" is represented.** Recommend: **no row** means no address. Clearing deletes the active row. Opt-out rows (`revoked`, `pending_optin`) are never deleted. Reason: a `cleared` status would be non-active, so `isChatAddressSuppressed` would treat a cleared address as an opt-out for every user. This removes the `''` workaround and its blank filters.

**D2. Revoke history.** Recommend: include the address in the unique key, `unique(user_id, agent_id, provider, address) nulls not distinct`. Each address keeps its own row, so a revoked row is never overwritten by a new number. A save of a revoked address stays revoked (keep the existing `where` guard). Reactivation happens only through an explicit owner re-confirm that sets `verified_at` and `consent_source`. The resolver must then handle several rows per scope. A separate `chat_address_events` history table is optional and not needed for this migration. Reason: 060 requires a revocation to bind the sender, not the tenant.

**D3. Reverse lookup ambiguity (two accounts, one chat ID).** Recommend: **reject a second active claim** on the same `(provider, address)` with a 409 and a new error code (`chat_address.already_bound`), and add a test. Reason: "most recently verified wins" still sends one user's agent messages to a chat that now belongs to someone else, and cannot be fixed by inbound routing alone. The new error code is a public API change, so it needs owner approval. If the owner prefers the suggested rule, it must be limited to inbound routing, and the outbound leak must be accepted explicitly.

**D4. What the inbound `/start` or bind flow writes.** Recommend: **inbound writes nothing.** An unbound chat gets a text that points to web settings. Binding stays web-initiated: the user saves the chat ID, the server verifies it (`agent-interactivity.ts:484`, which writes nothing), and the row is written with `verified_at` and `consent_source`. A bind token delivered through the bot changes the webhook behaviour and is a security boundary, so it is deferred and needs owner approval. The stale `/start` wording at line 659 is replaced in M4.

**D5. Does the agent-level override keep "inherit from user"?** Recommend: **yes.** An agent row overrides the user row. No agent row means inherit. Clearing an agent address deletes its row, so it inherits. "This agent must never message Telegram" is a notification-policy question, not an address one, and is out of scope.

**D6. Public API field names.** Recommend: **keep `telegramChatId`** in all listed responses and in the `PATCH` body. Only the source changes (computed from `chat_addresses`). The PUT schema at `agent-interactivity.ts:88` accepts the field, but its handler never references it, so the value is silently ignored. Recommend leaving it and recording it, with no API change in this plan.

## 4. Test and verification strategy (summary)

- **Unit:** repository methods and mapping in `packages/db` (`agent-repository.test.ts`), route output in `apps/api` (`auth.test.ts`, `agents.test.ts`), web form state (`agent-form-state.test.ts`).
- **Integration (needs Postgres 17):** `packages/db/src/*.integration.test.ts`. There are seven files, not four. See Q3.
- **Behaviour:** Telegram tests (`telegram`, `chat-inbound`, `agent-message-broker`, `platform-alert`) stay green at every step.
- **Visual:** none. No UI change.

## 5. Task breakdown

Work in this order. Each task ends with a gate. A task is not ticked in AGENT-ENTRYPOINT §3 until its gate passes.

**M0. Confirm baseline and decisions.** No code.
- Files: none.
- Work: re-run `pnpm test` and record real counts. Owner decides D1–D6 and Q1–Q9.
- Test: the baseline run itself.
- Gate: owner approval recorded in 900's decision log.

**M1. Schema for D1 and D2 (expand, additive).**
- Files: `packages/db/src/schema/chat-addresses.ts`, new custom migration in `packages/db/drizzle/`, `agent-repository.ts` (helper at 223-258, `getNeutralChatAddressScope` at 773).
- Work: add the address to the unique key. Create the new unique index before dropping the old one. Remove the `''` branch. Make the helper refuse to overwrite a non-active row.
- Dependencies: M0.
- Test: `chat-address-resolution.integration.test.ts` gains a case for revoked X then save Y (X still blocked). `agent-repository.test.ts` gains a no-row clear case.
- Gate: `npx tsc -p packages/db/tsconfig.json --noEmit`; integration files (section 6).

**M2. Move R4 to neutral.** `apps/worker/src/index.ts:700` calls `getEffectiveChatAddress(agentId, 'telegram')`.
- Dependencies: M1.
- Test: a worker unit test for the session-start anchor (none exists today, so add one); the Telegram test set.
- Gate: `npx tsc -p apps/worker/tsconfig.json --noEmit`; `pnpm exec vitest run telegram platform-alert`.

**M3. Remove the legacy fallback from the effective-address resolver.** Delete `getEffectiveTelegramChatId` (R1), the agent legacy read (R2, line 782), and the fallback at 835.
- Dependencies: M2. Owner confirms backfill is verified in every environment (040 step 2).
- Test: rewrite `agent-repository.test.ts` lines 235-277 for neutral rows. Existing precedence tests (agent row, then user row, revoked blocks) must still pass.
- Gate: `pnpm exec vitest run packages/db`.

**M4. Move the inbound user lookup (R8, R9) to `chat_addresses`.** `agent-interactivity.ts:628` and `877` look up an active `telegram` row for the address. Also change the stale wording at `:659` (D4).
- Dependencies: M1. Depends on D3 (duplicate claims rejected at write time).
- Files also touched: `apps/api/src/__tests__/webhook/telegram-slash-commands.integration.test.ts`, `apps/api/src/__tests__/functional/telegram-slash-commands.functional.test.ts`, `apps/api/src/routes/agent-interactivity.test.ts`.
- Test: a case where a second active claim is refused, and an inbound from a revoked address is refused.
- Gate: `npx tsc -p apps/api/tsconfig.json --noEmit`; `pnpm exec vitest run telegram-slash agent-interactivity`.

**M5. Move reply correlation (R5, R6, R7) to delivery columns only.** `resolveAgentForChatReply` (`agent-repository.ts:965`) keys on `delivery_provider`, `delivery_address`, `provider_message_id`. Remove the legacy pair fallback (`:1023`) and the `telegram_*` filter at `:944`.
- Dependencies: M1. Outbound rows are already dual-written (`:691-695`), and 0077 backfilled older rows.
- Test: a row with only neutral columns resolves; a row with only legacy columns is not matched (state the expected result in the test name).
- Gate: `pnpm exec vitest run packages/db telegram-slash`.

**M6. Move output reads (R10, R11, R13) to computed values.** `GET /auth/me` (`auth.ts:911`), `PATCH /auth/me` response (`:998`), `GET /agents` (`agents.ts:934`), and `GET /agents/:id` (`:1042`) return `telegramChatId` from `chat_addresses`. The list endpoint needs one batch query, not one per agent. Field names do not change.
- Dependencies: M3.
- Test: `auth.test.ts` (24 occurrences) and `agents.test.ts` (18) change their fixtures from the legacy column to neutral rows. Add a list-endpoint test with two agents and mixed rows.
- Gate: `pnpm exec vitest run auth agents`; `pnpm exec vitest run agent-form-state` (web).

**M7. Move the copy paths (R12, R14).** `blueprints.ts:2285-2289` and `agent-go-live-service.ts:69-70, 250` read the neutral user row instead of the column.
- Dependencies: M3.
- Test: `blueprints.integration.test.ts` (11 occurrences), `agent-go-live-service.test.ts` (3).
- Gate: `pnpm exec vitest run blueprints agent-go-live`.

**M8. Single writer path.** Remove the legacy writes W1–W10 and the W2 legacy columns. Keep `setTelegramChatAddress` as the only writer. Add a data step that deletes existing `''` active rows (D1).
- Dependencies: M2 to M7 all merged. **Writers must not ship before readers**, or readers return empty and routing silently fails.
- Test: `agent-instantiation-service.test.ts` (5), `agent-repository.test.ts`, and `auth.test.ts` assert the neutral row only.
- Gate: `npx tsc` for db, api, and worker; `pnpm test`.

**M9. Sweep the remaining tests.** Update the 21 files that reference legacy names: `apps/worker/src/agents/agent-message-broker.test.ts` (2), `apps/api/src/routes/capabilities/trading.test.ts` (1), `trading-presentation.test.ts` (1), `apps/api/src/services/agent-blueprint-sync-service.test.ts` (1), `blueprint-projection.test.ts` (1), and the web tests (`agent-payloads.test.ts` 35, `i18n-regressions.test.ts`, `settings-save-guard.test.ts`, `edit-agent-oauth-draft.test.ts`). Web tests change only where they assert legacy-column behaviour. DTO field names stay.
- Gate: `grep -rn "telegram_chat_id" apps packages --include=*.ts --exclude-dir=node_modules --exclude-dir=dist` returns only the schema, migration, and `drizzle` files until M11. Then `pnpm test`.

**M10. Environment reset (optional, owner-only).** Staging and production may be torn down and re-provisioned, since both are pre-launch and no data copy is needed. **Nothing is wiped without the owner's written confirmation for that environment.** Terraform `apply` is not run by this plan.
- Gate: owner confirmation, then a clean apply of all migrations.

**M11. Drop the legacy columns (separate PR, last).** Drop `users.telegram_chat_id`, `agents.telegram_chat_id`, `agent_outbound_messages.telegram_message_id`, and `agent_outbound_messages.telegram_chat_id`. Also remove the schema fields and the old unique key from D2, if it is replaced.
- Dependencies: M8, M9, and one staging deploy with no reads of the legacy columns (check logs or a read-only query). **Owner approval required.** Additive-first: this migration is the only destructive one. The exact SQL is written by hand, reviewed line by line, and attached to the PR. Take a snapshot before it runs.
- Gate: all verification in section 6, plus the owner's sign-off.

## 6. Verification per task

Run the smallest command that covers the change first. Run the full suite at each phase gate.

```bash
# Type checks (every task that touches TypeScript)
npx tsc -p packages/db/tsconfig.json --noEmit
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/worker/tsconfig.json --noEmit

# Targeted tests (examples; pick the ones in each task above)
pnpm exec vitest run packages/db
pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert

# DB integration (M1, M3, M5, M8, M11). Use the container tooling config first.
# Start a throwaway Postgres 17 container, run the integration files, then remove it.
DATABASE_URL=<throwaway-url> pnpm --filter @herobids/db exec vitest run --config <integration-config> packages/db/src/*.integration.test.ts
# Remove the container afterwards, even on failure.

# Full gates
pnpm lint
pnpm test
```

**Baselines to compare against.** The owner's numbers are `pnpm test`: 362 files passed, 28 skipped; 6829 passed, 358 skipped. The most recent record in 900 (2026-10-24, W and E) says 362 files passed, 28 skipped; 6816 passed, 352 skipped. The two differ on test counts. M0 records the real figure before any change, and every later gate compares to it.

## 7. Risks

1. **Missed reader causes silent misroute.** A reader still on the legacy column returns null after M8 and the message is dropped or sent to the wrong place. Mitigation: M9's grep gate, a test per reader, and no writer change before M2 to M7 are merged.
2. **Reverse lookup ambiguity.** Two accounts with one chat ID can receive each other's messages today (R8 `.limit(1)`, no order). Mitigation: D3 and a test.
3. **Revocation overwrite.** Saving a new number over a revoked row unblocks the old one (section 2.3). Latent today; must be fixed by D2 before any STOP or block writer ships.
4. **Drop is destructive.** Rollback after M11 means re-adding the columns and backfilling from neutral rows. Only active rows and the revoked rows that survive D2 can be restored. Mitigation: snapshot first, owner approval, separate PR.
5. **Environment reset loses test data.** Teardown and re-provision (M10) loses any staging data. Mitigation: per-environment owner confirmation.
6. **Readers and writers must ship together.** Removing a writer before its readers are moved leaves reads empty. Mitigation: M8 is gated on M2 to M7.
7. **Stored addresses not trimmed** (900 P2.3). Inbound lookups use the trimmed value and the backfill trims, so matches can miss untrimmed rows written before 0077. Mitigation: normalise in the M1 expand and check in M3.

## 8. Open questions

- **Q1. Approve D1–D6?** Recommend: approve all six as written.
- **Q2. Run a read-only duplicate check on staging and production** (two active rows with one `(provider, address)`)? Recommend: yes, before M4. The check is read-only, but it needs owner approval to connect.
- **Q3. Which "four DB integration files"?** The brief names four, but `packages/db` has seven `*.integration.test.ts` files. Recommend: run all seven.
- **Q4. Which baseline is correct?** Recommend: use the M0 re-run as the baseline, and update 900's record.
- **Q5. Teardown or in-place for each environment?** Recommend: in-place for staging, since it keeps test data. Teardown only if the owner confirms nothing needs keeping.
- **Q6. Keep the dead `telegramChatId` in the PUT agent schema?** Recommend: keep for now and record it. Remove only in a versioned API change.
- **Q7. Approve the unique-key change in D2?** Recommend: yes. It needs a migration, so it stays additive first.
- **Q8. Approve the 409 `chat_address.already_bound` error (D3)?** Recommend: yes. It is a public API change.
- **Q9. Approve the new `/start` wording (D4)?** Recommend: "Open Settings to link your Telegram account." Wording only.

## 9. Outstanding Issues

None.
