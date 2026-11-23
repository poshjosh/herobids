# Parent-child agent messaging: plan

Status: implemented. Items 1 to 6 and 8 are DONE. Item 7 is SKIPPED by owner decision. Commits: 9c1a4b2e (items 1 to 3), f41858f1 (items 4 to 6).
Date: 2026-11-23

## Problem

A child agent created by a parent is also given the `agent-communication` skill. That skill and the base skill say `send_message` means "the user". So a child reports to its parent with `message_peer_agent` and also to its owner with `send_message`. The owner did not create the child and receives messages it does not understand.

Code facts behind this:

- `send_message` ([messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/messaging.ts)) has no target. It publishes `agent.message.send`. The broker's `handleSendMessage` ([agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts), around line 506) records the row with `ownerUserId: agent.userId`, so it always goes to the owner.
- `message_child_agent` ([agent-creation.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/agent-creation.ts), line 281) posts to `POST /agents/:id/message` ([agent-interactivity.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agent-interactivity.ts), line 438). It publishes `agent.user.message` with no `payload.peer`. The child renders it as `[USER]` ([runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts), line 1363). This is intended: the creator acts as the child's authority.
- `message_peer_agent` ([peer-messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/peer-messaging.ts)) is peer-tagged. It is subject to the owner's stop switch and a 10/min per-user limit. It carries no authority.
- Tool docs: [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md) documents `message_child_agent` (line 32) but line 18 says to use `message_peer_agent` for children. Nothing explains when each tool applies. Line 113 says child replies count against the creator-child bucket; that is not true today.
- `parent_agent_id` exists on `agents` (migration `0080_strong_jack_power.sql`).

## Decisions (confirmed by the owner)

0. **Child reports count against the existing per-agent `send_message` limit** (option A). Limit raised from 10 to 20 per minute per agent (`SEND_MESSAGE_MAX_PER_MINUTE`, [agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts) line 59). A per-agent `toolPolicy` can lower it but not raise it.

0a. **Limits (decided by the owner).** Keep the current limit structure. Only change: each of the three 10-per-minute limits becomes 20 per minute.

| Limit | Current | New | Where to change |
|---|---|---|---|
| Child and agent `send_message` (per agent) | 10/min | 20/min | `SEND_MESSAGE_MAX_PER_MINUTE`, [agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts) line 59 |
| Peer messages (per user) | 10/min | 20/min | `agentRuntime.peer.rateLimitPerMinute` default, [schema.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/config/schema.ts) |
| Parent to child (per pair) | 10/min | 20/min | `agentCreation.creatorMessageRatePerMinute` default, [schema.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/config/schema.ts) line 593 |

Implementation notes:
- The API route also has a hard-coded check, `if (count > 10)` with the message "Maximum 10 messages per minute", in [agent-interactivity.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agent-interactivity.ts) around line 500. It is not read from config. Change it to 20 too, and update the message text. Otherwise it will still cap at 10.
- Changing a schema default does not change running deployments that set the value explicitly. Check the deployment config for overrides.
- No separate alert quota. The earlier idea of a separate class quota is dropped, as the owner chose to keep limits as they are.

1. **Child reports are exempt from the peer controls.** Child-to-parent reports ignore the owner's peer-messaging stop switch and the per-user peer rate limit. Those controls stay for peer-to-peer messages only.
2. **Escalation is simple.** If the parent is reachable (running), every child message goes to the parent, including alerts. If the parent is unreachable (stopped, paused, crashed or with `lastStartRefusal`), the child's message goes to the owner, labelled `from child <name> of parent <name>, parent unavailable`.
3. **The parent forwards alerts.** The `child-agent-management` skill requires a parent to forward child alerts (`messageClass: alert`) to its owner. This is a prompt rule, not a platform guarantee.

## Target behaviour

| Sender | Tool | Recipient |
|---|---|---|
| Top-level agent | `send_message` | Owner (unchanged) |
| Child, parent running | `send_message` | Parent, as a child report |
| Child, parent unreachable | `send_message` | Owner, labelled with parent state |
| Child, any | `message_peer_agent` | Peer agent (unchanged) |
| Parent | `message_child_agent` | Direct child, as `[USER]` authority (unchanged) |
| Parent | `message_peer_agent` | Any agent of the same owner, as peer |

Parent guidance:
- `message_child_agent`: instructions and direction to a direct child. Authority comes from the creator relationship.
- `message_peer_agent`: collaboration or a second opinion. Carries no authority, so the parent should not treat its reply as an order.

## Plan

Order matters: the routing rule (steps 1 to 4) must exist before wording changes (step 5) so prompts do not promise behaviour that is missing.

### 1. Route child `send_message` to the parent (domain and broker)

Status: DONE (commit 9c1a4b2e)

