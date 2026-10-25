# A2A-B: MVP peer messaging

**Depends on:** A2A-A, CH2W. **Schema:** [schema note](../../../15/002-two-way-agent-chat/002-schema-note.md) (DEC-47). **Stop switch write path:** choose per DEC-48 (delegated to the implementer, criteria in the decision) and record the choice as DEC-49. **Approvals:** DEC-40, DEC-41, DEC-42, DEC-43, DEC-44 (deferred), DEC-46.
**Design context:** [pending A2A plan](../../../../../pending/000-agent-to-agent-messaging/001-plan.md), partly superseded. This spec is the current scope.

## Objective

An agent sends a message to another agent of the same user. The message is stored in the conversation store as sent by an agent. The receiving agent wakes and reads it. The owner can see the thread and can stop all peer traffic.

## Scope

1. **Send path.** Through the conversation service, the same as user messages. Call `canPeerSend` (A2A-A) first. Refuse a send to yourself (A2A-A returns true for it, but a loop with no purpose is not useful).
2. **Record.** Write the message with `sender_type = agent` and `sender_id` set to the sending agent. Never record it as `user`.
3. **Rate limit (DEC-42).** A Redis counter per user, counting peer messages in a rolling one-minute window. Limit from `agentRuntime.peer.rateLimitPerMinute` (starting value 10, in `config/default.yaml` and the Zod schema). Over the limit, refuse the send, record it as refused with a reason, and return a dot-string error code (for example `peer.rate_limited`).
4. **Stop switch (DEC-43).** A per-user setting, stored in the database. When on, peer sends are refused and peer wakes do not start. It is set through the owner's settings. It is not an operator setting.
5. **Wake.** Before adding a new wake type, check whether the existing user-message wake in `apps/worker/src/tick-gate-state.ts` already covers peer input. Use it if it does. Record the choice in PROGRESS.md (tier 2). The receiving runtime tags the input as peer-originated.
6. **Owner view (DEC-43).** Peer threads appear in the owner's existing conversation view in CH2W. Mark them as agent-to-agent.

## Out of scope

- Grants and the grant screen (DEC-45).
- Cost cap, turn cap, ping-pong pause, per-pair limit (DEC-42, DEC-45).
- Trade block (DEC-41: accepted risk).
- Prompt-injection stance (DEC-44).
- Cross-user messaging.

## Tests (required)

- Same-user send is recorded with `sender_type = agent`.
- Cross-user send is refused (through `canPeerSend`).
- Send over the per-user limit is refused, and the refusal is recorded.
- The limit comes from config: a test changes the value and checks the new behaviour.
- With the stop switch on, sends are refused and no peer wake starts. Turning it off restores sends.
- A peer message is shown in the owner's thread view.
- Telegram and conversation tests pass (I1).

## Acceptance

- All tests above pass, named in PROGRESS.md.
- Type checks for `apps/api` and `apps/worker`.
- `pnpm test`, compared with the C0 baseline.
