# A2A-C: Safety gate (turn cap, ping-pong, cost cap, rate limit, pause)

**Status:** deferred (DEC-45). Do not start. Kept for later. Replaced for the MVP by DEC-42 (rate limit) and DEC-41 (accepted trading risk).

**Depends on:** A2A-B. **Approvals:** DEC-19. **Design:** [pending A2A plan](../../../../../pending/000-agent-to-agent-messaging/001-plan.md) §5.3 and §6 Phase C.

**This is the safety gate. The feature does not ship without it.**

## Limits (operator config, no magic numbers)

| Key | Starting value (DEC-19) |
| --- | --- |
| `agentRuntime.peer.maxTurnsPerHour` | 20 per thread |
| Ping-pong pause | after 6 consecutive peer turns with no user message between them |
| `agentRuntime.peer.tokenBudgetPer24h` | 50,000 per thread |
| Rate limit | 30 peer messages per agent pair per hour |

Add them to the Zod schema and `config/default.yaml`.

## Behaviour

- A thread that reaches a limit is paused. The owner is notified.
- A paused thread resumes only on an explicit owner action (DEC-16). A user message does not resume it.
- Limits apply per thread and per pair, in addition to the existing per-user limit.

## Tests (required)

- The turn cap pauses the thread at the limit.
- Ping-pong: six peer turns with no user message pauses the thread. A user message in between resets the count, and the thread still does not resume on its own.
- The token budget pauses the thread.
- The rate limit refuses the message with an error code.
- An explicit owner resume works. A user message does not resume.
- Owner notification is sent on pause.
- Every limit value comes from config. A test changes a value and checks the new behaviour.

## Acceptance

- All tests above pass.
- Type checks and `pnpm test`.
