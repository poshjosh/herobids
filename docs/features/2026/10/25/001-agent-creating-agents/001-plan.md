# Agent-Created Agents — Plan

Status: Draft (revision 3)
Date: 2026-10-25

## 1. Goal

Allow an agent to create other agents (child agents), within limits that only the user can change. Agents cannot raise their own limits. Users see and manage agents as a hierarchy.

## 2. Scope

In scope:

- Lineage fields on the `agents` table (creator, parent, depth).
- A per-agent creation allowance, set by the user only.
- An agent-facing `create_agent` tool, exposed by allowance.
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

Bots are not in this table. Bot ownership and creator data live in Traderton. Bot creator lookups go through the boundary (`list_owner_bots`, filtered by `creatorType === 'agent' && creatorId === agentId`), as the existing agent-delete path does.

Indexes: `(parent_agent_id)`, `(user_id, creator_type)`.

## 5. Enforcement Rules

`create_agent` by agent A (owned by user U) runs these checks in this order:

1. **Rate:** consume one token from U's bucket. Each attempt consumes a token, including attempts rejected by later rules. The bucket is shared across U's whole tree and lives in Redis. If Redis is unavailable, the attempt fails closed (rejected with a retryable error). No creation proceeds without the limiter.
2. **Allowance:** count of A's existing children < `A.childAgentLimit`.
3. **Depth:** `A.depth + 1 <= maxAgentDepth`.
4. **Plan total:** U's total agents (including children) < plan `maxAgents`.

Checks 2 to 4 and the insert run in one database transaction. The transaction takes a per-user advisory lock (`pg_advisory_xact_lock` keyed on user id) before counting, and a row lock on the parent. Two siblings under different parents therefore cannot both pass the plan-total check. The same user-level lock is taken by the existing user-facing create path, so both paths count consistently.

Failures return a tool error naming the rule that failed.

Admin bypass: the existing plan guards skip plan checks for admins. Plan total and ceiling keep that behavior for admins. Rate and depth apply to admins as a safety backstop. The allowance is user-set and always applies.

## 6. Permissions and Caller Identity

Agent runtimes do not call the platform API. They read and write Postgres and Redis directly through worker repositories and ports. The API therefore cannot see agent calls, and this plan does not add an HTTP caller identity for them (revision 3, decided 2026-10-25).

- Agent-facing creator actions (`create_agent`, message, pause, stop) run in the worker tool layer and call shared domain services directly. The worker supplies `actingAgentId` from the runtime session (`AGENT_ID`), never from tool input.
- The shared services own all rules in §5 and §7. Nothing else may write `agents.parent_agent_id`, `depth`, `child_agent_limit` or `creator_*`. This is the single write path.
- The API routes for user-only actions (setting `childAgentLimit`, resuming, starting, editing a child, deleting) stay user-authenticated as today. The agent runtime never calls them.
- Open risk: the agent runtime holds `DATABASE_URL`, so a raw SQL write is possible in principle. Mitigation: code review rule and a test that the runtime's tool layer exposes no generic write path. Full database-role isolation for agent runtimes is a separate task.
- Child agents start with `childAgentLimit = 0`, and do not inherit skills, tool policy or permission level. They start from defaults.
- Children are created with `status = 'stopped'`. The user starts them. Creator agents cannot start children.

The signed agent-runtime token and API guard were prototyped and reverted; they are not part of this plan.

## 7. Creator Access to Direct Children

| Capability | Allowed | Notes |
|---|---|---|
| Read status, decisions and notices | Yes | Read-only. |
| Send messages to the child | Yes | Subject to `creatorMessageRatePerMinute`. Logged with the creator as sender. |
| Pause the child | Yes | Sets `pauseState.requestedBy = 'agent:<creatorId>'`. Audited. |
| Stop the child | Yes | Same effect as the user's Stop action. Bot behavior is unchanged. Audited. |
| Resume, start, or edit the child | No | User-only, enforced in the API routes (§6), not only by hiding tools. |
| Call tools as the child | No | Would use the child's credentials and authority. |
| Read the child's private memory | No | Memory stays private to the owning agent. |
| Access grandchildren | No | Direct children only. |

Loop guard: messages between creator and child share one token bucket per pair (`creatorMessageRatePerMinute`). Replies consume from the same bucket, so a back-and-forth stops at the limit.

## 8. Agent-Facing Tools

`create_agent` (new, `apps/worker/src/tools/agent-creation.ts`) follows the `AgentTool` shape used in `bots.ts` and is registered in `tools/registry.ts`. It calls the shared create service from §5 with `actingAgentId` from the runtime session (§6).

- Input: name, prompt, and the subset of creation fields the platform allows for agents. No creator, parent or depth fields.
- Output: new agent id, depth, and remaining child allowance.
- Exposed only when `childAgentLimit > 0` and children count < `childAgentLimit`. No skill is required.

Creator-access tools (§7) are exposed when the agent has at least one direct child.

Child count > limit (after the user lowers the limit): `create_agent` is hidden, and existing children keep their access.

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
- Caller identity: the create and creator-action tools cannot set creator or parent from tool input. User-only API routes reject nothing new because agents never call them.
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
3. Agent-scoped caller identity and route guards (§6).
4. Hierarchical agents page and deletion options (useful before creation is enabled).
5. User API and UI to set `childAgentLimit`.
6. `create_agent` tool and creator access to children.
7. Enable on staging with a low plan ceiling; verify with §12.
8. Enable in production after staging review.

## 14. Documentation

- Operator config reference and the new plan entitlement.
- Agent tools reference: `create_agent` and creator access tools.
- User docs: hierarchy view, allowance, and deletion options.
- CHANGELOG entry.

## Outstanding Issues

### Item: operator-and-plan-configs (§3, §13 step 2)

- MEDIUM: add non-integer test cases for `agentCreateRatePerMinute`, `creatorMessageRatePerMinute`, and `childAgentLimitCeiling` (e.g. `1.5`) in `packages/domain/src/config/schema.test.ts`.
- LOW: document that `0` disables the feature for `agentCreateRatePerMinute` and `creatorMessageRatePerMinute` in the schema comments.
- LOW: decide whether an explicit `childAgentLimitCeiling` above `maxAgents - 1` should be rejected at plan validation or clamped in `resolveChildAgentLimitCeiling`.
- LOW: add one test that loads `config/default.yaml` through `AppConfigSchema` to catch drift.
- LOW: `config/default.yaml` plans intentionally leave `childAgentLimitCeiling` unset; confirm this is the intent.
- Pre-existing, out of scope: `apps/api/src/routes/agent-interactivity.ts:539` uses a hard-coded `?? 20`.
