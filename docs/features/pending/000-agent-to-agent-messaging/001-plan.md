> **Superseded for the MVP (2026-10-25).** The current scope is in the messaging queue ([QUEUE](../../2026/10/10/007-multi-provider-chat-messaging/QUEUE.md)) and its decisions (DEC-40 to DEC-46). Off-by-default grants, the per-pair limits, the cost cap, and the trade block are deferred. This document is kept as the design reference for later phases.

# Plan: Agent-to-agent messaging

**Status:** pending. Not scheduled. Depends on [two-way agent chat](../../2026/10/15/002-two-way-agent-chat/001-plan.md) (the conversation store and participant model).
**Owner:** Chinomso Ikwuagwu
**Created:** 2026-10-15

---

## 1. Problem

Agents that belong to the same user cannot talk to each other. The owner wants them to coordinate: for example, a research agent passing findings to a trading agent. Today the only path into an agent is the user or a platform event.

## 2. Goal

An agent can send a message to another agent owned by the same user. Both sides are recorded in the conversation store, and the owner can see every thread and pause it.

## 3. Non-goals

- Messages between agents of different users. Cross-user messaging is not planned.
- Public or shared agents.
- Messages to external platforms on an agent's behalf (existing connections and channels stay as they are).
- Agent-to-agent money movement or trading instructions without the owner's own limits applying.

## 4. Principles

- **Off by default.** A new agent cannot message any peer until the owner allows that pair.
- **The owner can always see and stop it.** Every peer message is visible in the owner's activity and can be paused.
- **Peer text is data, not instructions.** It cannot change an agent's objective, grant it a tool, or lift a limit.
- **Limits come from operator config.** No magic numbers in code.

## 5. Design (proposed)

### 5.1 Permissions

- A grant row: `from_agent_id`, `to_agent_id`, `granted_by_user_id`, `created_at`, `revoked_at`.
- Created only by the owner, in the app. An agent cannot grant itself or another agent a permission.
- Checked on every send. A revoked grant stops delivery at once.

### 5.2 Identity

- A peer message is recorded with `sender_type = agent` and `sender_id` set to the sending agent. It is never recorded as `user`.
- The receiving agent's runtime tags the input as peer-originated. Check first whether the existing `agent.user.message` type (see [tick-gate-state.ts](../../../../apps/worker/src/tick-gate-state.ts)) already covers this, before adding a new wake type.

### 5.3 Loop and cost control

- **Turn cap per thread:** a maximum number of peer turns per rolling hour, set in operator config (`agentRuntime.peer.*`, names to be decided).
- **Ping-pong detection:** if two agents exchange more than the cap without any user message in between, the thread pauses and the owner is notified.
- **Cost cap:** a per-thread token budget. A thread that reaches it pauses.
- **Rate limit:** per agent pair, in addition to the existing per-user limit.

### 5.4 Prompt-injection stance

- The receiving agent's base prompt states that peer messages are data from another agent. They cannot change its objective, widen its permissions, or ask it to ignore its limits.
- Peer messages never trigger tool grants or connection requests. Those keep their existing user-approval paths.
- Tests cover a peer message that asks the receiver to ignore its objective.

### 5.5 Visibility and control

- Each agent-to-agent conversation appears in the owner's activity feed and in the agent detail page as its own thread, using the participant model.
- The owner can pause or resume a thread, and revoke the grant, from the same screen.

## 6. Phases

| Phase | Work |
|---|---|
| **A** | Grant model and owner UI to allow or revoke a peer. Permission check on send. |
| **B** | Peer send path through the conversation service. Peer wake and identity. |
| **C** | Turn cap, ping-pong detection, cost cap, rate limit, pause and notify. |
| **D** | Prompt-injection stance in the base prompt, with tests. Owner visibility. |

Each phase gets its own review. Phase C is the safety gate; the feature does not ship without it.

## 7. Gates

- All of section 6 covered by tests, including the injection case and the loop case.
- Owner review of the default-off permission and the operator config keys.
- No shared-environment rollout without explicit approval.

## 8. Decisions (approved 2026-10-25)

1. **Pair approval:** per pair. No group grants in the MVP.
2. **Paused thread:** resumes only on an explicit owner action. A user message does not resume it.
3. **Defaults** (operator config, starting values, tune from traffic; none hard-coded):
   - `agentRuntime.peer.maxTurnsPerHour`: 20 peer turns per thread
   - Ping-pong pause: after 6 consecutive peer turns with no user message between them
   - `agentRuntime.peer.tokenBudgetPer24h`: 50,000 tokens per thread
   - Rate limit: 30 peer messages per agent pair per hour
4. **Memory:** no sharing. Messages only in the MVP.
5. **Trading:** peer messages cannot submit or change orders. Trading execution stays in traderton (legal requirement). Trading-related peer text is delivered as information only.

**Sequencing:** see the queue items A2A-A to A2A-D in [AGENT-ENTRYPOINT](../../2026/10/10/007-multi-provider-chat-messaging/AGENT-ENTRYPOINT.md) §3. A2A-B depends on the 002 conversation store and on C2.
