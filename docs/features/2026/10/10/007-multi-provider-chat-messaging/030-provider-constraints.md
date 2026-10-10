# Provider Constraints (fact-based)

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)

Per-provider facts that shape the adapters and the data model. Everything here
is sourced; items the team must still confirm are called out explicitly. These
constraints are *why* the reply-only model (README fact 3) matters: it keeps the
core path inside each provider's free-form window and avoids the expensive
machinery.

## Cross-cutting: the reply-only insight

The product requirement is "**if the user initiates, the agent may reply.**"
That single constraint keeps the agent's outbound message inside the provider's
free-form session window for both WhatsApp and SMS, which is where the hard,
expensive rules (templates, marketing consent) do **not** apply. Agent- or
platform-*initiated* contact after the window closes is deliberately pushed to
email (README non-goal 2).

## Telegram (baseline — already shipped)

- Free-form text any time; no session window; free.
- Rich HTML formatting; `force_reply` gives native reply threading used today
  for inbound reply→agent correlation.
- Inbound via webhook with `x-telegram-bot-api-secret-token` header validation.
- No special registration beyond a bot token.

This is the easy baseline the abstraction must not regress.

## WhatsApp (WhatsApp Business Platform / Cloud API)

Sources: [Twilio key concepts](https://www.twilio.com/docs/whatsapp/key-concepts),
[Meta conversation types](https://developers.facebook.com/docs/whatsapp/conversation-types),
[Meta send-webhooks setup](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks),
[Meta get-started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started),
[authgear pricing](https://authgear.com/post/whatsapp-api-pricing),
[SuprSend templates](https://www.suprsend.com/post/whatsapp-business-api-templates).
Content rephrased for compliance with licensing restrictions.

- **Cloud API is the only supported path**; the On-Premise API is deprecated.
  Direct-with-Meta integration is possible (no BSP strictly required), or via a
  BSP such as Twilio.
- **24-hour customer service window**: when the user messages the business, a
  24-hour window opens during which the business may send **free-form** replies
  with no template. The window resets on each new inbound user message. For a
  reply-only agent that answers promptly, **this covers the entire use case and
  templates are never touched.**
- **Templates** (pre-approved by Meta) are required **only** for
  business-initiated messages outside the window — explicitly out of scope here.
- **Pricing**: in-window service messages are currently free; billing is
  per-message otherwise. **CONFIRM before launch:** one source
  ([wati](https://www.wati.io/en/blog/whatsapp-api-templates-guide/)) indicates
  Meta may begin charging for service / in-window messages from **Oct 1 2026**
  and add a per-token AI category from **Aug 1 2026** — verify against Meta's own
  pricing page.
- **Setup overhead**: dedicated business phone number (unusable on the normal
  WhatsApp app once registered), a Meta Business app + WhatsApp product, a WABA
  ID and Phone Number ID, generally Meta business verification for production
  volume. Webhook needs a public HTTPS endpoint with a valid (non-self-signed)
  cert and a GET verify-token handshake.
- **Opt-in**: Meta policy requires the user to have given their number and opted
  in; for reply-only, the user messaging first satisfies the practical case, but
  record consent.
- **Identity**: phone number (`wa_id`). No `force_reply` equivalent — reply
  correlation needs a different strategy (see 050).

Adapter implications: `ChatChannel.capabilities = { richText: limited,
nativeReplyThreading: false }`. Must track per-recipient window state to decide
free-form vs. (out-of-scope) template; for this feature, if the window is closed
the agent reply fails soft and falls back to email.

## SMS (via a provider such as Twilio)

Sources: [Twilio messaging pricing](https://www.twilio.com/en-us/pricing/messaging),
[Twilio A2P 10DLC brand](https://www.twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand),
[Twilio A2P quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart),
[Twilio SMS character limit](https://www.twilio.com/docs/glossary/what-sms-character-limit),
[didlogic segments](https://didlogic.com/learn/sms-character-limits-and-concatenation/),
[Voxie TCPA checklist](https://www.voxie.com/blog/tcpa-compliance-checklist-sms/),
[messageIQ SMS laws](https://messageiq.io/blogs/sms-marketing-laws/).
Content rephrased for compliance with licensing restrictions.

- **No templates, no session window** — mechanically the simplest. Outbound is a
  single HTTP POST; inbound is a standard webhook. Closest to the Telegram model.
- **US A2P 10DLC registration is mandatory** for application-to-person SMS to US
  numbers over 10-digit long codes. Carriers filter/block unregistered traffic
  (Twilio has blocked unregistered US 10DLC since Aug 31 2023). Two tiers:
  **Brand** (who you are) + **Campaign** (the ongoing use case). "Campaign" here
  means a **persistent use-case registration, not a time-boxed burst** — it stays
  active as long as you send that traffic. A **conversational / customer-care**
  use case (user texts in, agent replies) is the most registration-friendly
  category.
- **Consent & opt-out are legal obligations** (TCPA / CTIA): prior consent,
  honour STOP and any reasonable opt-out phrasing, respect quiet hours. For
  reply-only the user texting first is the consent event, but STOP handling must
  be automated.
- **~160-char practical limit, per-segment billing**: 160 GSM-7 chars per single
  SMS, **70** if any Unicode/emoji is present; longer text splits into 153- (or
  67-) char segments, each billed. The current Telegram messages (HTML, ~3800
  chars, emoji icons) would fragment and lose formatting — SMS needs a dedicated
  short-form rendering (strip markup, drop/– or transliterate emoji, truncate
  with awareness of segment boundaries).
- **Cost**: Twilio US SMS starts ~\$0.0083 per segment each way, plus carrier
  fees and ~\$1.15+/mo per number. Not free (Telegram is).
- **Identity**: E.164 phone number. No native reply threading.

Adapter implications: `capabilities = { richText: false, maxBodyChars: segment-
aware, nativeReplyThreading: false }`. The renderer must be Unicode-aware for
segment counting. Transport mode is **brokered** — one shared A2P number owned
by the platform (decided in `020`), so there is one brand+campaign registration,
not per-user provisioning.

## Items to confirm before each adapter ships

1. **WhatsApp**: Meta's current pricing for in-window/service messages
   (free vs. charged post-Oct-2026); whether to go direct-with-Meta or via a BSP.
2. **SMS**: whether agent replies could ever be classed as marketing (raises
   consent bar); the A2P 10DLC brand/campaign fees and approval timeline for the
   business entity. (Transport mode is settled: **brokered, one shared A2P
   number** — see `020`.)
3. **Both**: non-US regulatory rules if the user base is international (not
   researched here).

## Why these do not block the abstraction

The abstraction (010 design) is provider-neutral and isolates all of the above
inside adapters and a per-recipient window-state concern. Telegram ships the
port with zero new constraints; WhatsApp and SMS each add their rules **inside
their adapter** without touching callers. The expensive items (templates, A2P
registration, consent/opt-out automation) are operational/compliance work that
runs in parallel with the code and is gated by the `planned → available`
lifecycle flip in the registry (020).
