# Agent-Created Agents — Plan

Status: Draft (revision 7)
Date: 2026-10-25

## 1. Goal

Allow an agent to create other agents (child agents), within limits that only the user can change. Agents cannot raise their own limits. Users see and manage agents as a hierarchy.

## 2. Scope

In scope:

- Lineage fields on the `agents` table (creator, parent, depth).
- A per-agent creation allowance, set by the user only.
- An agent-facing `create_agent` tool, exposed by allowance, calling the existing API routes.
- A per-agent API key, so the API can identify agent callers.
- A creator's limited access to its direct children.
- Subtree deletion with explicit preconditions and a defined partial-failure state.
- Hierarchical agents page and user controls.
- Audit of creations, creator actions and deletions.

Out of scope:

- Creator agents acting as their children, or using children's credentials.
- Creator agents reading children's private memory.
- Cross-user agent sharing or transfer of ownership.
- Changes to bot creation rules. Bots remain owned by Traderton.

## 3. Terms and Names

| Name | Type | Meaning |
|---|---|---|
| `childAgentLimit` | per-agent, user-set | How many child agents this agent may create. Starts at 0. |
| `childAgentLimitCeiling` | plan entitlement (per plan, like `maxAgents`) | Highest value any `childAgentLimit` may be set to. If unset, defaults to `maxAgents - 1`, floored at 0. |
| `agentCreateRatePerMinute` | operator config | Token bucket capacity and refill per minute for `create_agent` attempts, per user across the whole tree. Default 10. |
| `creatorMessageRatePerMinute` | operator config | Token bucket per creator-child pair for messages in either direction. Default 10. |
| `maxAgentDepth` | operator config | Max number of generations below a user-created agent. Default 6. |
| `maxAgents` | plan entitlement (existing) | Max total agents per user, including child agents. |

## 4. Data Model

Add to `agents` (`packages/db/src/schema/agents.ts`) with one additive migration (new columns with defaults, so it is safe on a populated table; drizzle migration file and snapshot generated, schema export updated):

- `creatorType` — `text`, not null, default `'user'`. Values: `user` | `agent` | `system`.
- `creatorId` — `text`, nullable. The creating agent's id when `creatorType = 'agent'`; user id when `'user'`.
- `parentAgentId` — `text`, nullable, FK to `agents.id`, `ON DELETE NO ACTION`. The delete transaction always re-parents children explicitly first (§9), so the database never clears the link on its own and `depth` never goes stale.
- `depth` — `integer`, not null, default 0. 0 for user-created agents; parent depth + 1 for children.
- `childAgentLimit` — `integer`, not null, default 0.

Also on `agent_runtime_sessions`: `api_key_hash` — `text`, nullable. Holds the hash of the per-session agent API key (§6).

Bots are not in this table. Bot ownership and creator data live in Traderton. Bot creator lookups go through the boundary (`list_owner_bots`, filtered by `creatorType === 'agent' && creatorId === agentId`), as the existing agent-delete path does.

Indexes: `(parent_agent_id)`, `(user_id, creator_type)`.

## 5. Enforcement Rules

Rules are enforced inside the existing API routes, not in a new service or package (revision 5).

- Creation: `POST /agents` in [agents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.ts). The existing validation, plan checks and insert stay as they are. When the request comes from an agent, the route also applies the creator rules below.
- Creator actions: the existing `POST /agents/:id/pause` and `POST /agents/:id/stop` routes, with the same creator-child check.

`POST /agents` by agent A (owned by user U) succeeds only if all hold:

1. **Rate:** U's token bucket has a token available. Each attempt consumes one token, successful or not. The bucket is shared across U's whole tree and lives in Redis. If Redis is unavailable, the request fails closed with a retryable error.
2. **Allowance:** count of A's existing children < `A.childAgentLimit`.
3. **Depth:** `A.depth + 1 <= maxAgentDepth`.
4. **Plan total:** U's total agents (including children) < plan `maxAgents`, under a per-user advisory lock taken in the same transaction as the insert. The user-facing path takes the same lock, so both count consistently.

Failures return an error naming the rule that failed. Creation is atomic: the checks and the insert run in one transaction, with the parent row locked so concurrent calls cannot exceed the allowance.

