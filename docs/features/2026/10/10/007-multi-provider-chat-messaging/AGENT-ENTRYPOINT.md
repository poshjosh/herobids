# Agent entrypoint: multi-provider chat messaging (WP-M)

Read this file and follow it. The task queue in section 3 is the only list of what to do next.

## Stop and ask the owner (do not proceed)

Stop and ask if a change would touch any of these (from [IMPLEMENTATION §9](../002-agent-onboarding-epic/IMPLEMENTATION.md)):

1. A **user-configured limit** (for example, weakening a limit).
2. A **security boundary**: auth, HMAC, webhook signature or secret verification, secrets.
3. A **public API contract**: a route, or removing `/telegram/webhook`.
4. A **parity-drift authority**.
5. Anything the owner has **explicitly reserved** ("owner decision" in the plans).

Also stop if a test that passed before now fails and the cause is not obvious, or if a phase gate cannot be met without a decision. Report the evidence, not a guess.

---

## 1. Reading order

1. This file.
2. [900-implementation-plan.md](./900-implementation-plan.md): the status table (phase structure and gates) and the decision log.
3. The design doc for the task you are on: [040](./040-data-model-and-migration.md) (Phase 2), [050](./050-inbound-routing.md) and [010](./010-design-overview.md) (Phase 3), [060](./060-config-secrets-onboarding.md) (config). For T, W, E and U, read [070](./070-typing-indicator.md), [080](./080-web-push-notifications.md) and, for U, the plan you write (section 4).
4. [AGENTS.md](../../../../../../AGENTS.md): repo rules. The key ones are in section 5.
5. [IMPLEMENTATION §3 and §5](../002-agent-onboarding-epic/IMPLEMENTATION.md): epic invariants and the decide-vs-escalate rule.

Do not read 030 or 085 until a task needs them.

## 2. Goal and definition of done

Let a user talk to their agent over **any supported messaging platform**, with the same agent behaviour on each. Telegram works today and must keep working at every step. Each new platform adds rows and config, not schema changes or hard-coded branches.

**Done for the feature** when every item in section 3 is ticked **and** the owner has resolved open decision C in [900](./900-implementation-plan.md) (the two-provider target). Until then, stop after the last ticked item and report.

## 3. Task queue (in order)

This is the only record of task state. Work from the top. The first unchecked item is your next task. Tick an item when its gate passes.

- `[x]` **Phase 0**: capability manifest amendment. Evidence: `messaging / chat / sms` planned row; manifest tests in [providers.test.ts](../../../../../../apps/api/src/routes/providers.test.ts).
- `[x]` **Phase 1**: port and Telegram behind it. Evidence: `ChatDelivery`, `ChatInboundRouter`, `chat-channel.ts`. Wave 1 gate passed (see [PROGRESS](../002-agent-onboarding-epic/PROGRESS.md)).
- `[x]` **P0** Baseline: the Telegram test files pass before you change anything (section 4)
- `[x]` **P2.1** Schema (Phase 2)
- `[x]` **P2.2** Generated expand migration (Phase 2)
- `[x]` **P2.3** Repository and resolver (Phase 2)
- `[x]` **P2.4** Custom backfill migration (Phase 2)
- `[ ]` **P2.5** Dual-write (Phase 2)
- `[ ]` **P2.6** Tests and Phase 2 gate
- `[ ]` **P3.1** Neutral webhook route (Phase 3)
- `[ ]` **P3.2** Auth bypass for the new route (Phase 3)
- `[ ]` **P3.3** `messaging.chat.*` config (Phase 3)
- `[ ]` **P3.4** Tests and Phase 3 gate
- `[ ]` **T** Telegram typing indicator ([070](./070-typing-indicator.md))
- `[ ]` **W** Web Push and installable PWA ([080](./080-web-push-notifications.md))
- `[ ]` **E** Email notification fallback ([080](./080-web-push-notifications.md))
- `[ ]` **U** Messaging as a user capability (no design doc yet; section 4)
- `[ ]` **A2A** Agent-to-agent messaging (nice to have; see the [pending plan](../../../../pending/000-agent-to-agent-messaging/001-plan.md))

