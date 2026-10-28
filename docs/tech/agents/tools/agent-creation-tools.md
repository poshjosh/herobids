# Agent Creation Tools

Tools that let an agent create child agents and act on its direct children. They are defined in [agent-creation.ts](../../../../apps/worker/src/tools/agent-creation.ts). Design: [001-plan](../../../features/2026/10/25/001-agent-creating-agents/001-plan.md) §8.

Every tool calls the platform API with the calling agent's own API key. The API derives the creator from that key, so no tool input can name a creator, parent, depth or permission level.

## Visibility

| Tool | Shown when |
|---|---|
| `create_child_agent` | The agent's `childAgentLimit` is above 0 and its direct children are fewer than the limit. |
| `get_child_agent_status`, `pause_child_agent`, `stop_child_agent`, `message_child_agent`, `delete_child_agent` | The agent has at least one direct child. |
| `list_child_agents` | The agent holds the `child-agent-management` skill. Not gated on having a child, so the agent can learn it has none. |

All of these tools come from the `child-agent-management` skill, which only the user can assign. The agent cannot add it to itself, and it cannot grant it to a child. The `base` skill no longer lists these tools.

If the allowance has not been read, `create_child_agent` and the creator tools are hidden.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `create_child_agent` | `name` (1–100 chars), `prompt` (1–8000 chars), optional `skillIds`, optional `connectionIds`, optional `start` (boolean, default `true`) | Creates a child agent. With `start` true (the default) the child is started through the same start the user uses. With `start: false` it stays `stopped`. Returns the new agent ID, its depth, its `status`, `duplicate`, `started`, `startError` (set when the start was refused; the child then stays created and stopped), `childAgentLimit` and `remainingChildAllowance`. A create whose name matches a direct child of the same parent, created within `agentCreation.duplicateChildWindowSeconds`, returns that child with `duplicate: true` and `started: false`. It creates and starts nothing, so a retry never makes a second child. Grants are limited to skills and connections the creating agent holds. The children skill cannot be granted (`skill.user_only`). |
| `list_child_agents` | none | Lists the direct children: ID, name, status, depth, number of their own children and `lastStartRefusal`. Returns an empty list when there are none. |
| `get_child_agent_status` | `agentId` | Returns the status, runtime state, depth and `lastStartRefusal` of one direct child. |
| `pause_child_agent` | `agentId`, optional `reason` (max 500 chars) | Pauses one direct child. The pause is recorded as requested by the creator. |
| `stop_child_agent` | `agentId` | Stops one direct child. Same effect as the user pressing Stop. |
| `message_child_agent` | `agentId`, `message` (max 4000 chars) | Sends a message to one direct child. Subject to the creator-child message limit. |
| `delete_child_agent` | `agentId`, optional `stopFirst` (boolean, default `true`) | Permanently deletes one direct child. A running child is stopped first through the same stop as `stop_child_agent`. With `stopFirst: false`, a running child is refused (`agent.child.running`) and nothing is deleted. The child must have no children of its own (`agent.child.has_children`); that check runs before any stop. Its bots are torn down first. Audited as `agent.child_deleted`; a stop made for the delete is audited as `agent.creator_stopped_child`. Returns `stopped` (true when this call stopped the child). |

All inputs are strict. Unknown keys, such as `creatorId`, `parentAgentId`, `depth` or `permissionLevel`, are refused.

## Limits

### Creation

`create_child_agent` is refused, and no child is written, when a rule fails. Rules run in this order:

| Rule | Error code | Notes |
|---|---|---|
| Rate | `agent.create.rate_limited` | Shared across the user's whole agent tree. The attempt uses a token even when refused. |
| Limiter unavailable | `agent.create.limiter_unavailable` | Fails closed. Retryable. |
| Allowance | `agent.create.allowance_exhausted` | The agent already has `childAgentLimit` children. |
| Depth | `agent.create.depth_exceeded` | Limited by `agentCreation.maxAgentDepth`. |
| Plan total | `agent.create.plan_limit_exceeded` | Total agents, including children, may not exceed the plan's `maxAgents`. Admin owners bypass this rule. |
| Grant | `agent.create.grant_not_held` | A requested skill or connection is not held by the creating agent. |
| User-only grant | `agent.create.grant_user_only` | The requested skill is the children skill, which only the user may assign. |
| Permission | `agent.create.permission_exceeds_parent` | The child's permission level cannot exceed the parent's. |
| Fields | `agent.create.field_not_allowed` | An input field is outside the allowlist. |

The child is created first, in its own transaction. The start runs after that commit. A refused start (for example a missing model selection or a skill that cannot be ported) is not a creation failure: the child stays `stopped` and the response carries `started: false` and `startError` with the namespaced code.

A launch refused later, when the runtime is about to start, is recorded on the child, not on the create response. Billing refusals (`billing.insufficient_funds`, `billing.limit_exceeded`, `billing.top_up_required`, `billing.account_suspended`) set `lastStartRefusal` on the child: `code`, a fixed `message` and `at`. The creator reads it from `get_child_agent_status` and `list_child_agents`, and only for its own direct children. The field is `null` when the last launch succeeded; a successful launch clears it. The child's own guardrail event is unchanged.

### Duplicate create

Before the child is written, the policy looks for a direct child of the same parent with the same name, created within `agentCreation.duplicateChildWindowSeconds` (default `300`; `0` disables). The match is exact on the name. The check runs under the parent's row lock, in the same transaction as the insert, and before the allowance rule. So two identical creates that race produce one child, and a retry at the allowance limit still gets the child. A match is not a refusal: the route answers `200` with the existing child, `duplicate: true`, `started: false` and its current `status`, and it does not start the child.

Operator settings are in [Configuration: Agent creation limits](../../configuration.md#agent-creation-limits).

### Creator actions

- Only direct children can be read, paused, stopped or messaged. Grandchildren and agents outside the creator's subtree are refused.
- Start, resume, edit and delete of an agent are user-only and are refused for agent keys. Two exceptions, both limited to direct children: `create_child_agent` starts the child it creates (`start`, default true), and `delete_child_agent` deletes a direct child, stopping it first unless `stopFirst` is `false`.
- `list_child_agents` and `delete_child_agent` act on the caller's own children only. The API keeps them self-scoped: the path must name the calling agent, and the target must be its direct child.
- A child's memory and tools are never reachable through these tools.
- If the platform API is slow, down or refuses a request, the tool returns a retryable error and the agent continues.
- The agent cannot start a child itself. A child whose launch was refused stays `stopped` until the user starts it. The skill tells the agent to report `lastStartRefusal` to the user and not to create another child to retry.

## Known gaps

- `message_child_agent` says replies count against the same limit. This is not yet true. A child's reply goes through the child's own `send_message` and does not use the creator-child bucket.
- The creator's pause and stop audit entry is written after the state change, so the two are not atomic.
- A refused launch is not pushed to the parent. The parent sees `lastStartRefusal` only when it calls `get_child_agent_status` or `list_child_agents`. The parent's tick has no child-status wake source, so it does not get a note.

## Assigning the children skill

The `child-agent-management` skill is the only way these tools reach an agent. Only the user assigns it:

- The agent's `add_skills` tool refuses it (`skill.user_only`), and so does the broker that writes assignments.
- A child-create that asks to grant it is refused by the creation policy.
- When the user assigns it, the API sets the agent's `childAgentLimit` to the plan's child ceiling in the same transaction. A plan with no children leaves the limit at 0, and the response carries `childAgentLimitNotice`. Later saves that keep the skill leave the limit alone. The user can change the limit on the agent page.
- Removing the skill is not restricted.
