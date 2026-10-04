# Multi-Provider Chat Messaging

**Status:** draft
**Created:** 2026-10-04
**Owner:** (unassigned)

## One-line

Generalise the hardcoded Telegram integration into a provider-neutral
`messaging / chat` surface so that an agent can reply over Telegram, WhatsApp,
or SMS — configured the same way users configure `trading` or
`messaging / email` capabilities today.

## Why this exists

Today the inbound/outbound chat path is Telegram-specific end to end: a
concrete `TelegramClient`, inline `api.telegram.org` fetches, a single
`POST /telegram/webhook` route, DB columns literally named `telegram_*`, and
config under `alerts.telegram.*`. There is no `chat` provider abstraction. The
capability taxonomy (doc 013 / 009 in `000-capability-foundations`) already
*names* `messaging / chat / {telegram, whatsapp}` and already models the exact
concepts we need (family, provider, lifecycle, transport mode). This feature
closes the gap between that taxonomy and the Telegram-only implementation.

## Scope boundary (read before implementing)

- `messaging` **stays a native platform capability**. This is a fixed,
  non-provisional decision (013 §Fixed Decisions 5, 006 §Fixed Decisions 1).
  This feature does **not** turn chat into an external backend and does **not**
  move chat under `externals/`.
- This feature adds **chat providers** inside the existing native messaging
  capability. It reuses the native-activation + visibility model from doc 010,
  not a new one.
- Agent→owner messaging is **reply-only** for the free-form path. Business- or
  agent-*initiated* contact after a provider's session window has closed is out
  of scope here and should go via email (see `030` constraints doc).

## Driving product facts (from the user)

1. Entire user base has SMS; most have WhatsApp.
2. Most non-conversational notifications can go via email.
3. The conversational requirement is narrow and specific: **if a user initiates
   a message on a chat platform, their agent should be able to reply there, on
   platforms we support.**
4. Target: support **at least two** chat providers beyond the platform inbox.

Fact (3) is load-bearing for feasibility — see `030-provider-constraints.md`.
It keeps us inside each provider's free-form "session window" and avoids
WhatsApp templates and SMS marketing-consent complexity for the core path.

## Document index

| Doc | Title | Purpose |
| --- | --- | --- |
| `000-README.md` | This file | Orientation, scope, index |
| `010-design-overview.md` | Design overview | The `ChatChannel` port, adapters, inbound router, where everything slots in |
| `020-taxonomy-and-registry-placement.md` | Taxonomy & registry placement | How chat providers map onto the capability registry (009) and activation model (010) |
| `030-provider-constraints.md` | Provider constraints | Fact-based per-provider rules (Telegram / WhatsApp / SMS): windows, templates, registration, cost, encoding |
| `040-data-model-and-migration.md` | Data model & migration | De-Telegram-ifying the schema: channel-neutral identity, addresses, outbound-message correlation |
| `050-inbound-routing.md` | Inbound routing | Provider-neutral webhook ingress, reply→agent correlation without `force_reply` |
| `060-config-secrets-onboarding.md` | Config, secrets, onboarding | `messaging.chat.*` config, env twins, opt-in/consent, chat-address binding UX |
| `900-implementation-plan.md` | Implementation plan | Phased, verifiable task breakdown with phase gates |

## Non-goals

1. Extracting messaging into an external backend.
2. Agent-*initiated* outbound after a closed session window (templates, SMS
   marketing). Email covers that.
3. Rich provider-specific features beyond text + the existing document-ingest
   path (no stickers, reactions, voice, buttons in this feature).
4. Replacing the platform inbox or the email provider path.

## Source material

### Capability feature docs (`000-capability-foundations/`)

- `009-initial-capability-registry-and-tool-ownership-manifest.md` — registry
  rows + tool ownership; already lists `messaging/chat/{telegram,whatsapp}`.
- `010-capability-activation-model.md` — native activation + readiness; the
  implicit brokered `send_message` rule.
- `013-native-capabilities-and-external-backends.md` — messaging stays native.
- `006-messaging-capability-extraction.md` — native messaging boundary.
- `012-shared-capability-taxonomy-revision.md` — superseded; retained for the
  `capability → family → provider` framing.

### Architecture ADRs (`docs/tech/architecture/adrs/2026/`)

- [07/002 Capability Model & Registry](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md)
  — origin of the `messaging → chat` tree (§3) and the Telegram-vs-Gmail
  brokered/connection asymmetry rule (§6, Follow-Up Rule 5). Superseded for the
  native/external split but still the taxonomy source.
- [08/008 Native Capabilities & External Backends](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)
  — native vs external; messaging is the native example (§6); tool-owner kinds
  `core`/`general`/`native:*`/`external:*` (§8).
- [09/014 Capability-Agnostic Frontend Presentation](../../../tech/architecture/adrs/2026/09/014-capability-agnostic-frontend-presentation.md)
  — generic surfaces, capability-scoped detail, i18n-key + English-fallback,
  semantic-emphasis rendering. Governs the config/UI/i18n work (060).
- [06/002 Redis Streams Agent Transport](../../../tech/architecture/adrs/2026/06/002-redis-streams-agent-transport.md)
  — the `agent:outbound:{agentId}` delivery path the inbound router reuses;
  at-least-once + dedup-by-`messageId` + transport-neutral envelope (050).
- [06/001 Actor-Neutral Agent Protocol](../../../tech/architecture/adrs/2026/06/001-actor-neutral-agent-protocol.md)
  — the actor-neutral `user.message` envelope; a chat inbound is just another
  actor source (050).

ADRs reviewed and judged **not** directly governing this feature (listed for
completeness): 07/003, 07/004 (superseded by 08/008); 09/015 and 10/016–017
(external-backend skill/MCP registration — messaging is native, so out of
scope); the 08/0xx blueprint-marketplace set.
