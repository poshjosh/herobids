# Send Message Email Policy Design

## Summary

`send_message` remains the only outbound user-messaging tool.

Email is not a separate skill and not a separate tool. It is an optional
delivery fanout for `send_message`, enforced by the broker.

The policy goal is:

- routine agent chatter must stay in the platform inbox
- email is only allowed when the user explicitly asked for email delivery
- the agent cannot choose arbitrary recipients
- the platform must enforce the rule server-side rather than relying on prompt
  self-restraint

## Decision

This should **not** be modeled as a skill.

Skills are coarse capability bundles. Email delivery is narrower: it is a
delivery policy for an already brokered tool. The correct control plane is:

1. explicit per-agent config
2. structured `send_message` payload intent
3. broker-side enforcement

This also avoids a bad pattern from the config guidance: we should not infer a
durable policy from freeform prompt text at runtime. If the user explicitly says
"send me an email" in the prompt, the create/update flow should resolve that
into explicit stored agent config.

## Policy Scope

### In scope

- per-agent permission to allow `send_message` email fanout
- payload fields that let the agent distinguish routine inbox messages from
  email-worthy alerts or reminders
- broker rules that prevent routine messages from being emailed

### Out of scope

- a separate `send_email` tool
- user-selectable arbitrary recipient addresses
- email for every `send_message` by default
- runtime reparsing of prompt text on every tick to decide email permission

## Agent Config

### Storage location

Add a new `notificationPolicy` JSONB field on the `agents` record.

Reason:

- `toolPolicy` should remain focused on capability grants and limits
- email fanout is delivery behavior, not capability-tier enforcement
- this keeps message-channel policy separate from broker rate-limit policy

### Exact field shape

```ts
type AgentNotificationPolicy = {
  sendMessage?: {
    email?: {
      enabled: boolean;
      source: 'explicit_prompt' | 'explicit_update';
      enabledAt: string;
    };
  };
};
```

### Exact semantics

- `notificationPolicy.sendMessage.email.enabled`
  - default: `false`
  - when `false`, `send_message` may still write to the platform inbox, but it
    may not fan out to email
- `notificationPolicy.sendMessage.email.source`
  - `explicit_prompt`: the create or update flow resolved a direct user request
    in the goal/prompt into stored policy
  - `explicit_update`: the user explicitly enabled email delivery through a
    dedicated agent setting or API field
- `notificationPolicy.sendMessage.email.enabledAt`
  - ISO datetime recording when email permission was turned on

### API shape

Expose the same field through agent create and update payloads:

```ts
type CreateOrUpdateAgentRequest = {
  // existing fields omitted
  notificationPolicy?: {
    sendMessage?: {
      email?: {
        enabled: boolean;
        source: 'explicit_prompt' | 'explicit_update';
      };
    };
  };
};
```

`enabledAt` should be written server-side.

### Policy resolution rule

The system should not attempt to infer this policy inside the running agent.

Instead:

1. the user expresses the instruction in natural language or an explicit UI/API
   setting
2. the create/update path resolves that into `notificationPolicy`
3. the broker enforces the stored policy deterministically at runtime

This keeps the prompt as the source of user intent while still giving the
runtime an explicit, auditable config record.

## Send Message Payload

### Exact field shape

Extend the existing broker payload to:

```ts
type SendMessagePayload = {
  subject?: string;
  body: string;
  contextRef?: string;
  messageClass?: 'routine' | 'alert' | 'reminder';
  emailDelivery?: 'never' | 'if_allowed';
};
```

### Defaults

- `messageClass`: `'routine'`
- `emailDelivery`: `'never'`

### Field semantics

- `messageClass`
  - `routine`: general updates, commentary, progress notes, normal findings
  - `alert`: urgent or important attention-needed message
  - `reminder`: a time-based or scheduled reminder intended to prompt action
- `emailDelivery`
  - `never`: inbox only
  - `if_allowed`: the agent is requesting email fanout in addition to the
    inbox record; the broker decides whether policy allows it

### Important constraint

The payload must **not** include:

- recipient email address
- arbitrary channel list
- `email_required`

The platform owns recipient resolution. The agent may request email fanout, but
it cannot demand delivery to a custom destination.

## Broker Enforcement Rules

The broker remains the authoritative enforcement point.

### Rule 1: Inbox persistence is always the primary path

Every accepted `send_message` call is persisted to the platform message feed.

Email is a secondary fanout, never the canonical record.

### Rule 2: Email is opt-in per agent

Email fanout is allowed only if:

- `agent.notificationPolicy.sendMessage.email.enabled === true`

If the field is absent or false, the broker must not send email.

