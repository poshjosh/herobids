# Bug Report: Telegram Bot Secret Token Leaked in API Access Logs

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-07-17
- **Discovered By:** Scanner-gated hardening staging evaluation — agent behaviour analysis.
- **Summary:** The `x-telegram-bot-api-secret-token` request header is logged in plaintext in the API container's access logs. Any entity with access to the API container logs (Docker logs, log aggregation, log files) can extract the Telegram bot webhook secret, enabling impersonation of the bot — sending messages to users, reading chat history, and issuing slash commands.

## Environment

- **Deployment:** Staging Hetzner server (`128.140.55.192`)
- **Service:** `herobids-api-1` container
- **Log destination:** Docker stdout/stderr (accessible via `docker logs` and any log aggregation pipeline)

## Observed Behavior

Searching the API container logs for `x-telegram-bot-api-secret-token` returns 11 occurrences of the full secret token in plaintext:

```
grep "x-telegram-bot-api-secret-token" logs/api-full.log
```

Example log line (placeholder shown here; the live staging token was present in the actual logs):

```json
{
  "headers": {
    "host": "staging.openaidom.com",
    "content-type": "application/json",
    "x-telegram-bot-api-secret-token": "[staging-telegram-webhook-secret]"
  }
}
```

The token is visible in every access log entry for `POST /api/telegram/webhook` requests.

## Root Cause

### 1. Pino `redact` only covers `Authorization` header

**File:** `apps/api/src/logger.ts`, line 48:

```typescript
const base = { name: 'herobids-api', redact: ['req.headers.authorization'] };
```

Only the `authorization` header is in the redact list. The `x-telegram-bot-api-secret-token` header is not included.

### 2. Custom request serializer passes all headers through unfiltered

**File:** `apps/api/src/index.ts`, line ~104 in `redactReqSerializer`:

```typescript
headers: req['headers'],
```

The custom request serializer logs every request header without any filtering or redaction. While `Authorization` is caught by Pino's `redact` at the logger level, any other sensitive header passes through untouched.

## Impact

- **Confidentiality breach:** The Telegram webhook secret is a bearer token — anyone who possesses it can call the Telegram Bot API as the bot.
- **Scope of compromise:** Send arbitrary messages to users who have interacted with the bot, read group chat history where the bot is a member, and invoke bot commands.
- **Persistence:** Docker logs are typically retained and may be forwarded to log aggregation services (CloudWatch, Loki, etc.), making the leaked token available long after the log entry was written.

## Fix

### 1. `apps/api/src/logger.ts` — Add Telegram header to Pino redact list

Changed the `redact` array from:
```typescript
redact: ['req.headers.authorization']
```

To:
```typescript
redact: [
  'req.headers.authorization',
  'req.headers["x-telegram-bot-api-secret-token"]',
]
```

Bracket notation is required because Pino's `redact` uses `lodash.get`-style paths, and hyphens in header names are not valid JavaScript identifiers for dot notation.

### 2. `apps/api/src/index.ts` — Add `redactSensitiveHeaders` helper and apply in serializer

Added a `SENSITIVE_HEADERS` allowlist and `redactSensitiveHeaders()` function near `redactQueryToken`. The custom request serializer now calls `redactSensitiveHeaders(req['headers'])` instead of passing `req['headers']` directly. This provides defense-in-depth — even if the Pino redact list is incomplete, the serializer itself strips sensitive headers before they reach the logger.

Sensitive headers redacted:
- `authorization`
- `x-telegram-bot-api-secret-token`
- `cookie`
- `x-api-key`

### 3. `apps/api/src/routes/request-log-redaction.test.ts` — Added test coverage

- Added test case `'redacts x-telegram-bot-api-secret-token header'`
- Updated `makeRedactingLogger()` helper's `redact` array to include the new header path
- Verified both the Pino-level redact and the serializer-level redact work

## Files Changed

- `apps/api/src/logger.ts`
- `apps/api/src/index.ts`
- `apps/api/src/routes/request-log-redaction.test.ts`

## Verification

1. **Unit tests:** Run `pnpm --filter @herobids/api test -- request-log-redaction` — all tests pass including the new Telegram header test.
2. **Manual verification:** Deploy to staging, send a webhook request, and confirm `x-telegram-bot-api-secret-token` appears as `[Redacted]` in the logs.
3. **Full test suite:** `pnpm lint` must pass.

## Post-Fix Remediation

- **Operator note:** Rotate the staging secret and re-register the webhook with Telegram's `setWebhook` API.
- **Audit other headers:** Review all custom headers in the codebase (`grep -r "x-" apps/api/src/`) for other potential leaks. Consider adding a general mechanism where headers matching a sensitive pattern are automatically redacted.
- **Log retention cleanup:** If possible, purge or truncate existing API logs on the staging server that contain the exposed token.
