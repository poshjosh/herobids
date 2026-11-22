# Agent Live Child Agents — Plan

Status: Outline for future work (revision 1). Not scheduled. Details are open on purpose.
Date: 2026-11-22
Depends on: [Agent Child Execution Mode](docs/features/2026/11/22/001-agent-child-execution-mode/001-plan.md) (ships first; refuses `live` with `agent.create.live_not_supported`) and [Agent Child Grant Scope](docs/features/2026/11/22/002-agent-child-grant-scope/001-plan.md) (connection grants).
Builds on: [Agent-Created Agents](../../2026/10/25/001-agent-creating-agents/001-plan.md) §5, §6.

## 1. Goal

Let an agent create a child that trades live, with one fixed rule: **a child's execution mode is capped at its parent's execution mode.** A paper parent cannot create a shadow or live child. A shadow parent cannot create a live child. A live parent may create a live child.

Everything else about live children is open and listed in §5.

## 2. Why this is a separate plan

The execution-mode plan deliberately has no cap, because `paper` and `shadow` are simulated and move no real money. `live` is the only mode that does. Allowing it brings back the questions the first plan removed: a cap, capital, exposure, authorization and the user's "Go Live" step. The first plan's refusal is a fail-closed default, and replacing it is the point at which this plan lands.

## 3. Decisions so far

- The cap is the parent's mode. Order: `paper` < `shadow` < `live`.
- Live is not available to agent-created children until this plan ships. Until then, `agent.create.live_not_supported` stays.
- A non-trading parent counts as `paper`, so it cannot create a live child.

## 4. What we know from the code (2026-11-22)

- **The mode order already exists, in traderton.** `packages/domain/src/trading/mode-rank.ts` has `MODE_RANK = { paper: 0, shadow: 1, live: 2 }` and `checkModeEscalation(requested, agentMode, context)`. It guards agent-created bots in traderton's `drive-target.ts`. The agent's own mode is passed in as `ownerMode`.
- **Herobids does not hold the order.** It has the `ExecutionMode` type and `TEST_MODES = {paper, shadow}` (a bucket, not a rank). Herobids dropped its local mode-rank check in the B1 work and relies on the boundary. `AGENTS.md` says not to reintroduce mirrored trading files.
- **`@poshjosh/contracts` does not export the rank.** I found no export of `MODE_RANK` or `checkModeEscalation` there.
- **Traderton has no concept of agent lineage.** A search of its packages and docs found no `parentAgentId`. A trading profile is keyed by owner, actor and venue account, and exists only once an agent is bound to a connection.
- **Where a parent's mode is stored.** The traderton profile is authoritative once the agent is bound (`selectExecutionBinding`, `currentProfile?.executionDefaults?.mode ?? unboundMode` in `agents.ts` ~1500–1660). The `agents.unified_config.execution.mode` snapshot is stamped at creation and not updated by `PATCH /agents/:id`, `PUT /agents/:id` or a connection bind. Paper↔shadow can drift. Live cannot: a test↔live change after creation is refused.
- **Shadow and live require a connection** (`validateConnectionRequirement`). An agent with no connection can therefore only be `paper`. Not verified: whether a revoked connection can leave a profile behind.
- **A cap pattern to copy.** `resolveChildPermission` and `agent.create.permission_exceeds_parent` in `agent-create-policy.ts`.

## 5. Open Questions

Each needs a decision before this plan is ready to build.

1. **Where the cap is enforced.**
   - Option A: export the rank from `@poshjosh/contracts` (traderton change and release), and herobids runs the check in the create preflight. Refusals stay clean and need no saga compensation. This is my leading option.
   - Option B: traderton enforces it on profile writes, with herobids passing the ceiling as `ownerMode`, as the bot path does. Needs a boundary tool change, and a late refusal inside the create saga would need compensation. Best as a backstop on top of A.
   - Not an option: a local rank in herobids (mirrored trading rule).
   - The traderton owner must agree to the choice. `AGENTS.md` requires asking before putting trading decisions in herobids.
2. **Where the parent's mode comes from.** Preferred: the traderton profile when the parent is bound, and `paper` when it is not. Needs a boundary read in the preflight, a fail-closed 503 when the read fails, and a decision on the small window between the read and the insert.
3. **Capital.** An agent cannot set `capital`. Live capital for a child needs a rule: who sets it, a per-child ceiling, and whether the parent's capital limits it.
4. **Total exposure.** A live parent could create several live children. Decide whether a parent's total live capital across children is capped, and where that total is kept.
5. **Authorization mode.** A parent set to `approval_required` must not create a child that trades without approvals. Likely: the child inherits `approval_required`. Check where the parent's authorization mode is stored and whether PATCH keeps it in sync.
6. **The "Go Live" step.** The existing flow makes live a deliberate user action ("Use 'Go Live' to create a live agent from this configuration"). Decide whether agent-created live children need the same user confirmation, for example an approval the user must accept before the child can start trading.
7. **A user switch.** Probably a per-agent flag like the grant-scope toggles (for example `allowLiveChildren`), off by default and not carried to grandchildren. Decide whether it also needs a plan entitlement. Live is already gated by `liveEnabled` in the plans config.
8. **Connection grants.** A live child needs a connection. Decide whether a live child may use a connection the parent does not hold. The grant-scope toggles apply, but live may need a stricter rule.
9. **Changes after creation.** Today the user can edit a child. Decide whether the parent's mode may later be lowered below an existing live child's mode, and what happens to that child.
10. **Observability.** Metrics outcome for a cap refusal, an audit field for the mode granted, and an alert for agent-created live children.

## 6. Sketch of the change

Not a design. A starting shape for the discussion.

- A cap check in `agent-create-policy.ts`, next to `resolveChildPermission`. Error: `403 agent.create.execution_mode_exceeds_parent`, params `{ parent, requested }`. Also a retryable `503 agent.create.parent_mode_unavailable` when the parent's mode cannot be read.
- `agent.create.live_not_supported` is removed when the cap is in place and the safeguards from §5 are decided.
- The parent's mode is resolved once in the preflight and passed into the policy input, as the grant check passes the parent's grants.
- The allowance response gains the parent's mode ceiling, so the agent knows its limit before it asks. Tool text and the `child-agent-management` skill are updated.
- A new `agent.child_created` audit field for the granted mode.

## 7. Tests (outline)

- Cap table: parent `paper`, `shadow`, `live`, non-trading, unbound; requested `paper`, `shadow`, `live`.
- Boundary read failure for a bound parent: 503, no child row, no boundary write.
- Snapshot says one mode and the profile says another: the profile wins.
- Live child without a connection: refused with the connection message.
- Live child under a parent without the user's live switch: refused.
- A user-created agent can still create a `live` agent where the plan allows (regression).

## 8. Rollout (outline)

1. Resolve the §5 questions with the traderton owner.
2. Traderton: export or enforce the rank. Ship dark.
3. Herobids: parent-mode resolver, cap check, switch and audit, behind the user flag and a feature flag.
4. Verify on one account on staging with real small capital before wider use.
5. Remove `agent.create.live_not_supported`. Update the docs and CHANGELOG.

## 9. Documentation to update when built

[agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md), the parent plan §5, the observability doc, user docs for the live switch, and CHANGELOG.