**Not in the queue.** Do not start these unless the owner resumes them:

- **Phase 4, WhatsApp adapter: paused.** Meta billing is unclear. See [085](./085-billing-and-metering.md).
- **Phase 5, SMS adapter: deferred** (decision D-R2).
- **Phase 6, contract migration:** only after dual-read is live in every environment.

## 4. Task details

### P0 Baseline

Before any code change, run the Telegram-related test files and confirm they pass:

`pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert`

If any fail, stop and report. Do not fix unrelated failures. Record the result in 900 (section 7).

### P2.1 Schema

Write the Drizzle definitions first, in `packages/db/src/schema/`:

- Add the `chat_addresses` table (040 §1).
- Add `delivery_provider`, `delivery_address`, and `provider_message_id` to `agent_outbound_messages` (040 §2). Keep the Telegram columns.
- Widen `agent_documents.source` (040 §3).
- Approval-source values: use `chat_yes` / `chat_no` with a provider field, per the 040 §3 recommendation (option a). Record this as a decision in 900.

Export the new table from `index.ts`.

### P2.2 Generated expand migration

With the schema in place, run `pnpm --filter @herobids/db run db:generate`. Review the generated SQL by hand. It must be additive and nullable, with nothing dropped. Migrations live in `packages/db/drizzle/`; the latest is `0075_drop_chat_tables.sql`.

### P2.3 Repository and resolver

Implement `getEffectiveChatAddress(agentId, provider)`. Use the same precedence and whitespace rules as `getEffectiveTelegramChatId`. Implement `resolveAgentForChatReply(provider, address, providerMessageId?)`. Both read `chat_addresses` first and fall back to the legacy columns (dual-read).

### P2.4 Custom backfill migration

Create an empty migration with `pnpm --filter @herobids/db exec drizzle-kit generate --custom --name=<name>`, then write the SQL by hand. Copy each existing Telegram chat ID into `chat_addresses` with `provider='telegram'`, `status='active'`, `verified_at=now()`. Copy existing outbound rows as in 040, Migration step 2.

### P2.5 Dual-write

New outbound sends write both the legacy and the neutral columns. Find the writers with `grep -rn telegram_message_id apps packages --include=*.ts`.

### P2.6 Tests and Phase 2 gate

Reply routing and effective-address resolution must pass against legacy-only data, neutral-only data, and both. Add a backfill test. Test names describe behaviour, not implementation.

**Gate:** the P2.6 tests pass, and the P0 Telegram files still pass unchanged.

### P3.1 Neutral webhook route

Add `POST /messaging/chat/:provider/webhook` and a GET verify variant. They delegate to the adapter registry. Keep `POST /telegram/webhook` working as an alias. It is in [agent-interactivity.ts](../../../../../../apps/api/src/routes/agent-interactivity.ts).

### P3.2 Auth bypass for the new route

**Pre-approved:** add the new path to the existing bypass, in [auth.ts](../../../../../../apps/api/src/plugins/auth.ts), alongside `if (path === '/telegram/webhook') return true;`.

**Not pre-approved:** any change to how signatures or secrets are verified (050, "Per-provider verify"). For example, the Telegram check on the `x-telegram-bot-api-secret-token` header. Stop and ask before changing that.

### P3.3 Config

Add `messaging.chat.*` (060) to the Zod schema in `packages/domain/src/config/schema.ts` and to `config/default.yaml`. Read `alerts.telegram.*` as a fallback alias. Any env var gets a committed `.env*.example` twin in the same commit.

### P3.4 Tests and Phase 3 gate

Telegram works through both routes. Config loads from old and new keys. A webhook without the right secret is rejected.

