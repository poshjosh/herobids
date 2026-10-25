# Peer Messaging Tools

`message_peer_agent` lets an agent send a message to another agent of the same user. It is defined in [peer-messaging.ts](../../../../apps/worker/src/tools/peer-messaging.ts). Scope and decisions: [A2A-B](../../../features/2026/10/10/007-multi-provider-chat-messaging/tasks/A2A-B-peer-send.md), DEC-40 to DEC-43, DEC-47 to DEC-49. Schema: [schema note](../../../features/2026/10/15/002-two-way-agent-chat/002-schema-note.md).

The tool is brokered, like `update_my_prompt`. It publishes `agent.peer.send` to the broker and waits on `agent:peer-send:reply:<requestMessageId>`. The broker takes the sender from the session-checked envelope, so no input can name the sender or the user. It has no HTTP route.

## Tool

| Tool | Input | What it does |
|---|---|---|
| `message_peer_agent` | `agent` (id or exact name of another agent of the same user, max 200 chars), `message` (text) | Sends the message. The recipient wakes and reads it, tagged as written by another agent. Input is strict: unknown keys are refused. |

The tool is in the base skill, so every agent sees it. The base skill text tells the agent to reply to a peer with `message_peer_agent` and to its user with `send_message`.

## Send path

`PeerMessagingService` (domain) runs these checks in order. The first one that fails ends the send.

| # | Check | Error code | Recorded in the thread as `refused`? |
|---|---|---|---|
| 1 | Message not empty | `peer.invalid_message` | No |
| 2 | Message within `agentRuntime.peer.messageMaxChars` | `peer.message_too_long` | No |
| 3 | Sender and recipient lookup; recipient resolved by id, else by unique name (case-insensitive) | `peer.unavailable` on a lookup error | No |
| 4 | Recipient is not the sender | `peer.self_send` | No |
| 5 | `canPeerSend`: both agents belong to the same user | `peer.not_allowed` (or `peer.unavailable` when the lookup fails) | No |
| 6 | Owner's stop switch is off (`users.peer_messaging_paused`) | `peer.paused` (or `peer.unavailable` when it cannot be read) | Yes |
| 7 | Recipient is not `stopped` or `crashed` | `peer.recipient_not_running` | Yes |
| 8 | Per-user rate limit (`agentRuntime.peer.rateLimitPerMinute`, default 10 per rolling minute) | `peer.rate_limited` (or `peer.unavailable` when Redis fails) | Yes |

Checks 1 to 5 are not recorded, because they do not establish a thread between two agents of one user, or have nothing to record. Once checks 1 to 5 pass, both agents are known to be the user's, and every later refusal is written to the pair's thread with `delivery_status = refused` and the code in `delivery_detail`.

A refusal of type `peer.not_allowed` includes the sender's other agents (`id`, `name`, `status`) in the tool result's `data.peers`, so the agent can correct the recipient. Another user's agents are never listed.

When all checks pass:

1. The message is recorded as `sender_type = agent`, `sender_id` = the sending agent, `channel = internal`, `queued`. The row id is the envelope message id, so a redelivered envelope sends once.
2. It is published to `agent:outbound:<recipient>` as an `agent.user.message` envelope with `initiatorType = agent` and `payload.peer = { fromAgentId, fromAgentName }`. That type already wakes the runtime early, bypasses the context-hash gate, and is kept while the agent is paused, so peer input needs no wake type of its own.
3. The row is marked `sent`. If the publish fails, it is marked `failed` (`publish_failed`) and the tool gets `peer.delivery_failed`.

Fail closed: any failed read (agent, stop switch, rate limiter) refuses the send.

## Rate limit

One counter per user across all their agents, in Redis: a sliding window held as a sorted set under `ratelimit:peer-message:<userId>`, timed by the Redis server clock. An allowed message adds one entry. A refused attempt adds nothing, so a flood cannot extend its own block. A paused send, or a send to a recipient that is not running, takes no slot.

## What the receiving runtime does

`extractPeerOrigin` (tick-gate-state.ts) recognises a peer message: type `agent.user.message`, `initiatorType = agent`, and a valid `payload.peer`. The runtime records it in the activity timeline as a `PEER` event, never as `USER`, so it is not counted as the user's message and a reply to the user does not mark it answered. The prompt shows it in its own block, `Messages from other agents of your user`, with the sender's name and the text JSON-quoted, so a newline in the text cannot start a fake `[USER]` line. A creator agent's message to its child has no `peer` and stays a user-style message.

The text of a peer message is data. The platform stores and forwards it unchanged. A peer message cannot submit, cancel or change an order or a limit through the platform (I5); trading stays in traderton. DEC-41 accepts that an agent that holds trading tools can still be influenced by peer text.

## Owner controls

| Control | Where |
|---|---|
| Stop switch | `PATCH /auth/me` with `{ "peerMessagingPaused": true \| false }`. Strict boolean; anything else is `400 auth.profile.invalid_peer_messaging_paused` and the switch is unchanged. `GET /auth/me` returns the current value. The Settings page has the toggle. |
| Thread list | `GET /agents/:id/peer-threads`: the agent's threads with other agents, newest first (two reads for the threads, one for the names). |
| Thread read | `GET /agents/:id/peer-threads/:peerAgentId`: the messages, oldest first, with the same cursor as `GET /agents/:id/conversation`. A refused message carries `refusalReason`. |

Both read routes are for the signed-in owner only. An agent key is refused with 403. Another user's agent, or the same agent twice, is 404.

## Not in the MVP

Per-pair grants, cost and turn caps, ping-pong pause, a per-pair limit, and the prompt-injection stance (DEC-44, DEC-45). A message already in the recipient's stream when the owner turns the stop switch on is still delivered; the switch stops new sends and new wakes.
