# Taxonomy & Registry Placement

**Status:** draft
**Created:** 2026-10-04
**Parent:** [000-README.md](./000-README.md)
**Normative inputs — feature docs:**
[009 registry manifest](../../../../pending/000-capability-foundations/009-initial-capability-registry-and-tool-ownership-manifest.md),
[010 activation model](../../../../pending/000-capability-foundations/010-capability-activation-model.md)
**Source ADRs:**
[ADR 07/002 Capability Model & Registry](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md) §3–§6 (the `messaging → chat` tree and the Telegram-vs-Gmail asymmetry rule originate here),
[ADR 08/008 Native Capabilities & External Backends](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md) §8 (tool-owner kinds)

This feature must fit the **existing** taxonomy, not extend it. The capability
registry (009) already names chat providers. The job is to make the
implementation match the registry — including flipping lifecycle from `planned`
to `available` as each adapter ships.

## Where chat providers already live in the registry (009)

The native capability registry already contains these rows:

| Capability | Family | Provider | Lifecycle | Transport mode |
| --- | --- | --- | --- | --- |
| `messaging` | `chat` | `telegram` | available | brokered |
| `messaging` | `chat` | `whatsapp` | **planned** | brokered |
| `messaging` | `email` | `gmail` | available | connection-backed |
| `messaging` | `inbox` | `platform` | available | internal |

So the shared vocabulary already is `capability = messaging`, `family = chat`,
`provider ∈ {telegram, whatsapp, ...}`. This feature:

1. keeps `telegram` as `available / brokered`;
2. flips `whatsapp` `planned → available` when its adapter ships;
3. **adds** `messaging / chat / sms` as a new provider row.

### Proposed new / changed rows

| Capability | Family | Provider | Lifecycle (target) | Transport mode | Runtime compat family |
| --- | --- | --- | --- | --- | --- |
| `messaging` | `chat` | `whatsapp` | available | brokered | none |
| `messaging` | `chat` | `sms` | available | brokered | none |

**Transport mode — DECIDED: all three chat providers are `brokered`.** 009 marks
`telegram` / `whatsapp` as `brokered` (platform owns one bot/number, picks the
recipient; the agent cannot choose a destination) and `email / gmail` as
`connection-backed` (the credential/connection belongs to the user).

- **Telegram = brokered** (unchanged, shipped).
- **WhatsApp = brokered** (consistent with 009; the platform runs a single
  business number and the agent replies to whoever messaged in).
- **SMS = brokered** (**decision, 2026-10-04**). The platform operates **one
  shared A2P 10DLC number**; the agent replies to whoever texted in and cannot
  choose a destination. Rationale: it matches the reply-only use case, needs a
  single brand+campaign registration instead of per-user provisioning, and keeps
  SMS consistent with the other two chat providers. A per-user / per-number
  (connection-backed) model is explicitly **not** adopted and would be a separate
  future ADR (see note below), not a config toggle.

Consequence of the all-brokered decision: **no chat provider introduces a
user-owned `connection` row.** The shared number/bot/token lives in operator
config (060); the user's *address* (phone/chat id/wa_id) is bound in
`chat_addresses` (040), not as a credential connection. This keeps the Telegram/
Gmail asymmetry intact rather than inventing a user-owned chat-connection model.

No new family, no `segment`/`market`-style middle layer, no hierarchy encoded
into IDs (e.g. never `messaging/chat/telegram` as a single ID). This stays
within 012/013's fixed taxonomy decisions.

> **This is not a new idea introduced by this feature.** The brokered-vs-
> connection-backed distinction and the right to list a provider under
> `messaging/chat` before it has connection semantics are established by
> [ADR 07/002](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md):
> §6 states the implementation asymmetry is real (Gmail is connection-backed;
> Telegram is a brokered transport + chat id; platform inbox is internal), and
> Follow-Up Rule 5 explicitly says **Telegram must not be forced into Gmail's
> connection model until a real user-owned chat connection model exists.** The
> all-brokered SMS decision above honours this: SMS joins Telegram/WhatsApp as a
> brokered, address-bound provider rather than inventing a user-owned chat
> connection.

## Activation & tool ownership (010 + 009)

Nothing new is invented here — the chat work slots into existing rules:

- **Tool ownership (009)** is unchanged: `send_message` → `native:messaging`
  (brokered), `send_email` → `native:messaging`, `publish_artifact` →
  `native:messaging`. Adding chat providers does **not** add new tools; it adds
  new *providers* behind the same brokered `send_message` path and the inbound
  reply path.
- **Activation (010)**: `send_message` keeps its documented **implicit**
  platform-inbox / brokered-native rule — an agent replying to an inbound chat
  message does not require a per-provider explicit activation row, exactly as
  today. Any *explicit provider action* (if later introduced) would gate on an
  enabled `agent_capability_activations` row for `messaging` **plus**
  provider readiness, per the `send_email` precedent.
- **Readiness, not activation, is where "do we support this provider" lives.**
  A `planned` provider is visible but non-actionable (009 rule). Flipping to
  `available` + satisfying provider readiness (adapter configured, number/bot
  registered, webhook healthy) is what makes a chat provider dispatchable.

## "Configured like trading / email"

The user's stated ideal: configure messaging/chat the same way as trading or
email. Mapping onto the existing grantable model (AGENTS.md Actor Trading Model;
`Connection` is the single grantable entity):

| Concept | Trading (today) | Email (today) | Chat — all brokered (this feature) |
| --- | --- | --- | --- |
| Grantable entity | `connection` (venue) | `connection` (gmail) | brokered platform resource (no user `connection` row) |
| Provider id | `hyperliquid`, ... | `gmail` | `telegram`, `whatsapp`, `sms` |
| Family | — (external) | `email` | `chat` |
| Readiness | venue binding ready | email binding ready | chat address bound + shared provider healthy |
| Agent grant | `agent_connections` | `agent_connections` | implicit brokered (messaging activation; no `agent_connections` row) |

Because all three chat providers are brokered (decision above), **none of them
needs a per-user credential `connection` the way gmail does** — the platform
owns the bot/number/token. "Configured like email" therefore means, for chat,
**the user binds their chat address** (Telegram chat id / WhatsApp number / SMS
phone number) and the agent gets the messaging capability — rather than the user
supplying a provider credential. This is the deliberate asymmetry ADR 07/002 §6
preserves: chat is address-bound + brokered, email is credential-connection-
backed. See `060` for the binding UX and `040` for where the address is stored.

## What must change in the capability docs

This feature should land a small amendment (not a rewrite) to the 009 manifest:

1. add the `sms` provider row with transport mode **`brokered`**;
2. update `whatsapp` lifecycle when its adapter ships.

These are registry-data changes, validated by the existing manifest tests
(key-set equality, planned-provider non-actionability). No new capability IDs.

### If per-user SMS numbers are ever needed (out of scope)

A future per-user / per-agent number model would make SMS `connection-backed`
and introduce a real user-owned chat `connection`. Per ADR 07/002 Follow-Up
Rule 5 that is a genuine model change and must be raised as its own ADR — it is
**not** a change this feature anticipates or leaves a toggle for.
