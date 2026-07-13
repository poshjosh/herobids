# Platform Email Redesign for OpenAIdom

**Status:** Ready for implementation  
**Created:** 2026-07-11

## Goal

Improve the look, consistency, and clarity of platform-authored emails while preserving current delivery behavior and keeping agent-authored email fanout out of scope.

This plan covers:

1. auth login-link email
2. worker billing soft-cap and hard-cap emails
3. platform safety alerts, which are currently Telegram-only and need an email path

This plan does **not** cover agent-authored `send_message` emails.

---

## Summary

HeroBids currently sends plain-text platform email from separate surfaces with no shared visual system:

1. auth sends the login-link email from [apps/api/src/auth-mailer.ts](../../../../apps/api/src/auth-mailer.ts)
2. worker sends billing emails through the shared SES client in [apps/worker/src/alerting/ses-email-client.ts](../../../../apps/worker/src/alerting/ses-email-client.ts)
3. platform safety alerts in [apps/worker/src/alerting/platform-alert-service.ts](../../../../apps/worker/src/alerting/platform-alert-service.ts) are Telegram-only today

The desired outcome is a single branded email system for platform-authored mail:

1. shared HTML shell with plain-text fallback
2. consistent subject/body/CTA structure across auth and worker
3. templates that are usable without requiring a finished logo asset on day one
4. no behavior change to agent-authored email fanout

The visual direction should take inspiration from Lipdubber's email shell: dark outer background, centered card, strong heading hierarchy, obvious CTA, muted footer, and reliable plain-text fallback.

This rollout should assume:

1. customer-facing email branding uses `OpenAIdom`
2. staging links and callbacks use `https://staging.openaidom.com`
3. first-launch production links and callbacks use `https://openaidom.com`
4. `https://www.openaidom.com` and `https://app.openaidom.com` are supported aliases, but email should point users at the canonical host unless a specific flow requires otherwise
5. old `herobids.com` links should be removed instead of preserved in parallel

---

## Current Baseline

### Auth

1. `POST /auth/send-login-link` sends through `authMailer.sendLoginLink(...)` in [apps/api/src/routes/auth.ts](../../../../apps/api/src/routes/auth.ts).
2. The auth mailer only builds a text body today in [apps/api/src/auth-mailer.ts](../../../../apps/api/src/auth-mailer.ts).
3. If email is disabled, the route logs the sign-in link instead of sending mail.

### Worker

1. Billing notifications are dispatched from `handleBillingNotification(...)` in [apps/worker/src/agents/agent-message-broker.ts](../../../../apps/worker/src/agents/agent-message-broker.ts).
2. The worker email contract currently supports `to`, `subject`, and `text` only in [apps/worker/src/alerting/email-client.ts](../../../../apps/worker/src/alerting/email-client.ts).
3. The SES adapter serializes only `Text` content in [apps/worker/src/alerting/ses-email-client.ts](../../../../apps/worker/src/alerting/ses-email-client.ts).
4. Platform safety alerts are mandatory and platform-authored, but they are delivered only by Telegram in [apps/worker/src/alerting/platform-alert-service.ts](../../../../apps/worker/src/alerting/platform-alert-service.ts).

### UX Problems

1. platform emails look inconsistent because they are composed independently
2. auth and worker emails have no shared visual identity
3. billing and safety alerts do not have a strong visual distinction from generic text mail
4. platform safety alerts lack an email channel entirely
5. there is no shared place to evolve branding, spacing, CTA styling, or fallback copy

---

## Desired Outcome

After this feature:

1. every platform-authored email uses a shared visual shell and plain-text fallback
2. auth login-link email looks intentional and trustworthy rather than like a raw system message
3. billing emails clearly differentiate soft-cap warning vs hard-cap stop states
4. platform safety alerts can be delivered by email in addition to Telegram
5. the implementation can launch without a finished logo asset by falling back to a typographic OpenAIdom header
6. agent-authored emails remain unchanged and out of scope for this feature

---

## Scope

In scope:

1. shared HTML email rendering for platform-authored emails
2. auth login-link email redesign
3. worker billing email redesign
4. worker support for HTML email bodies
5. adding email delivery for platform safety alerts
6. tests for renderer output, API mail payloads, worker mail payloads, and safety-alert delivery behavior

Out of scope:

1. agent-authored `send_message` email fanout
2. arbitrary recipients, CC, or BCC
3. provider migration away from SES
4. localization expansion beyond current English copy in this slice
5. a full notification-preferences redesign
6. a final production brand/logo project beyond what is needed to ship a clean email header

---

## Product Decisions and Implementation Defaults

### Decisions encoded by this plan