Admin bypass: plan total bypasses for admins, as today. The child-allowance ceiling applies to admins as well (decided 2026-10-25). Rate and depth still apply to admins. The allowance is user-set and always applies.

Agent callers and admin: `request.isAdmin` is `false` for agent keys (auth plugin). For an agent-created child, the plan-total bypass therefore follows the owner's `users.isAdmin`, read in the creation transaction. That is the only use of the owner's admin flag for agent callers. No other rule changes for admin owners.

Agent callers, fields: the body is an allowlist of `name`, `prompt`, `skillIds`, `connectionIds`. Any other present field, unknown keys included, returns 400 `agent.create.field_not_allowed` listing the fields. Nothing is stripped silently. Every other field is server-set for the child: `toolPolicy`, `telegramChatId`, `executionDefaults`, `capital`, `runtimePolicyOverrides`, `risk`, `dailySpendBudgetUsd`, `notificationPolicy` and the model fields take their defaults, and `permissionLevel` is the lower of the parent's level and `standard`.

Agent callers, preflight: before any profile-boundary write, the same allowance, depth, plan total, grant and permission rules run read-only (no locks). A refusal there makes no boundary call, so a refused child never writes to the boundary and needs no compensation. The authoritative check is still the one under the user's lock inside the insert transaction in `commitLocal`.

Grant-read window (accepted): the parent's skill and connection grants are read in the insert transaction without a lock on the grant rows. A grant revoked from the parent while a creation runs can race with it. The only lock is the parent row lock, which serialises creations from the same parent and is not extended to revocations.

## 6. Permissions and Caller Identity

Agent reasoning and tools run inside each agent's container ([agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts)). The container calls the platform API over HTTP, using the existing routes.

**Per-agent API key (decided, simplified):**

- When the worker starts an agent runtime, it generates a random key, stores only its hash in a new column `api_key_hash` on `agent_runtime_sessions`, and injects the key into the container.
- The API finds the runtime session by hash and treats the request as that agent and its owner. The request is rejected if the session is `stopped` or `crashed`. Stopping or crashing the runtime therefore revokes the key automatically; there is no separate revocation field.
- The key reaches agent routes only. User-only routes (setting `childAgentLimit`, resuming, starting, editing a child, deleting) reject any key-authenticated request with 403.
- No new table, no signing, no JWT. Keys are never logged.

**Credential boundary:** the agent container still has `DATABASE_URL` and `REDIS_URL` today. The API key does not remove that. Removing direct database access from the container is a separate task and is needed for the full benefit of this design.

**Rules that stay the same:**

- Child agents start with `childAgentLimit = 0`. Nothing is inherited automatically.
- At creation, the parent may grant the child a chosen subset of its own skills and connections. The parent can grant only what it holds; the child's plan entitlements still apply; the child's permission level cannot exceed the parent's; the grant is recorded like any user-created grant.
- Children are created with `status = 'stopped'`. The user starts them. Creator agents cannot start children.

## 7. Creator Access to Direct Children

| Capability | Allowed | Notes |
|---|---|---|
| Read status and decisions | Yes | Read-only. Notices are not part of this release (decided 2026-10-25). |
| Send messages to the child | Yes | Subject to `creatorMessageRatePerMinute`. Logged with the creator as sender. |
| Pause the child | Yes | Sets `pauseState.requestedBy = 'agent:<creatorId>'`. Audited. |
| Stop the child | Yes | Same effect as the user's Stop action. Bot behavior is unchanged. Audited. |
| Resume, start, or edit the child | No | User-only, enforced in the API routes (§6), not only by hiding tools. |
| Call tools as the child | No | Would use the child's credentials and authority. |
| Read the child's private memory | No | Memory stays private to the owning agent. |
| Access grandchildren | No | Direct children only. |

Loop guard: messages between creator and child share one token bucket per pair (`creatorMessageRatePerMinute`). Replies consume from the same bucket, so a back-and-forth stops at the limit.

## 8. Agent-Facing Tools

`create_agent` is added to the tool set in [agents/](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/tools) following the `AgentTool` shape in `bots.ts`. It calls `POST /agents` over HTTP with the agent's API key (§6).

