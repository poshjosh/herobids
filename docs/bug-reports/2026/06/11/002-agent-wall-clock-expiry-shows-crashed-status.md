- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-11
- **Summary:** When an agent session ended due to hitting the wall-clock limit (`maxWallClockMs = 300_000`), the agent's status was set to `crashed` instead of `stopped`, causing false safety alerts and confusing UI state.

## Root Cause

The agent container sends `agent.runtime.session_ended` with `reasonCode: "wall_clock_expired"` to its inbound Redis stream before exiting. The worker's `AgentMessageBroker` had no case for `AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED` and fell through to the `default` branch, which marked the message as `rejected` with `code: "unsupported_type"`.

Because the broker never processed this message, the agent's DB status was never updated. When the container subsequently exited, `docker-agent-manager.onContainerDie()` saw `status !== 'stopped'` (it was still `running`) and followed the crash path: set status to `crashed` and fired a platform safety alert.

Note: `onContainerDie()` already has a guard — if `currentAgent.status === 'stopped'` it skips the crash path. The fix makes the `session_ended` handler set the status so that guard fires correctly.

## Fix

Added a `case AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED` in the broker's switch statement in `apps/worker/src/agents/agent-message-broker.ts`. It reads `reasonCode` from the payload, sets `status = 'stopped'` for planned shutdowns (`wall_clock_expired`, `stop_requested`, `pause_requested`) and `status = 'crashed'` for anything else, and retires any active runtime sessions immediately. That keeps the agent status accurate and prevents a stale running session from surviving the normal shutdown path.

## Files Changed

- `apps/worker/src/agents/agent-message-broker.ts`

## Verification

`pnpm lint` passes. A broker regression test now asserts that `agent.runtime.session_ended` sets the agent status to `stopped`, retires active sessions, and marks the message as processed. On next wall-clock expiry, `onContainerDie()` skips the crash path and alert without leaving a stale active session behind.