1. platform-authored email should feel like one system, even when triggered from different apps
2. every HTML email must also ship a plain-text fallback
3. shared rendering logic should be centralized so API and worker do not drift visually
4. platform safety alert email should be authored by the platform, not by agents
5. agent-authored email fanout must remain excluded from this redesign

### Implementation defaults confirmed before implementation starts

1. Platform safety alert emails should be mandatory like current Telegram safety alerts.
2. The first version may use a typographic `OpenAIdom` header if no approved email asset is ready.
3. The initial slice may remain English-only, with renderer structure designed so localization can be layered in later.

---

## Design Direction

Use Lipdubber's structure as reference, not as a literal copy.

Recommended shell:

1. dark or tinted outer canvas to frame the message
2. centered white or light card for primary content
3. compact brand header or wordmark area
4. eyebrow or label for context when useful
5. strong headline
6. short explanatory body copy
7. clear CTA button when the message has an action
8. muted footer and raw-link fallback section

Recommended brand behavior:

1. if an approved image asset exists, use it in the header
2. otherwise render a clean text-based `OpenAIdom` header with stable spacing and typography
3. do not block the redesign on a separate logo-design task

Recommended technical contract:

1. templates return `subject`, `text`, and `html`
2. API and worker both consume that same shape
3. HTML generation remains pure string rendering with escaped dynamic values
4. transport adapters stay provider-neutral and only map the rendered payload into SES
5. renderer inputs that include URLs should use the canonical OpenAIdom hostname for the target environment

---

## Likely Repo Surfaces

| Area | Likely files |
|---|---|
| Auth email send path | `apps/api/src/auth-mailer.ts`, `apps/api/src/auth-mailer.test.ts`, `apps/api/src/routes/auth.ts` |
| Worker email contract | `apps/worker/src/alerting/email-client.ts`, `apps/worker/src/alerting/ses-email-client.ts`, `apps/worker/src/alerting/ses-email-client.test.ts` |
| Worker senders | `apps/worker/src/agents/agent-message-broker.ts`, `apps/worker/src/alerting/platform-alert-service.ts`, worker tests |
| Shared rendering layer | new shared pure renderer module in a cross-app location |
| Optional assets | web/public or another stable public asset location if a logo image is introduced |

The exact shared-module location should be chosen to maximize reuse without introducing cross-app runtime coupling.

---

## Implementation Plan

### Slice 1 — Shared renderer contract and branded shell

Goal: establish one reusable rendering system for platform-authored email.

Tasks:

1. introduce a shared pure renderer contract that returns `subject`, `text`, and `html`
2. create a common HTML shell for platform-authored mail
3. add safe escaping helpers for dynamic content
4. support a non-blocking brand header fallback when no logo asset is available
5. add snapshot-style or string-assertion tests for shell structure and fallback behavior

Expected result:

Auth and worker can both render emails through the same presentation system instead of composing unrelated raw strings.

### Slice 2 — Auth login-link redesign

Goal: replace the plain-text auth email with the shared branded template.

Tasks:

1. refactor [apps/api/src/auth-mailer.ts](../../../../apps/api/src/auth-mailer.ts) to build subject, text, and html from the shared renderer
2. preserve current TTL, link, sender, reply-to, timeout, and error-handling behavior
3. include an obvious sign-in CTA and raw-link fallback copy
4. update auth mailer tests to assert both text and HTML payload structure
5. keep the current dev-mode logged-link behavior unchanged in [apps/api/src/routes/auth.ts](../../../../apps/api/src/routes/auth.ts)

Expected result:

Login-link emails look trustworthy and consistent without changing auth routing or operational behavior.

### Slice 3 — Worker email contract and billing template redesign

Goal: make the worker capable of sending HTML email and redesign billing notifications.

Tasks:

1. extend the worker email contract in [apps/worker/src/alerting/email-client.ts](../../../../apps/worker/src/alerting/email-client.ts) to carry optional or required HTML content alongside text
2. update the SES adapter in [apps/worker/src/alerting/ses-email-client.ts](../../../../apps/worker/src/alerting/ses-email-client.ts) to send both `Text` and `Html`
3. redesign the billing soft-cap email as a warning-state template
4. redesign the billing hard-cap email as a stop-state template with explicit unmanaged-open-positions copy when relevant
5. update worker tests to assert the new message shape and SES payload mapping

Expected result:

Worker-originated platform mail can render branded HTML, and billing notifications become clearer and more actionable.

### Slice 4 — Platform safety alert email delivery

Goal: add an email path for mandatory platform safety alerts.

Tasks:

1. extend [apps/worker/src/alerting/platform-alert-service.ts](../../../../apps/worker/src/alerting/platform-alert-service.ts) to accept the shared email client in addition to Telegram
2. define safety-alert email subjects and body variants for:
   - runtime unhealthy
   - runtime failed
   - paused by guardrail
   - critical execution failure
3. route platform-authored safety alerts to the owning user's verified account email when email infrastructure exists
4. preserve existing Telegram delivery and persistence semantics
5. decide and document whether alert email failure should affect message status independently from Telegram success
6. add tests for email send, no-recipient skip, and partial-channel success cases

Expected result:

Mandatory safety alerts are no longer limited to Telegram and have a platform-branded email fallback/companion channel.

### Slice 5 — Asset, polish, and rollout verification

Goal: close the presentation gaps and confirm behavior end to end.

Tasks:

1. if a logo or wordmark asset is approved, wire it into the shared shell
2. otherwise confirm the typographic header is shippable and stable across clients
3. validate basic rendering in common clients using generated HTML previews or real test sends
4. verify spacing, CTA visibility, and raw-link fallback behavior on desktop and mobile mail clients
5. document the new platform email surfaces and known limitations

Expected result:

The redesign is ready to ship with acceptable branding quality even if final asset work lands later.

---

## Validation Plan

### Automated

1. auth mailer tests verify both text and HTML content shape
2. worker SES adapter tests verify HTML and text are both mapped into the provider payload
3. worker billing-notification tests verify subject/body variants and open-position messaging
4. platform-alert tests verify email send behavior, skip behavior, and coexistence with Telegram delivery
5. renderer tests verify escaping and shell structure for each platform-authored email type

### Manual

1. send a login link in a non-dev environment and verify CTA, fallback link, expiry copy, and sender formatting
2. trigger a billing soft-cap notification and verify warning-state presentation
3. trigger a billing hard-cap notification with and without open positions and verify copy differences
4. trigger each platform safety alert type and verify both Telegram and email behavior
5. inspect the same messages in at least one mobile mail client and one desktop/webmail client

---

## Risks and Mitigations

1. **Cross-app template drift.** Mitigate by centralizing rendering rather than maintaining separate API and worker template copies.
2. **Email-client rendering quirks.** Mitigate by using table-based HTML, inline styles, and conservative layout patterns.
3. **Brand asset delay.** Mitigate by shipping with a typographic header and treating image-logo support as optional polish.
4. **Channel-status ambiguity for safety alerts.** Mitigate by explicitly testing and documenting what happens when Telegram succeeds and email fails, or vice versa.
5. **Scope creep into agent email UX.** Mitigate by keeping agent-authored email fanout explicitly out of scope in code review and release notes.

---

## Rollout Notes

1. This feature should be implemented without changing user-facing notification preferences for agent-authored email.
2. Release notes should call out that platform safety alerts gain an email path if email infrastructure is configured.
3. If auth locale support is deferred, note that only visual quality improved in this slice; localization remains a follow-up.
4. Email links and user-visible domain references should align with `docs/features/2026/07/12/001-openaidom-domain-rollout/001-plan.md` and must not retain `herobids.com` hostnames.

---

## Outstanding Issues

1. **Channel-status ambiguity for safety alerts (Slice 4 task 5).** The code implements independent channels (Telegram and email don't block each other; `anyDelivered` tracks partial success). Tests cover dual-channel, Telegram-fails/email-succeeds, and email-fails/Telegram-succeeds cases. This decision should be documented in a standalone note explaining that alert delivery status is per-channel, not transactional across channels.

2. **Email client rendering validation (Slice 5 tasks 3–4).** Automated HTML structure tests pass in CI (DOCTYPE, table layout, brand colors, CTA markup, raw-link fallback, OpenAIdom header). Manual rendering QA in actual email clients (desktop + mobile) should happen in staging before production rollout. Litmus or real test sends recommended.

3. **Platform email surface documentation (Slice 5 task 5).** No standalone surface doc exists. This plan and the CHANGELOG entry serve as the canonical reference for now.

4. **Manual validation checklist** (5 items from the Validation Plan above). All require a running non-dev environment:
   - Send a login link and verify CTA, fallback link, expiry copy, sender formatting
   - Trigger billing soft-cap and verify warning-state presentation
   - Trigger billing hard-cap with/without open positions and verify copy differences
   - Trigger each platform safety alert type and verify both Telegram + email
   - Inspect messages in at least one mobile and one desktop/webmail client

Items 1–3 are documentation/verification tasks. Item 4 requires staging access.

---

## Resolved

- **Brand asset delay (Risk 3).** Moot — `wordmark-dark.png` is wired via `alerts.email.brandImageUrl` config across all environments. The typographic header remains as fallback when the config is unset.
- **Non-blocking assumption (logo).** Moot — same as above.