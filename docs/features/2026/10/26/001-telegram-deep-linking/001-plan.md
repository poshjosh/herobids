# 001 Plan: Telegram deep-link connect

## Goal
Replace manual Chat ID copy and paste with a one-tap "Connect Telegram" flow using `https://t.me/<bot>?start=link_<token>`.

## Decisions
1. **Scope.** Telegram is user-level only, and per-agent overrides are dropped.
2. **Create-agent form.**
   - If the user has no linked Telegram, show an inline "Connect Telegram" button. Agent creation is not blocked.
   - If Telegram is already linked, show nothing.
   - The connection is stored as the user default.
3. **Chat ID already bound to another user.** Reject, and reply in the bot with a clear message.
4. **Bot username.** Add the config key `messaging.chat.telegram.botUsername`.
5. **No manual Chat ID input anywhere.** There is no back-compat, because we're pre-launch.
6. **Settings.** "Connect Telegram" and "Disconnect" buttons replace the field.

## Flow
1. Web calls `POST /auth/me/telegram/link`. The API creates a CSPRNG token and stores `tg-link:<token>` → `userId` in Redis with a 10-minute TTL. It returns `{ url, expiresAt }`.
2. Web opens the URL, and the user taps **Start** in Telegram.
3. Telegram sends `/start link_<token>` to `/telegram/webhook`.
4. The webhook consumes the token (`GETDEL`). It takes the chat ID from the update and calls `setChatAddress` at user scope (`agentId = null`).
5. The bot replies "Connected ✅".
6. Web polls `GET /auth/me` every 2 s for up to about 2 min, until `chatAddresses` contains telegram. It then shows "Connected".

## Backend
- **Token module** (new, under `apps/api/src/agents/`):
  - `createTelegramLinkToken(redis, userId)` and `consumeTelegramLinkToken(redis, token)`.
  - The token matches `[A-Za-z0-9_-]`, with a total `start` payload of 64 characters or fewer.
  - Rate limit: for example 5 requests per user per 10 min, using the existing Redis counter pattern.
- **Route** `POST /auth/me/telegram/link` in `auth.ts`. It requires an authenticated user and returns 503 if `botUsername` isn't configured.
- **Webhook branch** in `processWebhookUpdate` in `agent-interactivity.ts`:
  - It runs before the suppression check and before the slash-command routing and the "bind first" gate. A valid token lifts suppression (explicit re-consent). An invalid token on a suppressed chat stays silent.
  - It matches `/^\/start link_([A-Za-z0-9_-]+)$/`.
  - Outcomes:
    - Invalid or expired token → "This link has expired. Generate a new one in the web app."
    - Chat bound to a different user → reject: "This Telegram account is already connected to another OpenAIdom account."
    - Same user already bound to the same chat → idempotent success.
    - User bound to a different chat → replace the address (re-link).
  - Existing `/start <agent>` and bare `/start` keep working. Add regression tests.
- **Config:** add `messaging.chat.telegram.botUsername` to the schema in `packages/domain/src/config/schema.ts` and `messaging-chat.ts`, plus config files and staging/prod values.
- **Ownership check:** add a repository lookup in `packages/db` for "chat bound to another user". Use `findUserByTelegramChatId` or a new helper.
- **No DB migration.** The `chat_addresses` table already fits.

## Web
- Add a reusable `ConnectTelegram` component (button, polling, connected, expired and error states). It is used in:
  - `SettingsPage.tsx`, which also gets a Disconnect action calling `updateMe({ chatAddresses: [{ provider: 'telegram', address: null }] })`.
  - `CreateAgentFlow.tsx`, shown only when `chatAddressFor(me.chatAddresses, 'telegram')` is empty.
- Remove `telegramAddress` from the agent form state and payloads:
  - `agent-form-state.ts`, `agent-payloads.ts`, `AgentFormBody.tsx`, `EditAgentModal.tsx`, `CreateAgentFlow.tsx`.
  - The agent create/update payloads no longer send `chatAddresses` for Telegram. Check the API agent routes and `withAgentChatAddresses` for per-agent handling to remove or ignore.
- i18n (en, hi, ar):
  - Replace `agents.telegramChatId.help`, `agents.create.telegramChatId*` and `settings.telegram.*` with Connect, Connected, Expired, Disconnect and Error strings.

## Docs
- Update `platform-docs-data.ts` at lines 1274, 1334 and 1449.
- Rewrite UAT AG-N04 in `docs/tech/user-acceptance-tests.md`.
- Add a CHANGELOG entry.