- File: [agent-message-broker.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-message-broker.ts), `handleSendMessage`.
- Change: if the sending agent has `parent_agent_id`, check the parent's status (via `agentRepo.getAgent`, plus the active session). If the parent is running, publish an `agent.user.message` envelope to `agent:outbound:<parentId>` with `initiatorType = agent`, `initiatorId = childId` and `payload.childReport = { childAgentId, childName }`. Record it in the parent's conversation with `sender_type = agent`, `channel = web (the schema rejects internal; the sender is recorded as the child agent)`. Otherwise fall through to the owner path, with `payload.childReport` set and a `parentUnavailable` flag.
- Keep the per-agent `send_message` rate limit. Count parent-routed and owner-routed sends the same way.
- Dependency: none. Decision (1) means no call to the peer switch or the peer limiter.

### 2. Recognise child reports in the parent's prompt

Status: DONE (commit 9c1a4b2e)

- File: [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts), around `extractPeerOrigin` in [tick-gate-state.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tick-gate-state.ts) and the block at line 2814.
- Change: add a `CHILD REPORT` timeline kind (not `USER`, not `PEER`). Render it in its own block, `Reports from your child agents`, with the child's name and the text JSON-quoted, as the peer block does.
- Changing `extractPeerOrigin` affects the peer path, so write a test that peer messages still render as before.
- Depends on step 1.

### 3. Labelled fallback to the owner

Status: DONE (commit 9c1a4b2e)

- Files: the owner-route branch in step 1; the prompt builder for the owner's conversation.
- Change: the owner's copy of a fallback message is prefixed `from child <name> of parent <name>, parent unavailable`. A child whose parent is up never reaches the owner directly.
- Depends on step 1.

### 4. Keep `message_child_agent` as `[USER]` authority, and fix its limit wording

Status: DONE (commit f41858f1)

- Files: [agent-creation.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/agent-creation.ts) (description, line 285); [tools.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/tools.ts) (line 317); [agent-interactivity.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agent-interactivity.ts) (creator-child rate limit, lines 436 to 526).
- Change: no behaviour change. Update descriptions to say it is the creator's instruction to a direct child.
- Note: [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md) line 113 is wrong about child replies using the creator-child bucket. Fix the doc, or make it true. Recommend fixing the doc, since a child report is now a separate path.

### 5. Wording: "the user" becomes "your creator or user" for children

Status: DONE (commit f41858f1)

- Files:
  - [skills.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/skills.ts): `AGENT_COMMUNICATION_SKILL` (lines around 221 to 260). Rule "Reply to your user with `send_message`, not to a peer" becomes "Reply to your creator with `send_message` if you have one, otherwise to your user". Keep the reminder steps.
  - `CHILD_AGENT_MANAGEMENT_SKILL` (around 166 to 210). Line 198 currently says children keep in touch with the parent. Add the forwarding duty (see step 6) and the handover rule (step 7).
  - [messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/messaging.ts): `send_message` description. Add: "For a child agent, this goes to your creator; if your creator is unreachable, it goes to your user".
  - [peer-messaging.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools/peer-messaging.ts) line 35 `promptGuidance`: it says to reply to the user with `send_message`. Reword to match.
  - [runtime-composition.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/runtime-composition.ts) lines 2704 to 2705 and 2808 to 2814.
- Depends on steps 1 to 3, so wording matches behaviour.

### 6. Forwarding duty for parents

Status: DONE (commit f41858f1)

- File: `CHILD_AGENT_MANAGEMENT_SKILL` in [skills.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/skills.ts).
- Change: "Forward any child report marked alert to your user with `send_message`, with the child's name. Do not drop alerts."
- Depends on step 5 only for consistent wording.

### 7. Parent shutdown protocol

Status: SKIPPED (owner decision). No API or UI warning, no handover skill text, no child notice. Stopping a parent is not warned about, and its children fall back to the owner (step 3) when the parent is unreachable.

- Files: the stop, pause and delete endpoints in apps/api (not yet located; search for the routes behind `POST /agents/:id/stop`, `pause`, and `DELETE`), and the matching web UI controls in apps/web.
- Change, in order:
  a. When a user stops, pauses or deletes an agent with running children, the API returns a warning listing those children. The UI asks for confirmation. A confirmed request proceeds.
  b. Before the parent stops, the platform sends each running child a system notice: "your creator is going offline; wrap up or hold, and report to your user if needed".
  c. The parent's `child-agent-management` skill gets a handover section: summarise state to each child and to the owner, and name a successor or tell children to hold.
- Depends on steps 1 to 3 (children with a stopped parent use the owner fallback).
- Risk: a crash cannot run the handover. Step (a) and the fallback in step 1 cover that case.

### 8. Documentation

Status: DONE (uncommitted at time of writing; see the final commit)

- [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md): "Choose a tool" table for `message_child_agent` versus `message_peer_agent`; corrected the `message_child_agent` row (default 20 per pair); removed the wrong "replies count against the same limit" gap; added a "Child reports" section (routing, `(parent unavailable)` label, alert forwarding, exemptions, stop-parent consequence).
- [peer-messaging-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/peer-messaging-tools.md): default 20; base-skill reply wording; child reports skip the stop switch and the peer limit, with a link.
- [configuration.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/configuration.md): defaults 20 for `creatorMessageRatePerMinute` and `agentRuntime.peer.rateLimitPerMinute`.
- Comments corrected in [schema.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/config/schema.ts) and [default.yaml](/Users/chinomso.ikwuagwu/dev_ai/herobids/config/default.yaml): the creator-child bucket is creator to child only.
- Base skill in [skills.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/skills.ts) now says "to your creator if you have one, otherwise your user" for the send_message reply.
- Stop-parent warning: not documented as a platform warning, because item 7 was skipped. The docs state the consequence only: children keep running with no parent, and their reports reach the owner marked `(parent unavailable)`.

