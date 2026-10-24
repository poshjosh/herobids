# 081 Web Push and installable PWA: implementation plan

**Status:** Accepted 2026-10-24. Owner accepted the recommended default for every decision in this plan (D1–D12). Ready to implement.
**Date:** 2026-10-24
**Parent:** [080-web-push-notifications](./080-web-push-notifications.md) · **Plan:** [900-implementation-plan](./900-implementation-plan.md), Phase W
**Entrypoint:** task W in [AGENT-ENTRYPOINT](./AGENT-ENTRYPOINT.md) §3 (unchecked). Do not implement until the Open decisions below are answered.

## Goal

Add an opt-in Web Push notification channel (`NotificationChannel` port with a `web-push` adapter) and make the web app installable (PWA), so iOS 16.4+ users can receive pushes from a Home Screen app. A notification tap opens `/agents/<id>`.

## Non-goals

- Inbound replies through push. Push is one-way; chat stays reply-only.
- Email fallback (Phase E, [082](./082-email-fallback-implementation-plan.md)).
- Web-chat typing over SSE (later slice).
- Offline caching of the app shell.
- Any change to Telegram or WhatsApp behaviour.
- Silent background pushes. Every push must show a visible notification.

## Current state (verified 2026-10-24)

- **No service worker.** No `sw.js`; no `serviceWorker`, `registerSW`, or `PushManager` references under `apps/web`. `apps/web/vite.config.*` uses react, tailwind, and sitemap plugins only.
- **Manifest exists** at `apps/web/public/site.webmanifest`: name, short_name, 192 and 512 maskable icons, `#ffffff` theme and background, `display: standalone`. It has no `id`, `start_url`, or `scope`.
- **HTML head:** `apps/web/index.html` lines 26–28 (apple-touch-icon, `apple-mobile-web-app-title`, manifest link). No `apple-mobile-web-app-capable` meta.
- **Routes:** `apps/web/src/app/router.tsx:50` maps `/agents/:id` to `AgentDetailPage` (`apps/web/src/features/agents/AgentDetailPage.tsx`).
- **i18n:** `apps/web/src/app/i18n/locales/{en,ar,hi}.ts` (flat `messages` record) with react-intl in `I18nProvider.tsx`. Entry point is `apps/web/src/main.tsx`.
- **Ports:** `packages/domain/src/ports/` has `chat-channel.ts` and `index.ts`. There is no notification port. `Result` is in `packages/domain/src/result.ts`.
- **Schema:** no push table. `packages/db/src/schema/index.ts` exports no push subscriptions. Latest migration is `packages/db/drizzle/0077_chat_addresses_backfill.sql`. Repositories follow the `*-repository.ts` pattern in `packages/db/src/`.
- **Config:** `MessagingConfigSchema` in `packages/domain/src/config/schema.ts` (~line 611) contains only `chat.telegram`. `config/default.yaml` has `messaging:` at line 747. Email transport config sits under `alerts.email` (schema ~644; default.yaml ~771). Env mapping for it is in `apps/api/src/config.ts:52–57` and `apps/worker/src/config.ts:37–42`.
- **Send path:** `AgentMessageBroker.handleSendMessage` (`apps/worker/src/agents/agent-message-broker.ts:486`) persists the outbound message, then calls `chatDelivery.send` (~523–541). This is the push hook point. The comment near the end of the function records that email fanout here was removed.
- **Event classes:** `messageClass` is `routine | alert | reminder` (`apps/worker/src/tools/messaging.ts:11`). A task-completed signal exists only as `completedAt` in `apps/worker/src/tools/tasks.ts:118`, with no notification emitter.
- **Not reusable:** `apps/worker/src/alerting/alert-dispatcher.ts` is operator Telegram alerting driven by journal events. It is not a user notification path.
- **User settings:** `users.notificationPreferences` JSONB (`packages/db/src/schema/users.ts` ~line 26) holds only the legacy `sendMessage.email` key. It is read and written by the handler in `apps/api/src/routes/auth.ts` (~lines 915–980).
- **Auth:** `apps/api/src/plugins/auth.ts` `isPublicRoute` (line 108). Push routes are not on this list.
- **No dependency:** no `web-push` package and no VAPID configuration anywhere in `apps` or `packages`.

