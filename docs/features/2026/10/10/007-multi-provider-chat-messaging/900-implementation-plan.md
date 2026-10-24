# Implementation Plan

**Created:** 2026-10-04 · **Last restructured:** 2026-10-24
**Parent:** [000-README.md](./000-README.md)

Phased so that each phase is independently shippable and verifiable, and so the
abstraction lands **before** any second provider. Every phase ends with
`pnpm lint` + targeted tests green (AGENTS.md). No phase regresses Telegram.

## How to read this plan

**If you are an agent starting work, read [AGENT-ENTRYPOINT.md](./AGENT-ENTRYPOINT.md) first.** It gives the reading order, the next task, the commands, and the rules.

1. Read the **status table** below first. It shows what is done, what is next, and what is paused.
2. Read the phase sections only for the phases you are working on.
3. Check the **decision log** at the bottom before changing a decision.
4. "Phase" means a phase of this plan. "Wave" means the epic's waves in [IMPLEMENTATION.md](../002-agent-onboarding-epic/IMPLEMENTATION.md) §6. The table maps between them.

## Status

The **state** of each item (done, next, paused) lives only in the task queue in [AGENT-ENTRYPOINT.md](./AGENT-ENTRYPOINT.md) §3. This table gives the design structure, epic wave and gate for each phase.

