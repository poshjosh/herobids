# Config, Secrets & Onboarding

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)
**Normative inputs:** [configuration best practices](../../../best-practices/configuration.md)
**Source ADRs:**
[ADR 09/014 Capability-Agnostic Frontend Presentation](../../../tech/architecture/adrs/2026/09/014-capability-agnostic-frontend-presentation.md) (generic surfaces + capability-scoped detail; i18n keys with English fallback; UI maps semantic emphasis, not raw values)

Two config layers must not mix (operator vs instance). Chat providers follow the
same split trading and email already use.

## Operator config (deploy-time, Zod-validated at startup)

Today Telegram lives under `alerts.telegram.*`. That placement conflates
"alerting" with "chat messaging" and is provider-specific. Target: a
provider-keyed `messaging.chat.*` block, with `alerts` referencing it rather
than owning the transport.

```yaml
messaging:
  chat:
    telegram:
      botToken: ""          # TELEGRAM_BOT_TOKEN
      webhookSecret: ""     # TELEGRAM_WEBHOOK_SECRET
      webhookUrl: ""        # TELEGRAM_WEBHOOK_URL (optional)
    whatsapp:
      phoneNumberId: ""     # WHATSAPP_PHONE_NUMBER_ID
      wabaId: ""            # WHATSAPP_WABA_ID
      accessToken: ""       # WHATSAPP_ACCESS_TOKEN (secret)
      webhookVerifyToken: ""# WHATSAPP_WEBHOOK_VERIFY_TOKEN
      appSecret: ""         # WHATSAPP_APP_SECRET (for X-Hub-Signature-256)
    sms:
      provider: "twilio"
      accountSid: ""        # SMS_TWILIO_ACCOUNT_SID
      authToken: ""         # SMS_TWILIO_AUTH_TOKEN (secret, also validates webhook)
      fromNumber: ""        # SMS_FROM_NUMBER (E.164, the brokered A2P number)
```

Rules:
- Each provider block is **optional**; an absent/blank block means that provider
  is not configured → its registry lifecycle stays effectively non-ready even if
  marked `available`. Readiness (010) gates dispatch, not just lifecycle.
- **Every new env var gets a `.example` twin in the same change** (AGENTS.md):
  add `WHATSAPP_*`, `SMS_*` keys to `.env.example` with blank/placeholder values
  and a one-line `#` comment each. No real secrets.
- Migration: keep reading `alerts.telegram.*` as a deprecated alias for one
  release (dual-read), mapping it onto `messaging.chat.telegram.*`, to avoid an
  ops break. Document the rename.

## Instance config (runtime, per agent/user — Postgres)

Per the capability model, "which provider an agent uses and to what address" is
**instance data**, not operator config:
- the bound chat addresses live in `chat_addresses` (040), not YAML;
- per-agent provider preference / message-class routing (e.g. "safety alerts →
  all bound chat providers, routine → inbox only") is agent config, validated at
  API write time, same as risk limits.

This matches 012/README: operator config = transport credentials + endpoints;
instance config = who/where/preferences.

## Onboarding & consent (the "configure like email" UX)

Today onboarding is "paste your Telegram chat id" (`settings.telegram.*` in the
web app). Generalise to a per-provider binding flow:

| Provider | How the user binds an address | Consent event |
| --- | --- | --- |
| Telegram | message the bot, bot replies with chat id, user pastes it (today) — or auto-capture on first inbound | messaging the bot |
| WhatsApp | user sends a message to the business number (optionally via a `wa.me` deep link / QR) → address auto-captured + marked verified | the inbound message (Meta opt-in) |
| SMS | user texts the business number (or confirms a verification code) → E.164 captured | the inbound text; STOP revokes |

Design principles:
1. **Auto-capture over paste.** The reply-only model means the user *always*
   messages first, so the inbound message is both the binding event and the
   consent event. Prefer capturing `chat_addresses` from the first inbound
   message (status `pending_optin` → `active` on confirmation) over manual entry.
2. **Record consent durably** in `chat_addresses.consent_source` /
   `verified_at` — required for SMS TCPA audit (030) and WhatsApp opt-in policy.
3. **Honour revocation.** SMS STOP (and WhatsApp block) set status `revoked`;
   the delivery layer must refuse revoked addresses.

## Surfaces that must stay consistent (006 §Deliverables)

Provider lifecycle support, platform health, and tenant/agent readiness must be
**distinguishable** in API and UI (006 acceptance criteria 4):
- lifecycle: is this provider `planned` or `available`? (registry/020)
- platform health: is the provider configured + its webhook/credentials healthy?
  (operator config above)
- tenant/agent readiness: does this agent have a bound, non-revoked address?
  (`chat_addresses`)

The existing i18n keys (`settings.telegram.*`, `agents.create.telegramChatId`,
message-delivery labels, `agents.approvals.telegramHint`) must generalise to
per-provider keys rather than hardcode Telegram. This touches
`apps/web` locales in every supported language — budget for it (080-i18n-style
work), it is not just backend. Per
[ADR 09/014](../../../tech/architecture/adrs/2026/09/014-capability-agnostic-frontend-presentation.md),
the generic agent surfaces should show provider-agnostic readiness and reach
provider detail through capability→provider; labels carry stable i18n keys with
an English fallback, and the frontend maps semantic emphasis (e.g. a `revoked`
address as `warning`) rather than hardcoding provider-specific styling.

## Checklist for adding a provider (config side)

1. Add the provider block to `messaging.chat.*` schema + `config/default.yaml`.
2. Add `.env.*` keys **and their `.example` twins** in the same change.
3. Flip the registry row lifecycle `planned → available` (020) only once the
   adapter + webhook + readiness check exist.
4. Add per-provider onboarding UI + i18n keys.
5. Add provider-specific consent/opt-out handling where required (SMS STOP).