### Conflicts between 080 and the code

1. 080 places config at top-level `notifications.webPush`. Messaging config lives under `messaging.*`. See D7.
2. 080 says "reuse `messageClass` where it exists". Its three classes (agent reply, task completed, agent question) do not exist in `messageClass`. See D4.
3. 080 says "Manifest already exists, extend it." Accurate, but the manifest lacks `id`, `start_url`, and `scope`, and the head lacks the iOS standalone meta tag.
4. 080 says "Secrets are env-only." This is compatible with the config rule (YAML plus env) only if the VAPID private key is the one env var. See D1.

## Decisions needed from the owner

All items are **Open**. The recommended default applies if the owner does not object.

| ID | Question | Recommended default |
| --- | --- | --- |
| D1 | **VAPID key ownership.** Who generates and holds the key pair? | Operator-owned. `VAPID_PRIVATE_KEY` is env-only (secret) with a blank twin in root `.env.example`. The public key is `messaging.notifications.webPush.vapidPublicKey` in YAML. This is a secret-handling change, so owner approval is required (AGENT-ENTRYPOINT §0 item 2). |
| D2 | **Push opt-in.** Is push opt-in per user? | **Open, default yes.** Users opt in per device. Opt-in equals an active `push_subscriptions` row. The operator switch `messaging.notifications.webPush.enabled` defaults to `false`. |
| D3 | **Quiet hours.** Do we suppress pushes at night? | None in v1. Quiet hours need a user timezone source, and none was identified in the users schema fields read. Revisit after launch. |
| D4 | **Which event classes notify?** 080 lists agent reply, task completed, agent question. | Add `NotificationClass = 'agent.reply' \| 'agent.question' \| 'task.completed'`. Set `agent.question` when `replyRequested` is true, otherwise `agent.reply`. Defer `task.completed` until an emitter is named. Config default `eventClasses: ["agent.reply", "agent.question"]`. |
| D5 | **Notification content.** Include a body preview? | No. Title is the agent name, body is the fixed text "You have a new message", no message text (080 risk). A `includeBodyPreview` key is added only if the owner wants previews. |
| D6 | **Telegram users.** Does push fire when the user also has Telegram? | Yes. Push is an independent channel. Neither suppresses the other. |
| D7 | **Config key location.** 080 says `notifications.webPush`. | `messaging.notifications.*`, beside `messaging.chat`. Email transport stays under `alerts.email`. Owner to confirm the change from 080. |
| D8 | **New dependency.** Use the `web-push` npm package, or hand-roll VAPID signing and payload encryption? | `web-push`. This adds a dependency, so owner approval is needed. |
| D9 | **Subscription API auth.** Are push routes public? | All authenticated. The public key is returned only to logged-in clients. This avoids a change to `isPublicRoute`, which is a stop trigger. |
| D10 | **Failure tracking.** 080's email rule needs "every push failed in the window". The schema has only `last_success_at`. | Add `last_failure_at` and `last_failure_code` to `push_subscriptions`. |
| D11 | **Service-worker caching.** | None in v1. The worker handles only `push` and `notificationclick`. Caching the SPA shell risks stale bundles after deploys. |
| D12 | **Install UX.** Use `beforeinstallprompt`? | No in v1. It is Chromium-only. Show static "Add to Home Screen" steps on iOS Safari and a generic install hint elsewhere. |

## Task breakdown

Tasks are ordered. Test files named "new" are proposed; confirm the name when you create them.

### Phase W-A: config, domain, storage, adapter (no user-visible change)

