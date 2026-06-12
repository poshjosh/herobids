# Fix

1. Fix protocol name drift first.
In agent-activity-mapper.ts, several classifications use stale literal names:
- `agent.send_message` vs real `agent.message.send`
- `platform.decision.accepted` vs real `instance.decision.accepted`
- `platform.tool_result` vs real `instance.tool.result`
- `platform.context_snapshot` vs real `instance.context.snapshot`

I would replace those literals with canonical constants from agent-protocol.ts and update the feed tests accordingly. Otherwise the feed stays semantically wrong even after more messages start flowing.

2. Add explicit runtime activity message types.
Right now agent.ts only publishes heartbeat and session-ended messages. I would add a small set of operator-meaningful audit events such as:
- `agent.tick.started`
- `agent.tick.skipped`
- `agent.scout.held`
- `agent.scout.escalated`
- `agent.llm.dispatch`
- `agent.llm.completed`
- `agent.tool.call`
- `agent.tool.result`

Do not mirror every pino log line. Keep it to milestones that an operator would actually want to see.

3. Register those types in the protocol catalog and broker.
Publishing from the runtime is not enough. agent-message-broker.ts rejects unknown message types before persisting them, so each new activity event needs:
- a payload schema in agent-protocol.ts
- a constant in the message type catalog
- a broker route branch that marks it processed

These can be audit-only no-op handlers. They do not need business side effects.

4. Persist payload details, or the feed will stay generic.
This is the important structural gap. agent_messages.ts stores metadata, status, and `errorDetail`, but not message payload. So if you emit `agent.tool.call`, the feed can currently say only “Tool called”, not which tool or why.

I would add a `payload` JSONB column to `agent_messages`, store it in agent-repository.ts, and let the mapper read fields like:
- tool name
- skip reason / gate
- scout reason
- model / phase
- token usage / latency

Without that, the feed will be non-empty but still low-value.

5. Instrument the runtime at a few specific points.
In agent.ts, publish activity events at:
- tick start
- skip decision before returning
- scout hold / scout escalate
- before scout LLM dispatch
- before judge LLM dispatch
- before tool execution
- after tool result
- judge loop limit / scout loop limit conditions

The tools already emit business events like decision submit, bot manage, artifact publish, and send-message requests through `publishToInbound`, so the missing piece is runtime-loop observability.

6. Extend the feed contract for tick/tool/runtime-loop events.
agent-activity-types.ts already has categories like `tick` and `tool`, but the `eventType` union is still narrow. I would extend it with explicit event types for the new runtime milestones so the UI is not forced into fake `system.alert` buckets.

7. Test the whole path end to end.
I would add tests for:
- protocol schema registration in agent-protocol.test.ts
- broker acceptance/persistence of the new audit events
- mapper classification using canonical message constants
- activity-feed route returning the new rows while still suppressing heartbeats