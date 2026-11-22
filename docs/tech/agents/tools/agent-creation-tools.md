# Agent Creation Tools

Tools that let an agent create child agents and act on its direct children. They are defined in [agent-creation.ts](../../../../apps/worker/src/tools/agent-creation.ts). Design: [001-plan](../../../features/2026/10/25/001-agent-creating-agents/001-plan.md) §8.

Every tool calls the platform API with the calling agent's own API key. The API derives the creator from that key, so no tool input can name a creator, parent, depth or permission level.

## Visibility

| Tool | Shown when |
|---|---|
| `create_child_agent` | The agent's `childAgentLimit` is above 0 and its direct children are fewer than the limit. |
| `get_child_agent_status`, `pause_child_agent`, `stop_child_agent`, `message_child_agent`, `delete_child_agent` | The agent has at least one direct child. |
| `list_child_agents` | The agent holds the `child-agent-management` skill. Not gated on having a child, so the agent can learn it has none. |
| `list_owner_connections` | The agent holds the `child-agent-management` skill and `grantAnyConnectionToChildren` is on for it. Not gated on `childAgentLimit` or on having a child. |

All of these tools come from the `child-agent-management` skill, which only the user can assign. The agent cannot add it to itself, and it cannot grant it to a child. The `base` skill no longer lists these tools.

If the allowance has not been read, `create_child_agent` and the creator tools are hidden.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `create_child_agent` | `name` (1–100 chars), `prompt` (1–8000 chars), optional `skillIds`, optional `connectionIds`, optional `executionDefaults` (`{ mode?: 'paper' \| 'shadow', slippageBps?: number \| null }`, trading child only), optional `start` (boolean, default `true`) | Creates a child agent. With `start` true (the default) the child is started through the same start the user uses. With `start: false` it stays `stopped`. Returns the new agent ID, its depth, its `status`, `duplicate`, `started`, `startError` (set when the start was refused; the child then stays created and stopped), `childAgentLimit` and `remainingChildAllowance`. A create whose name matches a direct child of the same parent, created within `agentCreation.duplicateChildWindowSeconds`, returns that child with `duplicate: true` and `started: false`. It creates and starts nothing, so a retry never makes a second child. Which skills and connections can be granted depends on the creating agent's two grant settings (see [Child grant scope](#child-grant-scope)). The children skill cannot be granted (`skill.user_only`). See [Child execution mode](#child-execution-mode). |
| `list_owner_connections` | none | Read-only. Lists the owner's active connections the agent may pass to `create_child_agent` `connectionIds`: `id`, `provider`, `status`, `label` only, never credentials or provider references. The tool re-picks those four fields. Backed by `GET /agents/:id/owner-connections`, which returns up to 200 connections, oldest first, with no truncation signal. |
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
| Grant | `agent.create.grant_not_held` | A requested skill is not held by the creating agent and `grantAnySkillToChildren` is off, or a requested connection is not held and `grantAnyConnectionToChildren` is off. The two flags are checked separately. `params` carries `kind` and `missing`. |
| User-only grant | `agent.create.grant_user_only` | The requested skill is the children skill, which only the user may assign. |
| Permission | `agent.create.permission_exceeds_parent` | The child's permission level cannot exceed the parent's. |
| Fields | `agent.create.field_not_allowed` | An input field is outside the allowlist: `name`, `prompt`, `skillIds`, `connectionIds`, `executionDefaults`, `start`. |
| Live mode | `agent.create.live_not_supported` | `executionDefaults.mode` is `live`. HTTP 403, so the tool does not retry. Checked after the allowlist and schema checks, before any boundary write. |

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

### Child grant scope

Design: [Agent Child Grant Scope](docs/features/2026/11/22/002-agent-child-grant-scope/001-plan.md). Two per-agent settings, both `false` by default, set only by the user:

| Setting | Off | On |
|---|---|---|
| `grantAnySkillToChildren` | The child's skills must be a subset of the creating agent's skills. | The child may get any skill the owner may select. |
| `grantAnyConnectionToChildren` | The child's connections must be a subset of the creating agent's connections. | The child may get any active connection the owner has. |