## Tests
- **Unit:** token create, consume and replay, TTL, and the rate limit.
- **API functional:** link route (auth, 503, rate limit) and webhook link branch (success, expired, replay, other-user conflict, re-link, suppressed chat). Regression for `/start <agent>` and bare `/start`.
- **Web:** `ConnectTelegram` states, with the create-flow field hidden when already linked, and Settings Connect and Disconnect.
- **Cleanup:** update or remove existing tests that reference `telegramAddress`.
- **Verify:** typecheck, lint, then the unit and functional suites for api, web and db.

## Phasing
1. Backend (token, route, webhook, config) plus tests.
2. Web component, Settings and Create flow, i18n.
3. Cleanup of per-agent Telegram plumbing, then docs and UAT.

## Risks
- **`/start` collision.** Use the reserved `link_` prefix and put the branch first, with regression tests.
- **Bot username misconfigured per environment.** Return 503 and add a startup warning.
- **Token leakage.** The token is single-use and short-lived, and the chat ID comes only from Telegram's update.

## Estimate
About 1.5–2.5 days.

## Task Status
- [x] DONE — Phase 1: Backend (token module, link route, webhook branch, config) plus tests
- [x] DONE — Phase 2: Web component, Settings and Create flow, i18n
- [ ] PENDING — Phase 3: Per-agent Telegram cleanup, docs and UAT

## Outstanding Issues
- Consume happens outside the DB transaction; a DB failure after consume spends the token and the user must regenerate the link.
- A link issued before a revoke can lift that revoke; revoke has no production caller yet. Revisit when revoke is wired.
- Link URL is a bearer credential (accepted per plan risks; 10-minute TTL, single use, no-store).

### Phase 1 (Backend) — review findings deferred
- **HIGH (config):** `messaging.chat.telegram.botUsername` is blank in `infra/hetzner/.env.production`, so `POST /auth/me/telegram/link` returns 503 in production until the production bot username is set. Staging is `OpenAIdomBot`, taken from a comment and not yet confirmed with `getMe`.
- **MEDIUM:** The blueprint install pre-fill (`blueprints.ts`) and `agent-instantiation-service.ts` do not map `ChatAddressInUseError` to 409, so a conflict returns 500. Reachable only with pre-guard legacy data.
- **MEDIUM:** `applyChatAddresses` and the lock helpers accept any executor. A caller that passes `db` instead of `tx` would silently get a no-op lock. All current callers pass `tx`.
- **LOW:** Plan drift: the Redis key is `tg-link:<sha256(token)>`, the webhook rejects non-private chats, PATCH `/auth/me` returns 409 on conflict, and the advisory lock is namespace 75 keyed by `telegram:<address>`.
- **LOW:** The `link_` payload regex has no explicit length cap. Telegram enforces 64.
- **LOW:** `revokeChatAddress` does not take the lock. A concurrent link may get a spurious 409.
- **LOW:** Rate-limit and token TTL values are constants, not config.

### Phase 2 (Web) — review findings deferred
- **MEDIUM:** A single failed `/auth/me` during polling ends the flow in the error state, even if the user already tapped Start in Telegram. Retry until the deadline, respecting the abort signal.
- **MEDIUM:** `handleConnect` has no state guard. The pre-close is safe only because the Connect button is hidden while connecting. Add an early return for connecting, fallback and a pending link request.
- **MEDIUM:** No DOM test covers a rejected `auth.linkTelegram` (rate_limited and bot_not_configured) at component level.
- **LOW:** Focus is not asserted for `connecting`, and there is no DOM test for `expired`.
- **LOW:** `SettingsPage.disconnect.dom.test.tsx` uses `?? ''` fallbacks that hide missing keys.
- **LOW:** `ConnectTelegram.dom.test.tsx` assumes the exact count of initial `/auth/me` calls. `window.open` and `auth.me` test doubles do not model real abort or tab behaviour.
- **LOW:** `tabRef` is not cleared when the pre-opened tab is already closed. The catalog-consistency test string-matches API source.
- **Dependencies added:** `jsdom@^26.1.0` (not 30.x, which needs Node 22.22+), `@testing-library/react@^16.3.3`, `@testing-library/dom@^10.4.2`, all devDependencies of `apps/web`.
- **Translation:** Hindi and Arabic copy for the Telegram strings (including the new `popupBlocked`, `rate_limited` and `bot_not_configured`) are drafts and need native review.
- **Visual test not yet run** for the Settings card and the Create-agent connect state.