**W1. Config keys and VAPID env twin.**
- Description: add `messaging.notifications` to `MessagingConfigSchema`: `enabled` (false), `eventClasses` (D4 default), `webPush.enabled` (false), `webPush.vapidSubject` (""), `webPush.vapidPublicKey` (""), `webPush.vapidPrivateKey` (env-only, mapped per D1), `webPush.ttlSeconds` (int, positive, default 86400), `webPush.urgency` (enum `very-low | low | normal | high`, default `normal`). Add the defaults under `messaging:` in `config/default.yaml`. Map `VAPID_PRIVATE_KEY` in both config maps.
- Files: `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/api/src/config.ts`, `apps/worker/src/config.ts`, `.env.example`. New test `packages/domain/src/config/notifications-config.test.ts`.
- Test: defaults parse with the feature disabled; invalid `urgency` and non-positive `ttlSeconds` are rejected; `messaging.chat.telegram` and `alerts.telegram` parse unchanged.
- Gate: config tests green; Telegram config tests unchanged; `.env.example` has a blank `VAPID_PRIVATE_KEY` line with a comment.

**W2. Port, payload, and filter (pure).**
- Description: new `NotificationChannel` port with `notify(recipient, payload): Promise<Result<NotificationSendResult, DomainError>>`. Add `NotificationClass` and `NotificationPayload` (`agentId`, `agentName`, `title`, `body`, `url`, `eventClass`). Add pure `buildNotificationPayload` (fixed body per D5; `url` is `/agents/<id>`) and `shouldNotify(eventClass, config)`. Error codes: `notification.class_disabled`, `notification.subscription_gone`, `notification.provider_failed`.
- Files: new `packages/domain/src/ports/notification-channel.ts`, new `packages/domain/src/notifications/payload.ts`, `packages/domain/src/ports/index.ts`, `packages/domain/src/index.ts` (confirm export).
- Test: new `packages/domain/src/notifications/payload.test.ts`. Table tests for `shouldNotify` (enabled and disabled class, feature off). Payload has no message text and no secrets.
- Gate: domain tests green. Depends on W1.

**W3. Schema, migration, repository.**
- Description: new table `push_subscriptions` with `id`, `user_id` (FK to `users`), `endpoint` (unique), `p256dh`, `auth`, `user_agent`, `created_at`, `last_success_at`, `last_failure_at`, `last_failure_code`, `revoked_at` (080 fields plus D10). Export it. Generate the migration. Repository methods: `upsertForUser`, `listActiveForUser`, `markSucceeded`, `markFailed`, `revoke`.
- Files: new `packages/db/src/schema/push-subscriptions.ts`, `packages/db/src/schema/index.ts`, new `packages/db/drizzle/0078_*.sql` (check the next number), new `packages/db/src/push-subscription-repository.ts`.
- Test: new `packages/db/src/push-subscription-repository.test.ts`. Unit test of the mapping; integration test for the unique endpoint and revoke, skipped without `DATABASE_URL` (same pattern as the Phase 2 integration tests).
- Gate: `cd packages/db && pnpm db:generate` produces exactly one new migration; no existing migration is edited. Depends on W1.

**W4. Web Push adapter (worker).**
- Description: `WebPushChannel implements NotificationChannel`. It takes an injected `WebPushSender` wrapper around `web-push` (constructor injection). It applies `ttlSeconds` and `urgency` from config. HTTP 404 or 410 revokes the subscription. 429 and 5xx return `notification.provider_failed` and do not revoke. Records success or failure through the repository. Never logs the full endpoint.
- Files: new `apps/worker/src/notifications/web-push-channel.ts`, new `apps/worker/src/notifications/web-push-sender.ts`, `apps/worker/package.json` (the `web-push` dependency, per D8).
- Test: new `apps/worker/src/notifications/web-push-channel.test.ts` with a fake sender: 201 marks success; 410 revokes; 500 marks failure and does not revoke; the payload has no body text or secret.
- Gate: tests green; `npx tsc -p apps/worker/tsconfig.json --noEmit` exit 0. Depends on W2, W3, D8.