- Unchanged by either flag: the owner checks (skill selectability and entitlement, connection exists, owned by the owner and `active`), `agent.create.grant_user_only` for the children skill, the permission level cap, allowance, depth, plan total and rate.
- A child never inherits the flags. It starts with both off, whatever its creator's settings.
- Turning a flag off affects future creates only. Existing children keep their grants.
- Write route: `PUT /agents/:id/child-grant-scope`, user callers only (agent keys get 403). Strict body `{ grantAnySkillToChildren: boolean, grantAnyConnectionToChildren: boolean }`. It is scoped to the owner, so another user's agent returns 404. Audit action `agent.child_grant_scope_set`, written in the same transaction, with both values as detail. `POST /agents` accepts the two fields for user callers only; agent keys are refused by the allowlist. `PATCH /agents/:id` does not write them.
- Read: `GET /agents/:id/child-allowance` returns both flags next to `childAgentLimit`. The worker reads them into its allowance, which drives the `list_owner_connections` visibility.
- `GET /agents/:id/owner-connections` is agent-key only and self-scoped. It returns `403 agent.owner_connections.not_enabled` when `grantAnyConnectionToChildren` is off, and `403` when the id is another agent's. The 200 body is `{ connections: [{ id, provider, status, label }] }`, active connections only, capped at 200.
- Audit: the `agent.child_created` detail carries `grantedNotHeld: { skills: string[], connections: string[] }`, the requested ids the creating agent did not hold and the flags let through. Both arrays are empty when everything was held or the flags are off. Ids only.
- The skill flag is not a hard security boundary. The broker's `add_skills` has no user-approval gate, so an agent can already assign itself any skill the owner may select (user-only skills and `base` are refused). The skill flag changes convenience and the parent's footprint. The connection flag changes account access, because a connection carries venue credentials and a child with a trading connection can trade on that account.
- On `agent.create.grant_not_held` the tool tells the agent to report the missing ids to the user and not retry with other skills.

### Child execution mode

A child that holds a trading skill takes the `executionDefaults` its parent passes. Design: [Agent Child Execution Mode](docs/features/2026/11/22/001-agent-child-execution-mode/001-plan.md).

- `mode` is `paper` or `shadow`. The tool schema leaves `live` out. `mode` defaults to `paper` for a trading child when omitted, and `executionDefaults` itself is optional for an agent caller.
- `slippageBps` is stored on the child as given. Omit it for the platform default.
- The child gets exactly what the parent sets. There is no cap against the parent's own mode, and nothing is copied from the parent's profile. Anything not set takes the same server default as a user-created child. `capital`, `risk` and `authorizationMode` are outside the allowlist and are refused with `agent.create.field_not_allowed`.
- `shadow` needs at least one connection granted to the child, as for a user-created agent. Without one the create is refused with a 400 connection message.
- `executionDefaults` on a child with no trading skill keeps the existing 400 ("Execution mode is only valid for agents with trading skills"). Trading and non-trading agents can create each other.
- `live` is refused with `403 agent.create.live_not_supported` and no child is written. The API enforces this even though the tool schema does not offer `live`. It is a fixed rule that reads no parent data. User-created agents are unaffected. The metrics outcome is `live_refused`.
- `agent.child_created` audit detail carries the child's resolved `executionMode` (null for a non-trading child).

### Refusal details in tool results

On any 4xx the platform client attaches the bounded refusal body (`params`, validation issues) to the error. The tool puts it in the error text as `Details: {...}` after the message, with the namespaced code in `errorCode`, because the agent loop forwards only `error` and `errorCode` for a failed tool. A refused grant (`agent.create.grant_not_held`) also gets a hint (`grantNotHeldHint` in `apps/worker`): ask the user to assign the missing skills or connections to the agent, or to turn on the setting that lets it grant skills or connections it does not hold, and do not retry with the same ones. Refusals such as `agent.create.live_not_supported` carry their message the same way.

## Known gaps

- `list_owner_connections` shows no truncation signal above 200 connections, and its `label` has no length cap.
- `message_child_agent` says replies count against the same limit. This is not yet true. A child's reply goes through the child's own `send_message` and does not use the creator-child bucket.
- The creator's pause and stop audit entry is written after the state change, so the two are not atomic.
- A refused launch is not pushed to the parent. The parent sees `lastStartRefusal` only when it calls `get_child_agent_status` or `list_child_agents`. The parent's tick has no child-status wake source, so it does not get a note.
- Default-capital provisioning for agent-created trading children is unverified.
- `slippageBps` has no upper bound in the tool schema.
- The API accepts `executionDefaults: null`, but the tool does not.

## Assigning the children skill

The `child-agent-management` skill is the only way these tools reach an agent. Only the user assigns it:

- The agent's `add_skills` tool refuses it (`skill.user_only`), and so does the broker that writes assignments.
- A child-create that asks to grant it is refused by the creation policy.
- When the user assigns it, the API sets the agent's `childAgentLimit` to the plan's child ceiling in the same transaction. A plan with no children leaves the limit at 0, and the response carries `childAgentLimitNotice`. Later saves that keep the skill leave the limit alone. The user can change the limit on the agent page.
- Removing the skill is not restricted.
