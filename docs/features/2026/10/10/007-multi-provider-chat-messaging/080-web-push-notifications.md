# Web Push notifications and installable PWA

**Status:** planned (Phase W, 2026-10-24)
**Parent:** [000-README](./000-README.md) · **Plan:** [900-implementation-plan](./900-implementation-plan.md), Phase W

## Problem

Users who don't use Telegram or WhatsApp miss agent replies and task results
unless they open the web app. We need a free, cross-platform way to alert a user
and send them back to the right agent conversation.

## Decision

Add a **notification channel**, separate from the conversational `ChatChannel`:

- A user receives a Web Push notification when an agent has something for them
  (a reply, a result, or a question). Clicking it opens `/agents/<id>` in the web
  app.
- The reply itself happens in the web chat. Push is one-way. It does not accept
  inbound messages.
- The web app becomes installable (PWA) so that iOS can receive push.

Why not `ChatChannel`: the port is conversational (inbound and outbound
addresses), and its provider union (`telegram | whatsapp | sms`) has no web
path. A notification has no reply and no chat address.

## Facts (from the owner, 2026-10-23)

- Standard Web Push works in major modern browsers.
- iPhone and iPad support it only for web apps added to the Home Screen, on
  iOS/iPadOS 16.4 and later.
- Cost: no per-message Meta fee. We pay only our own infrastructure.
- Limits: users must opt in. Delivery depends on browser and device settings and
  is not guaranteed. Apple requires visible notifications, not silent background
  pushes.

## Design

### Port

`NotificationChannel` in `packages/domain/src/ports/`:

- `notify(user, { agentId, title, body, url, eventClass })` returns `Result`.
- Adapters: `web-push` (Phase W), `email` (Phase E).

### Event classes

Outbound events carry an `eventClass` (reuse `messageClass` where it exists).
Config lists which classes notify by default. Initial list: agent reply, task
completed, agent question. Other classes do not notify.

### Data

`push_subscriptions` table: `id`, `user_id`, `endpoint` (unique), `p256dh`,
`auth`, `user_agent`, `created_at`, `last_success_at`, `revoked_at`. Expired or
410 endpoints are revoked automatically.

### Config (`notifications.webPush`)

- `enabled` (boolean, default `false` until the gate passes).
- `vapidSubject` and the VAPID key pair. Secrets are env-only, with `.example`
  twins. Public key is served to the client.
- `ttlSeconds`, `urgency`.
- `eventClasses` (list).

Operator config only. No hard-coded values.

### Client

- A service worker (none exists today) handles `push` and `notificationclick`.
- Manifest already exists: [site.webmanifest](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/public/site.webmanifest). Extend it for install.
- Opt-in prompt on the agent detail page and in settings. Explain the iOS
  Home Screen step when the browser is not installed.
- All strings through i18n (en, ar, hi), with English fallback.

### Email fallback (Phase E)

Send the same notification by email only when:
- the user has no active push subscription, or
- every push to that user failed in the last window, and
- the event class is on the email list.

Never send both for one event. Email is never sent in place of an opted-in push
that succeeded.

## Gate

- Unit tests: subscription store, VAPID payload build, 404/410 revocation,
  event-class filter, email-fallback rules (no duplicates).
- Round-trip: a test subscription receives a push, and the click opens
  `/agents/<id>`. Run on Chromium and on an installed iOS PWA before launch.
- i18n keys present in en, ar, hi.
- `.example` twins for every new env var.

## Risks

- iOS requires the Home Screen install. Expect low opt-in until users install.
- Delivery is not guaranteed. The web chat must remain the source of truth.
- Notification text must not contain secrets or full message bodies by default.

## Open decisions (recorded 2026-10-24, owner agreed)

1. Notification-only; replies happen in web chat. (Agreed.)
2. Web-chat typing is a later slice, via SSE. (Agreed.)
3. Notify only on configured event classes. (Agreed.)
4. Email fallback only without push, never a duplicate. (Agreed.)
5. Agent-initiated notifications are allowed on push and email. Chat replies stay
   reply-only. Amends the scope boundary in [000-README](./000-README.md). (Agreed.)