**W5. Dispatch hook in the broker.**
- Description: in `handleSendMessage`, after the chat send, if `shouldNotify` is true and the feature is on, call `WebPushChannel.notify` once per active subscription. Map `replyRequested` to `agent.question` and otherwise `agent.reply` (D4). The channel is an optional constructor dependency, so when it is absent nothing changes. Errors are logged and never change the chat result or throw.
- Files: `apps/worker/src/agents/agent-message-broker.ts` (~lines 486–550), `apps/worker/src/index.ts` (wiring, where `workerTelegram` is injected).
- Test: extend `apps/worker/src/agents/agent-message-broker.test.ts`. Assert that existing Telegram assertions are unchanged. New cases: one push per active subscription; no push when the class is disabled or the feature is off; a push failure does not change the chat result.
- Gate: `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` green (the 900 baseline command). Depends on W2, W4.

### Phase W-B: API and PWA client

**W6. Push routes (authenticated).**
- Description: new `apps/api/src/routes/push.ts`. `GET /push/config` returns `{ enabled, vapidPublicKey }`. `POST /push/subscriptions` validates the body with Zod (`endpoint`, `keys.p256dh`, `keys.auth`) and upserts for the current user. `DELETE /push/subscriptions/:id` revokes only the caller's rows. Register the routes in `apps/api/src/index.ts`. Do not add them to `isPublicRoute` (D9).
- Files: new `apps/api/src/routes/push.ts`, new `apps/api/src/routes/push.test.ts`, `apps/api/src/index.ts`.
- Test: Fastify `inject`. 401 without a token; 404 for another user's subscription; 201 on a valid body; 400 on a bad body; `enabled: false` when the feature is off.
- Gate: `pnpm exec vitest run push` green; `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0. **Stop trigger:** adds routes. Owner approval needed before this task (AGENT-ENTRYPOINT §0 item 3). Depends on W3.

**W7. Service worker, registration, and manifest.**
- Description: new `apps/web/public/sw.js` with a `push` handler that always calls `showNotification`, and a `notificationclick` handler that focuses an open same-origin window or opens `/agents/<id>`. No `fetch` handler (D11). New `apps/web/src/lib/push/register-service-worker.ts`, called from `apps/web/src/main.tsx`; it is a no-op when unsupported. Manifest: add `id`, `start_url: "/"`, `scope: "/"`. `apps/web/index.html`: add `<meta name="apple-mobile-web-app-capable" content="yes" />`.
- Files: new `apps/web/public/sw.js`, new `apps/web/src/lib/push/register-service-worker.ts`, `apps/web/src/main.tsx`, `apps/web/public/site.webmanifest`, `apps/web/index.html`.
- Test: new `register-service-worker.test.ts` (mock `navigator.serviceWorker`; unsupported is a no-op). New `apps/web/public/site-webmanifest.test.ts` parses the JSON and asserts the required keys.
- Gate: `pnpm exec vitest run register-service-worker site-webmanifest` green; `npx tsc -p apps/web/tsconfig.json --noEmit` exit 0.

**W8. Opt-in UI and i18n.**
- Description: new `apps/web/src/features/notifications/PushOptIn.tsx`, shown on `AgentDetailPage.tsx` and the settings page. States: unsupported, needs install (iOS not standalone), permission denied, subscribed, error. On opt-in it calls `PushManager.subscribe` with the key from `GET /push/config`, then `POST /push/subscriptions`. Add the same keys to `en.ts`, `ar.ts`, and `hi.ts`, with English fallback.
- Files: new `apps/web/src/features/notifications/PushOptIn.tsx` and its test, `apps/web/src/features/agents/AgentDetailPage.tsx`, the settings page (confirm the path), `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`.
- Test: new `PushOptIn.test.tsx` (React Testing Library) covers each state with a mocked `PushManager`. An i18n parity test asserts every new key exists in en, ar, and hi.
- Gate: web tests green. Depends on W6, W7.

**W9. Manual PWA and push verification.** See Verification. Gate: manual checklist M1–M5 recorded in the 900 Phase W record.

**W10. Phase gate record.** Run the full command set in Verification, then record results in 900 Phase W. Tick task W in AGENT-ENTRYPOINT §3 only when the gate passes. Do not do this while drafting.

### Dependencies

```
W1 ──► W2 ──► W4 ──► W5
 └───► W3 ──► W4 (also needs W2)
        └────► W6 ──► W8 ◄── W7
