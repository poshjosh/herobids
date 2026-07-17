# Bug Report: Setup-Link Callback Premature Token Consumption ("Link Expired")

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-17
- **Discovered By:** User report — `/connect thyper` slash command flow.
- **Summary:** The setup-link callback `GET /auth/setup-link/callback?token=xxx` consumes the one-time Redis token via `GETDEL` on the very first request. Telegram slash-command replies do not disable link previews, so Telegram (or another client) can prefetch the URL before the user clicks it. The user then sees `auth.setup_link_callback.invalid_token` with message "This link has expired" because the token was already consumed by the preview fetch.

## Environment

- **Deployment:** Staging
- **Trigger:** `/connect <agent>` (no connection-id form) in Telegram → user clicks received link

## Observed Behavior

1. User runs `/connect thyper` in Telegram.
2. Bot replies with a setup link containing a one-time token.
3. User clicks the link in Telegram.
4. Browser shows `auth.setup_link_callback.invalid_token` with message "This link has expired".

The link should work; the token has a 30-minute TTL and the user clicked immediately.

## Root Cause

Two contributing factors:

### A. Telegram link previews are not disabled for slash-command replies

`sendTelegramText` in `apps/api/src/routes/agent-interactivity.ts` sends messages without `disable_web_page_preview: true`:

```ts
async function sendTelegramText(chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,                          // ← no disable_web_page_preview
    }),
  }).catch(() => undefined);
}
```

The dedicated Telegram alert client in `apps/worker/src/alerting/telegram-client.ts` correctly sets `disable_web_page_preview: true` (line 46), but the webhook handler's `sendTelegramText` does not. Telegram generates link previews by fetching the target URL, which triggers a `GET` to `/auth/setup-link/callback?token=xxx` before the user clicks.

### B. The callback burns the token on any GET (no idempotency)

`consumeSetupLinkToken` in `apps/api/src/services/setup-link-token-service.ts` uses `redis.getdel`:

```ts
const raw = await redis.getdel(`auth:setup-link:token:${token}`);
```

This deletes the key atomically on read. Any first GET — whether from a link preview, browser prefetch, or accidental double-click — consumes the token. The second request (the user's actual click) finds nothing and returns the "expired" error.

### Architectural note

The existing login-link callback (`GET /auth/login-link/callback`) has the same `getdel` pattern but is less susceptible because login links are delivered via email, not messaging apps that generate previews.

## Fix

### Fix A: Disable link previews for slash-command replies

Add `link_preview_options: { is_disabled: true }` (Telegram Bot API v7.0+) to `sendTelegramText` in `apps/api/src/routes/agent-interactivity.ts`.

### Fix B: Make token consumption resilient to accidental GETs

Change `consumeSetupLinkToken` from `getdel` to `get`, and delete the token explicitly only after the session is successfully issued. This way:
- A link preview or accidental GET reads the token but does not delete it.
- The real user click still works — it reads the same token, gets a session issued, and then the token is deleted.
- Parallel requests issue duplicate sessions for the same user, which is harmless (both are valid).

## Files Changed

- `apps/api/src/routes/agent-interactivity.ts` — `sendTelegramText`: add `link_preview_options: { is_disabled: true }`
- `apps/api/src/services/setup-link-token-service.ts` — `consumeSetupLinkToken`: replace `getdel` with `get` + explicit `del` in callback
- `apps/api/src/routes/auth.ts` — `GET /auth/setup-link/callback`: delete token after session issuance

## Verification

- [x] `pnpm lint` (type-check) passes cleanly
- [x] `telegram-command-handlers.test.ts` — all 14 tests pass
- [ ] `/connect <agent>` in Telegram: link preview should not appear on the sent message — verify in staging
- [ ] Opening the setup link in a browser works correctly — verify in staging
- [ ] Opening the same setup link a second time returns "link expired" (token deleted after first successful session) — verify in staging
- [ ] Browser prefetch / Telegram preview no longer breaks the link — verify in staging