### Rule 3: Routine messages can never fan out to email

If:

- `payload.messageClass === 'routine'`
- and `payload.emailDelivery === 'if_allowed'`

then the broker must suppress email fanout.

Recommended behavior:

- persist the inbox message
- record that email fanout was rejected by policy
- optionally emit a platform-authored guardrail/event for observability

### Rule 4: Email requires an explicit per-message request

Even when agent email policy is enabled, the broker must not send email unless:

- `payload.emailDelivery === 'if_allowed'`

This prevents an agent with email permission from turning every message into an
email by default.

### Rule 5: Only alert and reminder classes are email-eligible

Email fanout is allowed only when:

- `payload.messageClass === 'alert'`
- or `payload.messageClass === 'reminder'`

Any other class must be treated as inbox-only.

### Rule 6: Recipient is fixed to the owning user's verified account email

The agent cannot choose the recipient.

The broker resolves the email destination as:

- the owning user's verified account email

If no verified email is available, email fanout is skipped and recorded as a
delivery-state failure, while the inbox record remains valid.

### Rule 7: Operator email infrastructure is still required

Even when agent policy and payload allow email, the broker may only send if:

- operator email delivery is configured

If email infrastructure is unavailable, the broker:

- keeps the inbox record
- records the email delivery attempt as failed or skipped

### Rule 8: Existing send_message rate limits still apply

The current `send_message` rate limit remains in force for all messages.

Email fanout should also have a stricter secondary limit, enforced separately by
the broker. The exact numeric limit can be operator-configured later; the policy
requirement is simply that email fanout must be stricter than inbox-only
messaging.

### Rule 9: Email denial must fail closed

If a message requests email and policy does not allow it, the platform must not
"best effort" guess.

It must:

- send inbox only
- never send email
- write an auditable denial reason

## Broker Evaluation Algorithm

The broker should evaluate `send_message` in this order:

1. validate payload schema
2. apply existing `send_message` capability/rate-limit checks
3. persist the message to the platform inbox/audit table
4. compute `emailEligible`

```ts
const emailEligible =
  payload.emailDelivery === 'if_allowed'
  && (payload.messageClass === 'alert' || payload.messageClass === 'reminder')
  && agent.notificationPolicy?.sendMessage?.email?.enabled === true
  && userHasVerifiedAccountEmail === true
  && operatorEmailConfigured === true;
```

5. if `emailEligible` is false, stop after inbox persistence and record why
6. if `emailEligible` is true, fan out the same message body to the user's
   verified account email

## Concrete Examples

### Example A: Routine progress update

Agent payload:

```json
{
  "subject": "Research update",
  "body": "I reviewed three sources and updated the watchlist.",
  "messageClass": "routine",
  "emailDelivery": "never"
}
```

Result:

- inbox message persisted
- no email

### Example B: Agent asks for email on an alert, but agent email policy is off

Agent payload:

```json
{
  "subject": "Urgent alert",
  "body": "BTC broke the threshold you asked me to watch.",
  "messageClass": "alert",
  "emailDelivery": "if_allowed"
}
```

Agent config:

```json
{
  "notificationPolicy": {
    "sendMessage": {
      "email": {
        "enabled": false
      }
    }
  }
}
```

Result:

- inbox message persisted
- email denied by policy
- denial recorded

### Example C: User explicitly asked for email alerts in the prompt and the
policy was resolved at agent update time

Agent config:

```json
{
  "notificationPolicy": {
    "sendMessage": {
      "email": {
        "enabled": true,
        "source": "explicit_prompt",
        "enabledAt": "2026-06-10T18:22:00.000Z"
      }
    }
  }
}
```

Agent payload:

```json
{
  "subject": "Scheduled reminder",
  "body": "You asked me to remind you about the CPI release in 30 minutes.",
  "messageClass": "reminder",
  "emailDelivery": "if_allowed"
}
```

Result:

- inbox message persisted
- email sent to the owning user's verified account email

## Rejected Alternatives

### New `send_email` tool

Rejected because it duplicates `send_message` and weakens the single brokered
messaging surface.

### Skill-gated email messaging

Rejected because skills are too coarse. Email delivery policy is per-agent and
per-message, not a new expertise bundle.

### Runtime prompt parsing on every tick

Rejected because policy should be explicit and auditable, not re-derived from
freeform prompt text inside the running agent.

## Recommended Implementation Surfaces

- agent API request/response schemas
- `agents` persistence model
- `SendMessagePayloadSchema`
- `AgentMessageBroker.handleSendMessage`
- outbound message persistence model to record inbox state plus email fanout
  state separately

