# Agent Creation Tools

Tools that let an agent create child agents and act on its direct children. They are defined in [agent-creation.ts](../../../../apps/worker/src/tools/agent-creation.ts). Design: [001-plan](../../../features/2026/10/25/001-agent-creating-agents/001-plan.md) §8.

Every tool calls the platform API with the calling agent's own API key. The API derives the creator from that key, so no tool input can name a creator, parent, depth or permission level.

## Visibility

| Tool | Shown when |
|---|---|
| `create_agent` | The agent's `childAgentLimit` is above 0 and its direct children are fewer than the limit. |
| `get_child_agent_status`, `pause_child_agent`, `stop_child_agent`, `message_child_agent` | The agent has at least one direct child. |

If the allowance has not been read, all of these tools are hidden.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `create_agent` | `name` (1–100 chars), `prompt` (1–8000 chars), optional `skillIds`, optional `connectionIds` | Creates a child agent in `stopped` state. The user starts it. Returns the new agent ID, its depth, `childAgentLimit` and `remainingChildAllowance`. Grants are limited to skills and connections the creating agent holds. |
| `get_child_agent_status` | `agentId` | Returns the status, runtime state and depth of one direct child. |
| `pause_child_agent` | `agentId`, optional `reason` (max 500 chars) | Pauses one direct child. The pause is recorded as requested by the creator. |
| `stop_child_agent` | `agentId` | Stops one direct child. Same effect as the user pressing Stop. |
| `message_child_agent` | `agentId`, `message` (max 4000 chars) | Sends a message to one direct child. Subject to the creator-child message limit. |

All inputs are strict. Unknown keys, such as `creatorId`, `parentAgentId`, `depth` or `permissionLevel`, are refused.

## Limits

### Creation

`create_agent` is refused, and no child is written, when a rule fails. Rules run in this order:

| Rule | Error code | Notes |
|---|---|---|
| Rate | `agent.create.rate_limited` | Shared across the user's whole agent tree. The attempt uses a token even when refused. |
| Limiter unavailable | `agent.create.limiter_unavailable` | Fails closed. Retryable. |
| Allowance | `agent.create.allowance_exhausted` | The agent already has `childAgentLimit` children. |
| Depth | `agent.create.depth_exceeded` | Limited by `agentCreation.maxAgentDepth`. |
| Plan total | `agent.create.plan_limit_exceeded` | Total agents, including children, may not exceed the plan's `maxAgents`. Admin owners bypass this rule. |
| Grant | `agent.create.grant_not_held` | A requested skill or connection is not held by the creating agent. |
| Permission | `agent.create.permission_exceeds_parent` | The child's permission level cannot exceed the parent's. |
| Fields | `agent.create.field_not_allowed` | An input field is outside the allowlist. |

Operator settings are in [Configuration: Agent creation limits](../../configuration.md#agent-creation-limits).

### Creator actions

- Only direct children can be read, paused, stopped or messaged. Grandchildren and agents outside the creator's subtree are refused.
- Start, resume, edit and delete are user-only and are refused for agent keys.
- A child's memory and tools are never reachable through these tools.
- If the platform API is slow, down or refuses a request, the tool returns a retryable error and the agent continues.

## Known gaps

- `message_child_agent` says replies count against the same limit. This is not yet true. A child's reply goes through the child's own `send_message` and does not use the creator-child bucket.
- The creator's pause and stop audit entry is written after the state change, so the two are not atomic.