**Gate:** the P3.4 tests pass, and the Phase 2 gate still passes.

### T, W, E, U

T, W and E each have a design doc (section 3). Read it and follow it.

U has no design doc. Write a plan first, in this folder as `090-messaging-capability.md`, following the plan format of [900](./900-implementation-plan.md). Then **stop and ask the owner to approve it** before coding.

## 5. Rules

- **Telegram must not regress.** Each step keeps the existing Telegram behaviour and tests green.
- **Config layers.** Operator config (`config/default.yaml` plus env) and instance config (Postgres JSONB) are never mixed. New keys go in the schema and `default.yaml`. No hard-coded magic numbers.
- **Every `.env*` variable has a committed `.example` twin** in the same change.
- **Errors.** Public APIs return `Result<T, E>`. Error codes are dot-strings (for example `venue.timeout`).
- **Types.** Strict TypeScript. No `any`, `@ts-ignore`, or `as unknown as X`. Zod at boundaries.
- **Architecture.** Ports and adapters. Business logic is pure. Constructor injection.
- **Commits.** Atomic, one logical change per commit. Tests describe behaviour.
- **Comments.** Only where something needs clarification.
- **Do not** run Terraform `apply`, touch S3, DNS, or servers, or deploy, without explicit owner approval.
- **Do not** enable live trading or commit secrets.
- **Do not** change parity-drift files without the rules in IMPLEMENTATION §3.1.
- **Uncommitted docs.** Some 007 and 002 docs have uncommitted edits. Do not revert them. Stage only the files your task changed. Ask the owner before committing doc edits you did not make.

## 6. Commands

| Purpose | Command |
| --- | --- |
| Install | `pnpm install` |
| Generate migration | `pnpm --filter @herobids/db run db:generate` |
| Custom (empty) migration | `pnpm --filter @herobids/db exec drizzle-kit generate --custom --name=<name>` |
| Apply migrations (local) | `pnpm --filter @herobids/db run db:migrate` |
| Type-check (per project) | `npx tsc -p apps/api/tsconfig.json --noEmit`, `npx tsc -p apps/worker/tsconfig.json --noEmit`, `npx tsc -p packages/db/tsconfig.json --noEmit` |
| Targeted tests | `pnpm exec vitest run <path-or-name-filter>` |
| Full tests | `pnpm test` |
| Lint | `pnpm lint` |

The root `pnpm lint` checks nothing, according to [PROGRESS.md](../002-agent-onboarding-epic/PROGRESS.md). Run the per-project type checks as well.

Run the smallest command that covers your change first. Run the full suite before a phase gate. Do not run e2e or deploy scripts unless the owner asks.

## 7. Recording progress

- **Task state:** tick the checkbox in section 3 when the task's gate passes. This is the only task-state record.
- **Phase gates:** when a phase gate passes, add a dated entry to the phase section in [900](./900-implementation-plan.md) with the commands run and their results.
- **Decisions:** add them to the decision log in 900, with the date and reason. Use IMPLEMENTATION §5: decide, record, move on.
- **Epic-level items:** [PROGRESS.md](../002-agent-onboarding-epic/PROGRESS.md) only.

## 8. Handoff and continuation

When a task's gate passes:

1. Tick it in section 3.
2. If a phase gate passed, add the entry to 900 (section 7).
3. **Continue** to the next unchecked item, unless a stop trigger at the top of this file applies, or the item is U (write the plan, then stop for approval).
4. When the queue is finished, stop and report to the owner. Do not start paused or deferred work.

Tell the owner what passed each time you stop, with the commands you ran and their results.

## 9. Open owner decisions (do not decide these yourself)

- **C. Product target.** [000-README](./000-README.md) says "at least two chat providers beyond the platform inbox". The queue above reaches Telegram plus notifications (web push, email) and not a second chat provider. Owner to choose: unpause WhatsApp or SMS, or revise the target.
