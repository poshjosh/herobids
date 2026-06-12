## Activity Feed Empty (1 Row per Agent)

This was **not in the original reports** — confirmed as a new anomaly.

**What the feed shows:** 1 entry — "Session started" — for each agent.

**Why:**

The activity feed (`/agents/:id/activity-feed`) merges four data sources:
1. `agent_messages` — excludes heartbeats (`SUPPRESSED_PROTOCOL_MESSAGE_TYPES`)
2. `agent_runtime_sessions` → synthesizes "Session started/stopped/crashed" entries  
3. `agent_outbound_messages` → notification messages
4. `agent_artifacts` → published artifacts

Sources 3 and 4 are empty (no messages sent, no artifacts published). Source 1, after suppression, is also empty — because **the agent runtime publishes exclusively `agent.runtime.heartbeat` to the Redis inbound stream**. Every tick, every LLM call, every tool execution, every scout hold is only emitted to container stdout (pino logs) — never written as a protocol message to the stream.

Stream type audit:
| Stream | Types found |
|---|---|
| `agent:inbound:d2f0626d...` | `agent.runtime.heartbeat` ×462 only |
| `agent:inbound:0649fb56...` | `agent.runtime.heartbeat` ×435 only |

The mapper has entries for `agent.tool_call`, `agent.decision.submit`, `agent.send_message`, `agent.manage_bot`, etc. — but the runtime never emits them. The activity feed is effectively non-functional for running agents.

**Fix:** The agent runtime needs to publish typed protocol messages (tick start, LLM dispatched, tool called, scout held, etc.) to the Redis inbound stream so they flow through the existing `agent-stream-consumer` → `agent_messages` pipeline.