- [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md): add a "Choosing a tool" table for `message_child_agent` versus `message_peer_agent`. Fix line 18 and line 113. Document the parent-stop warning.
- [peer-messaging-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/peer-messaging-tools.md): state that child reports are exempt from the stop switch and the peer limit. Add a "Child reports" section.
- Add the `send_message` routing rule to the agent docs that cover messaging (search `docs/tech` for `send_message`).
- Add a user-facing note: stopping a parent affects its children.
- Documentation-only changes need no test run; the code changes need the tests below.

## Tests

Unit (vitest, existing files preferred):
- `agent-message-broker.test.ts`: child with running parent routes to the parent with `childReport`; child with unreachable parent routes to owner with the fallback label; top-level agent is unchanged.
- `peer-messaging.test.ts`: child reports bypass the stop switch and the peer limiter; peer messages still obey both.
- `runtime-composition.test.ts`: `CHILD REPORT` renders in its own block and is never shown as `[USER]`.
- `tick-gate-state` tests: `extractPeerOrigin` still recognises peer messages unchanged.

Integration:
- `peer-messaging.integration.test.ts` (existing): a child report reaches the parent's stream.
- Stop-parent warning: API route test in `apps/api` that lists children and requires confirmation.

Manual or UAT:
- Create parent with child, child sends `send_message`, owner receives nothing while parent runs; stop parent, child's message reaches owner with the fallback label.

## Risks and open questions

1. **Parent misjudges an alert.** Platform cannot enforce forwarding; step 6 is a prompt rule. Accept, or add a platform-level alert copy to the owner later.
2. **Child reports and the rate limit.** Step 1 counts child sends against the per-agent `send_message` limit. Confirm this is acceptable, since a busy child could be throttled while its parent is running.
3. **Existing children.** Children created before this change already have `agent-communication` and their old prompts. Confirm whether they need a restart or a prompt refresh to pick up the new wording.
4. **Parent crash.** No handover is possible. Owner fallback covers it, but the owner will see children directly until the parent recovers.
5. **Docs claim.** The line 113 inaccuracy exists today, independent of this change.

## Not in scope

- Per-pair grants, cost caps, and ping-pong pause (already listed as not in the MVP in peer-messaging-tools.md).
- Changing `message_child_agent` authority semantics.
- Owner-side UI for child reports (a separate feature).

## Outstanding Issues

Open questions and known gaps from the implementation. None blocks the shipped behaviour.

Items 1 to 3 (routing):
- Child reports enter the live Conversation window when it is enabled. After a restart, hydrated history reads them back as `CHILD_REPORT`.
- A redelivered child report can reach the parent twice, because `deliverChildReport` ignores `created`. This predates the change.
- An ambiguous Redis write (throws, but Redis may have accepted) marks the row `failed`, writes no owner copy, and may still reach the parent.
- A child report wakes the parent and skips session and active-hours gates, the same as peer messages. The 20 per minute child limit is the only cost bound.
- A child's `send_message` returns "queued" before routing, so the child does not see routing failures. Fixing this needs a synchronous acknowledgement.
- The per-agent `send_message` counter is in-process, not shared across workers.
- The `isChild` flag is read once per process. A failed read is retried on the next tick.
- Replies from known non-child peers in hydrated history are labelled as child reports, because the window has no PEER kind. The label is wrong, but this does not grant authority.
- `(parent unavailable)` label: this is the wording the plan specifies, `from child <name> of parent <name>, parent unavailable`. It is used when the parent belongs to the same owner. The parent name is dropped for another user's agent.

Items 4 and 5 (authority and wording):
- `conversation-thread-reader.ts` still labels non-self agent rows as `user`. Only the worker's `get_thread` and `get_message` tools use it.
- Envelopes sent before this change have no `messageClass` in their payload, so they render as routine. The `message_class` column exists (migration 0084), so no backfill is needed for new rows.
- The base skill's send_message wording now depends on whether the agent is a child, and the plain-text `<reply>` channel tag still says "the user". Check how it renders for children.
- The creator is assumed to be `parentAgentId`. It is not checked against `agent-creation.ts`.

Item 6 (forwarding):
- Forwarding of alerts is a prompt rule. The platform does not enforce it.

Item 7 (skipped by owner decision):
- Stopping or pausing a parent gives no warning and sends no notice to its children. Children fall back to the owner with `(parent unavailable)`. Confirm this is the final position.
- Existing children keep their old prompts until restarted, and existing deployments are out of scope by owner decision.

Item 8 (docs):
- The docs do not describe the platform warning, because item 7 was skipped.

Verification:
- Integration tests were not run. This environment has no `DATABASE_URL`, Postgres or Redis.