| Phase | Title | Epic wave | Gate | Section |
| --- | --- | --- | --- | --- |
| 0 | Capability-doc amendment | W1 | Manifest tests | [Phase 0](#phase-0--capability-doc-amendment-no-code) |
| 1 | Port + Telegram behind it | W1 | Telegram tests unchanged | [Phase 1](#phase-1--introduce-the-port-re-wire-telegram-behind-it-no-new-provider) |
| 2 | Channel-neutral data model | W4 | Dual-read tests | [Phase 2](#phase-2--channel-neutral-data-model-expand--backfill--dual-read) |
| 3 | Neutral ingress + `messaging.chat.*` config | W4 | Telegram via both routes | [Phase 3](#phase-3--provider-neutral-inbound-ingress--config-block) |
| T | Typing indicator | W4 | See [070](./070-typing-indicator.md) | [070](./070-typing-indicator.md) |
| W | Web Push and installable PWA | W4 | See [080](./080-web-push-notifications.md) | [080](./080-web-push-notifications.md) |
| E | Email notification fallback | W4 | See [080](./080-web-push-notifications.md) | [080](./080-web-push-notifications.md) |
| U | Messaging as a user capability | W4 | Plan first (see entrypoint §4) | — |
| 4 | WhatsApp adapter | W4 | See Phase 4 | [Phase 4](#phase-4--whatsapp-adapter-first-new-provider--paused-2026-10-24) |
| 5 | SMS adapter | W4 | See Phase 5 | [Phase 5](#phase-5--sms-adapter-second-new-provider--deferred) |
| 6 | Contract migration | W5 | See Phase 6 | [Phase 6](#phase-6--contract-migration-cleanup-separate-pr) |
| — | Agent-to-agent messaging | Later | — | [pending plan](../../../../pending/000-agent-to-agent-messaging/001-plan.md) |

### Task order

The ordered task queue is in [AGENT-ENTRYPOINT.md](./AGENT-ENTRYPOINT.md) §3. It is the only list of what to do next. Do not add a second list here.

## Open items

- **A. Wave 1 gate (resolved 2026-10-24, owner agreed).** Wave 1 is treated as passed.
  - *Basis:* [PROGRESS.md](../002-agent-onboarding-epic/PROGRESS.md) records "WAVE 1 GATE PASS" on 2026-10-13 (6,508 tests passing). The "blocked" note in the Phase 1 record came from an earlier run, when one tool-count test expected 26 tools and found 27. That count is now 30 in [runtime-tool-visibility.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-tool-visibility.test.ts), after the budget was raised in Wave 2 (see PROGRESS).
  - *Status of this note:* the "blocked" text in the Phase 1 record is kept as history. Not confirmed by a fresh test run.
- **C. Product target (open, owner decision).** [000-README](./000-README.md) says "at least two chat providers beyond the platform inbox". The unpaused queue reaches Telegram plus notifications (web push, email), not a second chat provider. Owner to choose: unpause WhatsApp or SMS, or revise the target. Not decided by an agent.
- **B. Phase 0 manifest tests (resolved).** The manifest key-set and planned-provider tests exist in [providers.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/providers.test.ts). The earlier record saying they did not exist is wrong. Not yet confirmed by a test run.

## Phase 0 — Capability-doc amendment (no code)

Align the registry with this feature before touching code.
- Amend [009 manifest](../../../../pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md):
  add `messaging / chat / sms` with transport mode **`brokered`** (decided, 020);
  note WhatsApp will flip `planned → available`.
- Consistency check against source ADRs: the amendment must stay within
  [ADR 07/002](../../../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md)
  (taxonomy + Telegram/Gmail asymmetry) and
  [ADR 08/008](../../../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)
  (messaging native; owner kinds). SMS is **brokered** like Telegram/WhatsApp, so
  no user-owned chat `connection` is introduced and no ADR change is required. A
  future per-user-number (connection-backed) model would be an ADR-level change
  (ADR 07/002 Follow-Up Rule 5), not a registry edit — and is out of scope.
- **Gate**: manifest tests still pass (key-set equality, planned-provider
  non-actionability). No new capability IDs or tools.

## Phase 1 — Introduce the port, re-wire Telegram behind it (no new provider)

The pure refactor. Behaviour-identical to today; this is where the risk is.
- Define `ChatProvider`, `ChatAddress`, `ChatOutboundBody`, `InboundChatMessage`,
  `ChatChannel`, `ChatInboundAdapter`, `ChatChannelRegistry` (010). Branded
  types; `Result`-returning (AGENTS.md).
- Implement `telegram-channel.ts` as a `ChatChannel` + `ChatInboundAdapter`
  wrapping the existing `TelegramClient` logic and the existing webhook
  parse/verify. No wire changes.
- Introduce `ChatDelivery` (worker) and migrate the three outbound senders
  (`agent-message-broker`, `platform-alert-service`, `agent-decision-handler`)
  off the concrete `TelegramClient` onto `ChatDelivery.send(...)`.
- Lift the inbound routing precedence out of `agent-interactivity.ts` into a
  provider-neutral `ChatInboundRouter`; keep `POST /telegram/webhook` working by
  delegating to the Telegram adapter + router.
- **Gate**: all existing Telegram tests pass unchanged (slash-commands, parser,
  handlers, broker, platform-alert, webhook integration). No schema change yet.

### Phase 0–1 implementation record (2026-10-13)

- Phase 0: added `messaging / chat / sms` as `planned / brokered` in the 009
  manifest. WhatsApp remains `planned`; no new capability ID or tool. This
  preserves the ADR 07/002 Telegram/Gmail transport asymmetry and ADR 08/008
  native messaging ownership. The promised manifest key-set/planned-provider
  tests do not exist in this checkout, so that specific gate is **unverified**;
  the nearby provider-catalog test passes but does not test the manifest.
- Phase 1: located the pure port in `packages/domain/src/ports` (shared by API
  and worker); Telegram outbound uses `ChatDelivery` + `TelegramChannel`, while
  the legacy webhook uses `TelegramInboundChannel` + `ChatInboundRouter`.
  Resolution still reads the effective Telegram chat ID; sent IDs and addresses
  still use the existing outbound columns, with delivery status persisted at
  the existing call sites until the neutral schema phase. Agent-authored body
  rendering is in the Telegram adapter; existing platform/approval HTML remains
  unchanged for this behavior-preserving phase. Operator alert dispatch is
  deferred as specified above. No new route, provider, config, environment variable, or
  schema change. Existing test fixtures were adapted to inject the new port;
  the behavior assertions remain in place.
- Checks: `pnpm lint` passed; targeted Telegram inbound, broker, billing,
  approval, safety-alert, and new port tests passed (235 tests in the two
  focused groups, with overlapping suites). The full `pnpm test` run finished
  with 6504 passed, 319 skipped, 1 failed: the concurrent A2
  `runtime-tool-visibility.test.ts` budget expects 26 tools and now sees 27.
  This is outside WP-M; Wave 1 repo test gate is **blocked** until that change
  is reconciled. No phase 2+ or Wave 2 work was started.

### WP-M review verification (2026-10-13)

- Phase 0 manifest key-set and planned-provider catalog acceptance tests pass;
  twelve previously missing known tool ownership rows were added. Planned
  providers are absent from the active registry/catalog and cannot be selected
  for chat dispatch. Custom-mode connections remain a separate, existing API
  behavior outside this phase.
- Phase 1 inbound reply resolution, target selection and stream delivery now
  reside in `ChatInboundRouter`; Telegram slash commands and document handling
  still use the legacy webhook. A provider-neutral reply test and existing
  Telegram webhook tests (including 501/401/200) pass. Chat address lookup
  failure now logs a warning without blocking email fallback.
- Focused tests: provider catalog/manifest 9 passed, inbound webhook/router 47
  passed, platform alerts 31 passed. `pnpm lint` passed. Full-suite gate remains
  blocked by the previously recorded concurrent A2 test failure; no full-suite
  rerun was performed for this review repair.

### WP-M Phase 0-1 HIGH/MEDIUM review repair (2026-10-13)

- The inbound router now passes the typed provider-qualified `ChatAddress` to
  reply resolution and all confirmation sends. The Telegram webhook adapter
  unwraps the chat ID at its existing repository/send boundary, preserving
  legacy Telegram resolution and webhook semantics. A collision test uses the
  same reply message ID and address on Telegram and WhatsApp and checks that
  each resolves to its own agent stream and confirmation recipient.
- Reconciled the seven task/reminder ownership rows with the superseding
  base-skill `core` decision. The manifest acceptance test now checks the full
  known-tool key set, owner syntax, registered native capability/backend
  references, and those seven `core` assignments; the planned-provider
  non-dispatch check remains in place.
- Investigated `set_tick_interval`: it is named in the manifest's supersession
  note but is absent from `KNOWN_AGENT_TOOL_NAMES` and the current worker task
  tools. It has no ownership row until the tool exists; adding one now would
  violate exhaustive key-set equality. No runtime changes were made.
- Verification: router collision test 4/4 passed immediately after first edit;
  combined manifest/router tests 13/13 passed; Telegram HTTP webhook tests
  13/13 passed (30 unrelated tests skipped by filter); `pnpm lint` passed.
  The prior full-suite A2 blocker remains outside this repair; no full-suite
  rerun was performed.

### P0 baseline record (2026-10-24)

- Command: `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert`
- Result: 8 test files passed, 1 skipped (`telegram-slash-commands.functional.test.ts`, 31 tests skipped by design); 169 tests passed, 31 skipped.

## Phase 2 — Channel-neutral data model (expand + backfill + dual-read)

Tasks: [entrypoint §4 P2.1–P2.6](./AGENT-ENTRYPOINT.md).

- Expand migration: `chat_addresses` table; `delivery_provider` /
  `delivery_address` / `provider_message_id` on `agent_outbound_messages`; widen
  `agent_documents.source`; neutral approval-source values (040).
- Backfill existing `telegram_chat_id` / outbound rows into the neutral shape.
- `getEffectiveChatAddress(agentId, provider)` and
  `resolveAgentForChatReply(provider, address, providerMessageId?)` with
  dual-read fallback to legacy columns.
- **Gate**: reply routing + effective-address resolution tests pass against both
  legacy-column and `chat_addresses` data. Backfill verified in a migration
  test. No column drops.

### Phase 2 gate record (2026-10-24)

- Integration: backfill (`chat-addresses-backfill.integration.test.ts`, 7 tests) and three-state resolver (`chat-address-resolution.integration.test.ts`, 14 tests) passed against a throwaway Postgres 17 container, now removed. They skip without a local `DATABASE_URL`.
- `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert`: 8 files passed, 1 skipped; 171 passed, 31 skipped.
- `pnpm exec vitest run packages/db`: 16 files passed, 6 skipped; 261 passed, 42 skipped.
- `tsc --noEmit` for `packages/db`, `apps/api`, `apps/worker`: exit 0. Root `pnpm lint`: exit 0.
- `pnpm test`: 340 files passed, 26 skipped; 6524 passed, 340 skipped. No failures.

## Phase 3 — Provider-neutral inbound ingress + config block

Tasks: [entrypoint §4 P3.1–P3.4](./AGENT-ENTRYPOINT.md).

- Add `POST /messaging/chat/:provider/webhook` (+ GET verify variant) delegating
  to the adapter registry; keep `/telegram/webhook` as a working alias.
- Introduce `messaging.chat.*` operator config (060) with `alerts.telegram.*`
  dual-read alias; add `.env.example` twins.
- **Gate**: Telegram works through *both* the new neutral route and the legacy
  route; config loads from both old and new keys.

## Phase 4 — WhatsApp adapter (first new provider) — **PAUSED (2026-10-24)**

**Status:** paused. Meta's billing is unclear (see the decision log). The Meta
prerequisites are **not** started. Earlier advice to start them now is withdrawn.

Depends on Phases 1–3. Operational prerequisites (030) run in parallel once resumed.
- `whatsapp-channel.ts`: Cloud API send (in-window free-form only — no
  templates), GET verify handshake + `X-Hub-Signature-256` verification, inbound
  parse incl. `context` quoting (050 strategy 2), per-recipient 24h window state
  with email fallback when closed.
- Auto-capture onboarding + consent recording (060); i18n keys.
- **Billing and metering:** see [085-billing-and-metering](./085-billing-and-metering.md). Usage ledger and `messaging.chat.billing` config are in that doc.
- Flip registry `whatsapp` → `available` when readiness check exists.
- **Gate**: send+receive round-trip test (mock Cloud API); window-closed path
  falls back to email; webhook signature rejection test; opt-in recorded; usage ledger records each accepted outbound send (see 085).
- **Confirm before launch**: Meta in-window pricing (rate card, by recipient country); direct-vs-BSP (030); billing default (085).

## Phase 5 — SMS adapter (second new provider) — **DEFERRED**

**Status:** deferred. SMS is off the critical path (decision D-R2, epic [IMPLEMENTATION.md](../002-agent-onboarding-epic/IMPLEMENTATION.md) §4). A2P registration is long-lead.

Depends on Phases 1–3; independent of Phase 4.
- `sms-channel.ts`: provider send (e.g. Twilio), `X-Twilio-Signature`
  verification, Unicode-aware segment-counting renderer (strip markup,
  handle/transliterate emoji, segment-aware truncation), inbound parse.
- **STOP/START/HELP interception** ahead of routing, updating
  `chat_addresses.status` (050, 030) — compliance-critical.
- Add `messaging / chat / sms` config + `.example` (one shared `SMS_FROM_NUMBER`,
  brokered); registry row `available`, transport mode `brokered`.
- **Gate**: send+receive round-trip test (mock provider); STOP sets `revoked`
  and blocks subsequent delivery; segment counting correct for GSM-7 vs UCS-2;
  webhook signature rejection test; inbound to the shared number routes to the
  correct agent via strategy 1 / `/to` (050).
- **Confirm before launch**: A2P 10DLC brand+campaign registered for the single
  shared number (conversational use case). Transport mode is already fixed —
  **brokered** (020) — so no number-model decision remains.

## Phase 6 — Contract migration (cleanup, separate PR)

Only after dual-read has been live and verified across environments.
- Remove dual-read; drop `users.telegram_chat_id`, `agents.telegram_chat_id`,
  `agent_outbound_messages.telegram_message_id` / `telegram_chat_id`; remove the
  `alerts.telegram.*` config alias and the `/telegram/webhook` alias (or keep
  the route alias indefinitely if external webhooks are already registered to it
  — Telegram's `setWebhook` points at a fixed URL, so **prefer keeping the route
  alias**, drop only the config/columns).
- **Gate**: full suite green with no legacy columns; no provider regressions.

## Deferred / out of scope (tracked, not built here)

- Agent-*initiated* messaging after a closed window (WhatsApp templates, SMS
  campaigns) — email covers it (README non-goal 2).
- Operator alert channels (`alert-dispatcher.ts`) migration to multi-provider —
  platform→operator, not reply-only; can follow in a separate slice.
- Per-user / per-agent dedicated numbers (connection-backed SMS). Ruled out by
  the all-brokered decision (020); would require a new ADR for a user-owned chat
  connection model.
- Rich provider features (buttons, reactions, voice).
- Agent-initiated **chat** after a closed window. Agent-initiated **notifications** are allowed on Web Push and email (see [080](./080-web-push-notifications.md)).

## Decision log

| Date | Decision | Owner | Where recorded |
| --- | --- | --- | --- |
| 2026-10-04 (first commit of the doc) | Provider-neutral `ChatChannel` port; abstraction before any second provider | Not recorded (doc owner unassigned) | [010](./010-design-overview.md) |
| 2026-10-04 (first commit of the doc) | SMS is brokered, like Telegram and WhatsApp; no user-owned chat connection | Not recorded (doc owner unassigned) | [020](./020-taxonomy-and-registry-placement.md), Phase 0 |
| Not dated in source | SMS off the critical path (D-R2) | Epic decision | [IMPLEMENTATION.md](../002-agent-onboarding-epic/IMPLEMENTATION.md) §4 |
| 2026-10-23 | WhatsApp service messages: Meta billing from 1 Oct 2026 (secondary sources) | — | [030](./030-provider-constraints.md), [085](./085-billing-and-metering.md) |
| 2026-10-23 | Billing model configurable; default `pass_through` | Owner | [085](./085-billing-and-metering.md) |
| 2026-10-23 | `pass_through` uses Meta's `billable` flag by default; `local_count` is the alternative | Owner | [085](./085-billing-and-metering.md) |
| 2026-10-24 | Phase 4 (WhatsApp) paused; Phase 5 (SMS) deferred; Meta prerequisites not started | Owner | Status table |
| 2026-10-24 | Notification channel (Web Push, email fallback) is separate from `ChatChannel` | Owner | [080](./080-web-push-notifications.md) |
| 2026-10-24 | Typing indicator is `sendTyping` on `ChatChannel`; Telegram only for now | Owner | [070](./070-typing-indicator.md) |
| 2026-10-24 | Agent-initiated notifications allowed on push and email; chat stays reply-only | Owner | [000-README](./000-README.md) non-goal 2 |
| 2026-10-24 | Next order: Phases 2–3, T, W, E, U, then agent-to-agent | Owner | Status table |
| 2026-10-24 | Chat address routing fails closed: only `status='active'` routes or sends; a non-active neutral row in scope blocks the legacy Telegram fallback | Agent (per 060 "Honour revocation") | [060](./060-config-secrets-onboarding.md), commit c59861f5 |
| 2026-10-24 | Inbound correlation checks the outbound `provider_message_id` first, then the unique active address, then the legacy Telegram pair | Agent (per 050 strategy 2) | [050](./050-inbound-routing.md), commit c59861f5 |
| 2026-10-24 | Approval resolutions keep writing `telegram_yes`/`telegram_no` and record `resolution_provider`; `chat_yes`/`chat_no` writes wait for readers | Agent (per 040 §3 option a) | [040](./040-data-model-and-migration.md) §3, commit 0a020968 |
| 2026-10-24 | P3.1 (new public route) and P3.2 (auth bypass) held for owner approval; P3.3 config done | Agent (stop trigger, AGENT-ENTRYPOINT §0) | AGENT-ENTRYPOINT §3 |
| 2026-10-24 | Approval resolution source generalised to `chat_yes` / `chat_no` with a provider field (`resolution_provider`), not per-provider values (040 §3 option a); `agent_documents.source` widened to add `whatsapp` / `sms` | Owner | [040](./040-data-model-and-migration.md) §3 |

## Risk notes

1. **Phase 1 is the risky one** — it's a wide refactor across worker + API with
   no behaviour change. Keep it strictly behaviour-preserving; add no features.
2. **i18n blast radius** (060) — Telegram strings exist in every locale; the
   per-provider generalisation is real translation work, not just backend.
3. **Window-state (WhatsApp) and STOP-handling (SMS)** are the two genuinely
   new stateful concerns; both have durable homes in `chat_addresses` and
   per-recipient state, and both fail safe (fall back to email / block send).
4. **External prerequisites gate launch, not code**: A2P registration and Meta
   verification are long-lead items. Start them when the owner resumes Phase 4
   or 5, not earlier. Phase 4 is paused and Phase 5 is deferred (2026-10-24).


## Outstanding Issues

Non-blocking review findings (MEDIUM/LOW), grouped by task.

### P2.5 Dual-write

- `markOutboundMessageSent` hardcodes `deliveryProvider: 'telegram'`. Correct today; pass the provider through when the first non-Telegram send path is added (Phase 4/5).
- `rejectApproval` in `approval-service.ts` has no callers and does not accept `resolutionProvider`. Remove it or extend it when it gets a caller.
- `resolutionProvider` from Redis is an unvalidated string. Constrain it to `telegram | whatsapp | sms` at the subscriber boundary (Zod).
- Add a worker subscriber test for an old `approval:execute` payload without `resolutionProvider` (must resolve to null).
- Use a union type for `resolutionProvider` in `decision-approval-repository.ts`.
- Integration test asserts the Redis payload with `stringContaining`; parse it and assert fields. Restore the `fetch` spy in `afterEach`.

### P2.3 Repository and resolver

- Revoked or pending rows in one tenant block inbound replies for the same provider address in other tenants (fail-closed, not owner-scoped). Decide whether to scope the block to the owner.
- Legacy Telegram pair lookup in `resolveAgentForChatReply` is not gated by scope status (no status exists on legacy columns).
- Inbound addresses are trimmed, stored addresses are not. Trim on write or match with `trim()` in SQL.
- `as ChatAddressValue` casts remain (pre-existing branded-type pattern). Add a validating domain constructor.
