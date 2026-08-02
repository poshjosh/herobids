# Local Telegram Webhook Test Toolkit

## Status

`Implemented`

## Purpose

Enable testing of inbound Telegram messaging on localhost with two explicit levels of confidence:

1. real Telegram delivery through a public HTTPS tunnel
2. fast local ingress tests that exercise webhook auth, payload parsing, command parsing, and async dispatch handoff

## Target End State

Developers can validate local Telegram webhook behavior using either:

1. **Tunnel setup script** — a one-shot helper that establishes a public HTTPS tunnel to local API port 3000, registers `POST /telegram/webhook` with Telegram, and verifies the registration.
2. **Mock webhook script** — a local helper that posts sample Telegram updates to `http://localhost:3000/telegram/webhook` with the correct secret header and clearly distinguishes:
  - ingress accepted by the HTTP handler
  - follow-up evidence required for async routing success

## Problem Statement

Telegram requires a public HTTPS URL via `setWebhook` before it delivers updates. On localhost there is no public HTTPS endpoint, so real Telegram traffic cannot reach `POST /telegram/webhook` unless the developer uses a tunnel.

The repo already has two partial tools:

- `scripts/shell/tests/test-telegram-messaging.sh` validates bot token health, webhook registration, and outbound delivery
- `scripts/test-slash-commands.sh` posts mock webhook payloads to the local endpoint and relies on real Telegram replies for follow-up confirmation

What is missing is a single documented local-testing workflow with clear ownership, stable script locations, and acceptance criteria that match the actual webhook contract.

## Approach Overview

### Part A: tunnel setup helper

No application code changes are required for the basic tunnel flow. The worker already registers a webhook when `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET` are configured.

The tooling gap is a one-shot helper that:

- starts or reuses a local tunnel to `localhost:3000`
- discovers the public HTTPS URL
- calls Telegram `deleteWebhook` and `setWebhook`
- verifies the resulting registration with `getWebhookInfo`
- prints the exact webhook URL it registered and warns that a later worker restart can overwrite it if local config still points elsewhere

Important boundary: this script is a setup helper, not a long-running watcher. Automatic tunnel restart detection and re-registration are a separate problem and are out of scope for this slice.

### Part B: local mock webhook helper

The repo already has a rough version of this in `scripts/test-slash-commands.sh`. This slice should formalize that capability rather than pretending it does not exist.

The mock helper should exercise the local webhook ingress path:

- secret-header validation
- `TelegramWebhookUpdateSchema.safeParse`
- message extraction and command parsing
- async handoff into `processWebhookUpdate`

It must also document the contract correctly:

- `200 {"ok": true}` means the handler accepted or intentionally ignored the webhook payload
- it does **not** prove async routing completed successfully
- routed cases need a second observable such as a Telegram acknowledgement message, API log line, or downstream state change

This complements tunnel testing because:

- mock mode is fast and good for ingress-path iteration
- tunnel mode validates real Telegram transport, webhook registration, and real payload delivery

## Implementation Tasks

### Task 1: `scripts/shell/tests/setup-local-telegram-webhook.sh` (tunnel setup) — `DONE`

**File:** `scripts/shell/tests/setup-local-telegram-webhook.sh`
**Pattern:** Follow the style of `test-telegram-messaging.sh` for env loading, output formatting, and exit codes.

**Scope:** one-shot setup and verification only.

**What it does:**
1. Loads env vars from `--env-file`.
2. Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
3. Starts or reuses an `ngrok` tunnel to `localhost:3000`.
4. Reads the public URL from ngrok's local status API.
5. Calls `DELETE https://api.telegram.org/bot<token>/deleteWebhook`.
6. Calls `POST https://api.telegram.org/bot<token>/setWebhook` with `{ url: <public-url>/telegram/webhook, secret_token }`.
7. Verifies registration via `getWebhookInfo` and confirms the exact URL matches.
8. Prints a warning if `TELEGRAM_WEBHOOK_URL` in local config does not match the registered tunnel URL, because the next worker restart may overwrite the registration.
9. Prints the next manual step: send a Telegram message to the bot.
10. Exits 0 on success, 1 on failure, 2 on missing prerequisites.

**Key details:**
- Primary implementation target is `ngrok` only. `cloudflared` support is a follow-up, not part of the first slice.
- Mask the bot token in all output.
- Add `--stop` only if the script itself started the tunnel and can stop the exact child process reliably.

**Dependencies:** `curl`, `jq`, `ngrok`

### Task 2: formalize the existing mock helper — `DONE`

**File strategy:** prefer evolving `scripts/test-slash-commands.sh` into the supported local mock entrypoint, or move it under `scripts/shell/tests/` while preserving its current coverage.

The plan should not create a second overlapping mock script unless the existing one cannot be adapted cleanly.

**What it does:**
1. Loads env vars from `--env-file` or flags such as `--webhook-secret`, `--chat-id`, and `--message-text`.
2. Uses a sample payload compatible with `TelegramWebhookUpdateSchema`.
3. POSTs to `${API_BASE_URL:-http://localhost:3000}/telegram/webhook` with:
  - `Content-Type: application/json`
  - `X-Telegram-Bot-Api-Secret-Token: <webhook-secret>`
