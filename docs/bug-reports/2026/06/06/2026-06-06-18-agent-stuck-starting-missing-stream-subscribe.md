- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-06
- **Summary:** Every agent started by the user was stuck in `starting` for ~30 seconds then automatically stopped. No user action was taken to stop it.

## Symptoms (from worker logs)

```
Agent runtime launched (stub)
Stale agent start detected       ← 30 s later
Agent runtime stopped
Agent session start timed out
```

## Root Cause

`AgentSessionManager.reconcileStartingSessions()` launched the runtime container
(or stub) but **never called `AgentStreamConsumer.subscribe(agentId)`** afterwards.

The stub/Docker runtime publishes heartbeats to the Redis stream
`agent:inbound:{agentId}` every 5 seconds. Because no consumer group was ever
created for that stream key, the messages had no reader — they sat in Redis
unread. `handleHeartbeat()` was never invoked, so the session status never
transitioned `starting → running`. When the `AgentHealthMonitor` ran its
10-second check tick 30 seconds after `startedAt`, it found a session still in
`starting` state and called `handleStartTimeout()`, which stopped the agent.

The `AgentStreamConsumer.subscribe()` call existed only in the trading-bot
(BullMQ actor) creation path — it was never wired into the agent session
launch path.

## Fix

**`apps/worker/src/agents/agent-session-manager.ts`**
- Added optional `streamSubscribe?: (agentId: string) => Promise<void>` to
  `AgentSessionManagerConfig`.
- Called it immediately after each successful `runtimeLauncher.launch()` in
  `reconcileStartingSessions()`.

**`apps/worker/src/index.ts`**
- Introduced a `let agentStreamSubscribeFn` late-bind variable (needed because
  `sessionManager` is constructed before `agentStreamConsumer` in the init
  sequence, but the callback is only invoked after `sessionManager.start()`
  which runs after both are fully constructed).
- Assigned `agentStreamSubscribeFn = (id) => agentStreamConsumer.subscribe(id)`
  immediately after `AgentStreamConsumer` construction.
- Passed `{ streamSubscribe: agentStreamSubscribeFn }` as the config arg to
  `AgentSessionManager`.

## Tests Added

`apps/worker/src/agents/agent-session-manager.test.ts` — three new cases:

| Test | Verifies |
|---|---|
| `calls streamSubscribe for each agentId after a successful launch` | Callback invoked once per successfully launched session with the correct agentId |
| `does not call streamSubscribe when launch throws` | No subscription attempted if the container fails to start |
| `does not call streamSubscribe when the session claim fails` | No subscription attempted if the distributed claim races and loses |