W5, W6, W8 ──► W9 (manual) ──► W10
```

- W2 and W3 are independent of each other after W1.
- Telegram has no dependency on W. Its tests run as a guard after every phase.
- **W and E:** W first. E needs the port (W2), subscription and failure state (W3), push outcomes (W4), and the hook (W5). Without W, E has no push condition to test against.

## Verification

| When | Command or check |
| --- | --- |
| After W1–W2 | `pnpm exec vitest run notifications notifications-config`; `npx tsc -p packages/domain/tsconfig.json --noEmit` |
| After W3 | `cd packages/db && pnpm db:generate`; `pnpm exec vitest run push-subscription`; with `DATABASE_URL` set, rerun for the integration test |
| After W4–W5 | `pnpm exec vitest run web-push agent-message-broker`; `npx tsc -p apps/worker/tsconfig.json --noEmit` |
| Telegram guard, every phase | `pnpm exec vitest run telegram chat-inbound agent-message-broker platform-alert` |
| After W6 | `pnpm exec vitest run push`; `npx tsc -p apps/api/tsconfig.json --noEmit` |
| After W7–W8 | `pnpm exec vitest run register-service-worker site-webmanifest PushOptIn`; `npx tsc -p apps/web/tsconfig.json --noEmit` |
| Phase gate | `pnpm lint`; `pnpm test` (full suite must stay green) |

**Manual checks (not automated, mark as manual in the record):**

- **M1 Chromium desktop:** serve the app on localhost or HTTPS. In DevTools, Application > Service Workers shows `sw.js` active. Grant permission, opt in, send a test push, and confirm that clicking it opens `/agents/<id>`.
- **M2 Installability:** DevTools, Application > Manifest, shows no errors. Install from the browser menu.
- **M3 Android Chrome:** install the PWA, close it, and confirm a push arrives and opens the agent.
- **M4 iOS 16.4+ Safari (manual):** Add to Home Screen, open from the Home Screen icon (not a Safari tab), enable notifications, lock the screen, receive a push, and tap through to the agent.
- **M5 Unsubscribe:** revoke from the UI; confirm the row is revoked and no further push arrives.

## Risks and open points

- **iOS:** push works only for a Home Screen web app on iOS 16.4+. Expect low opt-in until users install. The UI must explain this (W8).
- **Delivery is not guaranteed.** The web chat remains the source of truth.
- **VAPID rotation** invalidates every existing subscription. Document the rotation procedure before launch.
- **Endpoint URLs** act as bearer credentials. Never log them in full.
- **Service worker updates:** without `skipWaiting` a new `sw.js` waits for all tabs to close. Decide the update policy before launch.
- **Duplicate sends:** confirm that `handleSendMessage` runs in one worker replica only. If it can run in several, pushes can duplicate. Open.
- **Provider rate limits:** push services can return 429. The v1 rule is "no revoke, record failure". Retry and backoff are not specified. Open.
- **Notification volume:** agents can send often. A per-user cap is needed. The value is decided with E (082, E-D5).
- **Stop triggers:** D1 (secret handling) and W6 (new routes) need owner approval before those tasks start.

## Outstanding Issues

None yet.