- Input: exactly `name`, `prompt`, `skillIds` and `connectionIds` (the allowlist in §5). The skills and connections are those the parent chooses to grant (§6). Any other field, including creator, parent, depth and permission, is refused with `agent.create.field_not_allowed`. The API derives lineage from the key.
- Output: new agent id, depth, and remaining child allowance.
- Exposed only when `childAgentLimit > 0` and children count < `childAgentLimit`. No skill is required.

Creator-action tools (pause, stop, message) call the existing agent routes the same way and are exposed when the agent has at least one direct child.

If the API is down, slow or refuses the request, the tool returns a clear retryable error and the agent continues. Creation is treated as a deliberate action: it is allowed to be slow or refused.

## 9. Deletion

### 9.1 Preconditions (both options)

- Every agent in the subtree must be `stopped`. The API returns 409 with the list of agents that are not stopped. It does not auto-stop them, because stopping is asynchronous in the worker health monitor.
- The user must confirm. The confirmation shows the number of agents and bots that will be affected.

### 9.2 Delete agent and all descendants (default)

1. Collect the subtree.
2. For each agent, deepest first, tear down its bots over the boundary. The existing per-agent teardown is reused, once per agent. Bot lookup is by `creatorType === 'agent' && creatorId === agentId` as well as by owner.
3. Delete all agents in the subtree in one database transaction.