## Exit Criteria

- routine `send_message` calls are inbox-only
- email fanout is impossible unless explicitly enabled per agent
- email fanout is requested per message rather than becoming automatic for the
  whole agent
- the agent cannot choose arbitrary email recipients
- all email denials and skips are auditable# Send Message Email Policy Design

## Goal

Support email delivery through `send_message` without creating a separate tool,
while preventing routine or general agent chatter from becoming email.

The intended behavior is:

- every `send_message` call still writes to the platform message feed
- email delivery is disabled by default
- email delivery is only allowed when the agent creator explicitly asked for it
  in the agent goal or through an explicit edit surface
- even when email is enabled for an agent, only non-routine message classes may
  request email delivery

This is a broker-enforced policy, not a skill.

## Decision

Use one `send_message` tool with brokered multi-channel delivery semantics.

- Do not add a `send_email` or `send_telegram` tool.
- Do not create a separate skill for email.
- Persist a resolved agent-level email permission in agent config.
- Extend `send_message` with explicit message classification and delivery hint
  fields.
- Enforce all email eligibility rules in the broker.

The agent goal remains the policy source. The platform may derive and persist the
resolved email permission from the goal at create/update time, but the runtime
must not re-parse the goal text on every tick.

## 1. Agent Config

### New persisted agent field

Add a new `notificationPolicy` JSONB field on `agents`.

Proposed shape:

```ts
type AgentNotificationPolicy = {
  sendMessage: {
    email: {
      enabled: boolean;
      source: 'none' | 'goal_explicit' | 'manual_override';
    };
  };
};
```

### Exact stored form

```json
{
  "sendMessage": {
    "email": {
      "enabled": false,
      "source": "none"
    }
  }
}
```

### Field semantics

- `notificationPolicy.sendMessage.email.enabled`
  - default: `false`
  - meaning: this agent may request email delivery through `send_message`
  - this does not force every message to email; it only permits email when the
    payload also requests it

- `notificationPolicy.sendMessage.email.source`
  - `none`: no email permission has been granted
  - `goal_explicit`: the create/update flow derived email permission from an
    explicit user instruction in the goal text, such as "send me an email"
  - `manual_override`: a later explicit settings or API edit enabled email

### Write-time resolution rule

At `POST /agents` and `PATCH /agents/:id`, the platform resolves and stores this
field.

- If the user goal contains an explicit email instruction, set:

```json
{
  "sendMessage": {
    "email": {
      "enabled": true,
      "source": "goal_explicit"
    }
  }
}
```

- Otherwise set:

```json
{
  "sendMessage": {
    "email": {
      "enabled": false,
      "source": "none"
    }
  }
}
```

- If a future explicit UI/API setting overrides the goal-derived value, write:
  `source: "manual_override"`.

### Why this belongs in agent config

- Email permission is not a capability bundle like a skill.
- Email permission is narrower than tool enablement; it is a delivery rule for
  one already-available brokered tool.
- Persisting the resolved policy keeps runtime behavior deterministic and audit
  friendly.

## 2. `send_message` Payload

### Revised protocol shape

Extend `SendMessagePayloadSchema` with two new fields.

```ts
type SendMessagePayload = {
  subject?: string;
  body: string;
  contextRef?: string;
  messageClass?: 'routine' | 'alert' | 'reminder' | 'action_required';
  deliveryHint?: 'default' | 'email_if_allowed';
};
```

### Exact field definitions

- `subject?: string`
  - unchanged
  - max 200 chars

- `body: string`
  - unchanged
  - min 1, max 2000 chars

- `contextRef?: string`
  - unchanged

- `messageClass?: 'routine' | 'alert' | 'reminder' | 'action_required'`
  - default: `'routine'`
  - meaning:
    - `routine`: general status, progress, commentary, non-urgent updates
    - `alert`: important issue or state change the user should know now
    - `reminder`: time-based or task-based user reminder
    - `action_required`: the agent needs a user decision, credential, or other
      explicit intervention

- `deliveryHint?: 'default' | 'email_if_allowed'`
  - default: `'default'`
  - meaning:
    - `default`: deliver to the platform feed only
    - `email_if_allowed`: request email fanout in addition to the platform feed,
      subject to broker policy

### Required behavior from the agent

- Routine or conversational updates must use:

```json
{
  "messageClass": "routine",
  "deliveryHint": "default"
}
```

- Messages intended to satisfy an explicit "send me an email" instruction must
  use a non-routine class and set:

```json
{
  "deliveryHint": "email_if_allowed"
}
```

### Backward compatibility

Older runtimes that omit the new fields will continue to behave as platform-feed
only because the defaults resolve to:

```json
{
  "messageClass": "routine",
  "deliveryHint": "default"
}
```

## 3. Broker Enforcement Rules

The broker is the authority for email delivery.

### Rule 1: Always persist the message first

Every accepted `send_message` call must create an `agent_outbound_messages` row
for the platform feed before any email attempt is evaluated.

This preserves auditability even when email is skipped, rejected, or fails.

### Rule 2: No agent-controlled recipients

The payload must not include `to`, `cc`, `bcc`, or arbitrary address fields.

The broker resolves the email recipient as the owning user's verified primary
email address.

### Rule 3: Email is opt-in per agent

Email fanout is only eligible when:

```ts
agent.notificationPolicy.sendMessage.email.enabled === true
```

If `deliveryHint === 'email_if_allowed'` and email is not enabled for the agent,
the broker must reject the call with a stable validation-style error.

Recommended error code:

```text
send_message.email_not_enabled
```

### Rule 4: Routine messages may never request email

If:

```ts
payload.messageClass === 'routine'
&& payload.deliveryHint === 'email_if_allowed'
```

the broker must reject the call.

Recommended error code:

```text
send_message.routine_email_forbidden
```

This is the core rule that prevents general agent chatter from turning into
email even when the agent has email permission.

### Rule 5: Only specific classes may fan out to email

Email fanout is allowed only for these classes:

- `alert`
- `reminder`
- `action_required`

Anything else must be rejected.

### Rule 6: `deliveryHint: default` never sends email

Even when agent email permission is enabled, the broker must not email a
message unless the payload explicitly requests:

```ts
deliveryHint === 'email_if_allowed'
```

This keeps email usage deliberate at the per-message level.

### Rule 7: Provider and recipient checks happen after policy checks

After the message passes policy validation, the broker may attempt email only
if all of the following are true:

- operator email delivery is configured
- the owning user has a verified primary email address
- the email provider accepts the request

If any of these fail:

- the platform-feed message remains persisted
- the email delivery attempt is marked as skipped or failed in delivery metadata
- the original `send_message` call is still considered accepted unless policy
  itself was violated

### Rule 8: Email uses a stricter delivery limit than feed-only messaging

Apply a separate email delivery limiter in the broker in addition to the
existing `send_message` rate limit.

Recommended initial rule:

- platform-feed `send_message`: keep the current per-minute broker limit
- email fanout: apply a separate broker-side cap per agent and per user

The exact numeric cap should be operator-configured, not part of the payload.

### Rule 9: The broker must log why email was or was not attempted

For every `send_message` call, the broker should emit one of these audit
outcomes:

- `feed_only`
- `email_sent`
- `email_skipped_policy`
- `email_skipped_not_configured`
- `email_skipped_no_verified_recipient`
- `email_failed_provider`

## End-to-End Behavior

### Example A: general status update

Agent goal does not request email.

Agent config:

```json
{
  "sendMessage": {
    "email": {
      "enabled": false,
      "source": "none"
    }
  }
}
```

Payload:

```json
{
  "subject": "Status",
  "body": "I reviewed the market and made no changes.",
  "messageClass": "routine",
  "deliveryHint": "default"
}
```

Result:

- accepted
- persisted to platform feed
- no email attempted

### Example B: explicit email alert requested in goal

Agent goal includes: "Send me an email if you need my action or if a major risk
event happens."

Agent config:

```json
{
  "sendMessage": {
    "email": {
      "enabled": true,
      "source": "goal_explicit"
    }
  }
}
```

Payload:

```json
{
  "subject": "Action required",
  "body": "I need you to confirm whether I should rotate capital into ETH.",
  "messageClass": "action_required",
  "deliveryHint": "email_if_allowed"
}
```

Result:

- accepted
- persisted to platform feed
- email attempted to the owning user's verified primary email

### Example C: agent tries to email a routine update

Payload:

```json
{
  "subject": "Daily update",
  "body": "Portfolio unchanged.",
  "messageClass": "routine",
  "deliveryHint": "email_if_allowed"
}
```

Result:

- rejected by broker
- error: `send_message.routine_email_forbidden`

## Implementation Notes

- This policy should be implemented as a broker extension to `send_message`, not
  a new skill and not a new tool.
- The goal-to-config resolution should run at agent create/update time, not at
  runtime tick time.
- If the product later needs a UI checkbox for email, that should write the same
  stored config field and use `source: "manual_override"`.

## Out Of Scope For This Document

- operator email provider schema and credentials
- email template rendering
- primary-email verification flow
- outbound message table schema changes for email-specific delivery metadata
- reminder scheduling design