4. Reports HTTP status code, response body, and correct interpretation:
  - 200 `{ "ok": true }` — webhook accepted or intentionally ignored; async work may still fail later
  - 401 `unauthorized` — webhook secret mismatch
  - 501 `not_configured` — bot token or webhook secret missing from app config
5. Prints what secondary evidence to check next for routed cases:
  - Telegram acknowledgement message
  - API logs for async-processing warnings
  - downstream state change if a targeted command should mutate state

**Sample payload to embed:**
```json
{
  "update_id": 999999,
  "message": {
    "message_id": 1,
    "from": {
      "id": 123456789,
      "is_bot": false,
      "first_name": "TestUser",
      "username": "testuser",
      "type": "private"
    },
    "chat": {
      "id": 123456789,
      "first_name": "TestUser",
      "username": "testuser",
      "type": "private"
    },
    "date": <current_unix_timestamp>,
    "text": "/to MyAgent check BTC price"
  }
}
```

**Flags:**
- `--message-text TEXT` — message content (default: `/to MyAgent check BTC price`)
- `--chat-id ID` — override chat ID (default: from env or hardcoded test value)
- `--wrong-secret` — optional negative-path check for 401

Do not add Telegram `entities` support to the script unless the application starts depending on them. Current slash-command parsing is text-based.

### Task 3: local testing reference doc — `DONE`

**File:** add `docs/tech/telegram-local-testing.md`

Document the two testing levels, prerequisites, caveats, and usage examples:

```bash
# One-shot tunnel registration against local API
scripts/shell/tests/setup-local-telegram-webhook.sh --env-file .env.ops.dev

# Fast local ingress test
scripts/test-slash-commands.sh \
  --message-text "Hello from mock" \
  --chat-id 123456789
```

The doc must state explicitly that mock mode can still trigger real outbound Telegram API sends when the message is routable to a bound chat.

## Existing Code to Verify / Use

- **Webhook handler:** `apps/api/src/routes/agent-interactivity.ts:1174` — `POST /telegram/webhook`
- **Secret validation:** `x-telegram-bot-api-secret-token` header vs webhook secret
- **Payload schema:** `TelegramWebhookUpdateSchema` at line 64 — defines exact payload shape for the mock
- **Existing test script:** `scripts/shell/tests/test-telegram-messaging.sh` — reference for style, patterns, exit codes
- **Existing local mock script:** `scripts/test-slash-commands.sh` — current ingress driver to extend or relocate
- **Worker webhook registration:** `apps/worker/src/index.ts:867` — `setWebhook` call and the source of config-overwrite risk on restart
- **Current async contract:** `POST /telegram/webhook` acknowledges immediately and processes routing asynchronously

## Out of Scope

1. Long polling fallback code path — not adding it to the application codebase; only testing tooling changes
2. Modifying the worker's Telegram client or webhook registration logic
3. Document handling / photo / video payloads — text and `/to` commands are sufficient for local validation
4. Multi-user routing validation — that's already covered by `agent-interactivity.test.ts`
5. Automatic tunnel URL rotation monitoring and re-registration after the setup script exits
6. Fully offline end-to-end success for routed messages — successful local ingress can still produce real outbound Telegram API calls

## Outstanding Issues

### [Task 1] Tunnel setup script
- **M1:** `$0` in help text resolves to invocation path, not canonical path (use `${BASH_SOURCE[0]}`)
- **M2:** No minimum-length verification for `TELEGRAM_WEBHOOK_SECRET` (should require ≥8 chars)
- **M3:** Step counters are inaccurate (Step N/5) — cosmetic
- **M4:** `--stop` exits 0 when nothing to stop — could use distinct code or better message
- **L1:** Comment header style nit (minor inconsistency with reference script)
- **L2:** ngrok logs redirected to `/dev/null` — should use temp file for debugging
- **L3:** `--help` flag parsing duplicates `sed` pattern (acceptable, pre-existing pattern)
- **L-new:** `NGROK_STARTED_BY_US` initialized after trap registration (unset-variable window)

### [Task 2] Mock webhook helper
- **M1:** Positional CHAT_ID silently lost when env file sets CHAT_ID via `--env-file`
- **M2:** CHAT_ID_ENV env var name is non-standard and redundant
- **M3:** Payload inconsistency between single-message and batch modes (batch missing `from` field)
- **L1:** Batch mode still uses string-interpolated JSON instead of jq
- **L2:** `--env-file` double-parsed (preview pass + main loop) — confusing control flow
- **L3:** `date +%s` inside `--argjson` without error guard
- **L4:** jq dependency check only in single-message mode, not top-level
- **L5:** `$0` used in `--help` sed command instead of `${BASH_SOURCE[0]}`
- **L6:** Style inconsistency: `[[ ]]` vs `[ ]` between modes
- **L7:** Comment header references CHAT_ID but resolution uses CHAT_ID_ENV

### [Task 3] Local testing reference doc
- **M1:** Secret env var naming inconsistency (TELEGRAM_WEBHOOK_SECRET vs WEBHOOK_SECRET)
- **M2:** Troubleshooting for worker overwrite is incomplete (missing "set to match" option)
- **M3:** Prerequisites "user linked to DB" is imprecise (should mention `user_chats` table)
- **L1:** Tunnel Verification vs Webhook Contract checklist redundancy
- **L2:** `--help` flag not documented for either script
- **L3:** No mention of batch mode `from` field omission