Failure handling: if the boundary is absent or unavailable before any bot teardown, the request fails closed with 503 and nothing changes (matches today's behavior). If the boundary fails partway through step 2, the request stops and returns 503. Agents still exist. Bots of agents already processed are gone, and bots of the rest are untouched. The state is resumable: retrying the same delete re-lists bots per agent and continues. The database transaction in step 3 runs only after every bot teardown succeeds, so no agent is removed while its bots still exist.

### 9.3 Delete agent only

1. In one transaction: set `parentAgentId = null` on direct children, set their `depth = 0`, and reduce each descendant's `depth` by the child's old depth.
2. Delete the agent.

Children keep `creatorType` and `creatorId` as history. No bots are torn down, because the deleted agent's own bots are torn down first as in §9.2 step 2 (for that agent only). Children and their bots are untouched.

## 10. UI

### Agents page as a hierarchy

```
[Agent A]
    [Agent A1]
    [Agent A2]
[Agent B]
    [Agent B1]
```

- Expand and collapse per node. Top-level agents with ≤ 5 children start expanded.
- Each row shows status, depth, and remaining allowance (for example, "2 of 5 children used").
- Search and filter across the tree. A matched child shows its ancestors.
- Child agents show "Created by A". If the creator was deleted (agent-only delete, §9.3), the label reads "Created by a deleted agent".

### Allowance control

- On each agent's settings, a `childAgentLimit` field from 0 to the plan ceiling. Shows the ceiling and current child count.
- Lowering the limit below the current child count is allowed and keeps existing children.
- Hidden when the plan ceiling is 0.

### Deletion

- Dialog with the two options in §9. The subtree option appears only when the agent has children.
- The dialog lists agents that are not stopped and blocks confirmation until they are stopped.

### Creator actions on children

- Child rows show "Message", "Pause" and "Stop" actions for the creator, labeled in the activity log as actions taken by the parent agent.

## 11. Audit and Observability

- Each creation: creator agent id, new agent id, depth, user id, timestamp.
- Each creator action on a child (message, pause, stop): creator id, child id, action, timestamp.
- Each deletion: option chosen, number of agents and bots removed, and the outcome (completed, or failed with the step reached).
- Metrics: `create_agent` attempts by outcome. The rejection label is a bounded set of five values: `rate`, `allowance`, `depth`, `plan_total`, `limiter_unavailable`.

## 12. Tests

- Unit: each rule in §5 in isolation, and the rule order (rate consumed even when a later rule rejects).
- Rate: a rejected attempt still consumes a token; Redis unavailable fails closed.
- Concurrency (allowance): parallel `create_agent` calls at the allowance boundary create no more than the allowance.
- Concurrency (plan total): parallel creations under different parents of the same user cannot exceed `maxAgents`.
- Admin: plan total and ceiling are bypassed; depth and rate still apply.
- API key: a valid agent key identifies the agent and user; a revoked key (runtime stopped) is rejected; a key on a user-only route returns 403; creator and parent cannot be set from request input.
- Ceiling: setting `childAgentLimit` above the plan ceiling is rejected.
- Depth: an agent at depth `maxAgentDepth` cannot create children.
- Creator access: direct children can be read, messaged, paused and stopped; grandchildren, memory and tools-as-child are refused.
- Messaging loop: a back-and-forth stops at `creatorMessageRatePerMinute`.
- Tool exposure: `create_agent` is hidden when the limit is 0, the allowance is used up, or the count is above the limit after lowering.
- Subtree delete: rejected with 409 when a descendant is not stopped; a boundary failure in the middle returns 503, leaves agents in place, and a retry completes; success removes all descendants and their bots.
- Agent-only delete: across three levels, children become top-level, depths are correct for the whole subtree, and no bots of the children are touched.
- Migration: existing agents get `creatorType = 'user'`, `depth = 0`, `childAgentLimit = 0`.
- UI: hierarchy renders; subtree option appears only for agents with children; "Created by a deleted agent" label.

## 13. Rollout

1. Migration and model fields (additive; no behavior change).
2. Operator configs (`config/default.yaml`, validated in `packages/domain/src/config/schema.ts`) and plan entitlement `childAgentLimitCeiling` (`packages/domain/src/plan-entitlements.ts`, plans in `config/default.yaml`). Unset means `maxAgents - 1`, floored at 0, so no explicit values are needed for creation to stay off.
3. Per-agent API key: generation at runtime start, hash storage, revocation at stop, route guard (§6).
4. Hierarchical agents page and deletion options (useful before creation is enabled).
5. User API and UI to set `childAgentLimit`.
6. `create_agent` tool and creator-action tools calling the existing routes (§8).
7. Enable on staging with a low plan ceiling; verify with §12.
8. Enable in production after staging review.

## 14. Documentation

- Operator config reference and the new plan entitlement.
- Agent tools reference: `create_agent` and creator access tools.
- User docs: hierarchy view, allowance, and deletion options.
- CHANGELOG entry.

## Outstanding Issues

Known gaps as of the documentation update. Each needs a fix or an explicit decision.

- (a) Child-to-creator replies are not supported in this release. A child has no delivery path back to its creator, so the loop control in §7 has nothing to guard. Decision: deferred to the agent-to-agent plan (`docs/features/pending/000-agent-to-agent-messaging/001-plan.md`), where peer grants, turn caps and ping-pong detection apply. The `message_child_agent` description is corrected to say only the creator's messages are limited.
- (b) The creator pause and stop audit row is written after the state change and is not atomic with it.
- (c) Post-commit skill sync for children can leave a child without its skills if the sync fails.
- (d) The agent container still holds `DATABASE_URL`. The restricted database role is not done, so the per-runtime key does not remove direct database access.
- (e) The default-deny route flags `'child-create'` and `'creator'` must be reviewed whenever a new agent route is added.
- (f) The careful tool budget (`maxVisibleToolSchemas`) was raised from 32 to 40 in the code default (`packages/domain/src/config/schema.ts`). Review it. `config/default.yaml` sets a separate `defaultBudgets.maxVisibleToolSchemas` of 64.
- (g) Pre-existing, unrelated docs changes under `docs/features/2026/10/10` and `docs/features/pending` are not part of this feature.
- (h) Accepted and documented (decided 2026-10-25). Subtree delete ordering residual risk: each agent's trading profiles are cleared on the boundary inside the loop in `apps/api/src/routes/agents.ts`, before the final purge transaction. If that transaction fails, the profiles are already cleared while the agents remain.

## Decisions recorded (2026-10-25)

- Child-to-creator messaging: deferred to the agent-to-agent plan (see (a)).
- Child allowance ceiling applies to admin owners (§5).
- Notices removed from creator read access (§7).
- Blueprint and Go Live creations write `agent.created` audit events.
- Subtree delete ordering risk accepted (see (h)).
