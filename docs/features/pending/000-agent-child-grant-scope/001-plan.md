# Agent Child Grant Scope — Plan

Status: Ready to build (revision 3, no open questions)
Date: 2026-11-22
Builds on: [Agent-Created Agents](../../2026/10/25/001-agent-creating-agents/001-plan.md) §5, §6.

## 1. Problem

`create_child_agent` refuses with `403 agent.create.grant_not_held` when the child's requested skills or connections are not held by the creating agent. The rule is in `assertGrantsHeldByParent` ([agent-create-policy.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/agents/agent-create-policy.ts)).

Seen on a local stack with agent `crypto-trading-coord` (`51c5c436-94f5-4b47-845a-5387fc25bcc8`). It is a coordinator, so it should not hold the trading skills. It holds four skills and no connections. It asked for `crypto-trading`, `long-running-task` and one strategy skill per child. All three creates were refused, and the tool circuit then opened.

The "parent must hold it" rule suits a parent that delegates part of its own toolset. It does not suit a coordinator whose job is to build workers with skills it does not need itself. Giving the coordinator every worker skill makes its prompt and tool surface larger, and the coordinator would carry skills it should not use.

Related: a second block hit the same coordinator once the grants were right. A child with a trading skill could not be created at all, because `executionDefaults` is required and not allowed for agent callers. That is handled in [Agent Child Execution Mode](../000-agent-child-execution-mode/001-plan.md), which lets an agent pass `executionDefaults`, keeps the child's mode uncapped for `paper` and `shadow`, and refuses `live` for now. The two plans ship independently, and `shadow` children need the connection grants from this plan.

## 2. Goal

Let the user decide, per agent, whether that agent may grant its children skills and connections it does not hold. The default stays as it is today.

## 3. What the code does today

- The held-by-parent check is the only gate that depends on the parent. The other gates stay on the owner, and they still apply to a child create from an agent key:
  - `resolveSkillAssignmentsForUser` checks every requested skill against the owner: published and free, or the owner's own, or entitled, and the plan's `canViewMarketplaceSkills`.
  - The create route checks every connection: it exists, belongs to the owner and is `active`.
  - The children skill (`isUserOnlySkill`) cannot be granted by an agent.
  - The child's permission level cannot exceed the parent's.
- An agent can already give itself a skill it can select, through the `add_skills` tool, which goes through the broker. A skill grant scope therefore moves a boundary that is already soft. I have not traced the broker to confirm it has no user gate, so §9 lists this as a check.
- Connections have no agent-side route. A parent can hold a connection only when the user assigns it. Connections are the real boundary, since a connection carries venue credentials and the ability to move funds.
- `childAgentLimit` follows the same pattern this feature needs: a column on `agents`, a user-only `PUT /agents/:id/child-limit`, an audit row, and the `ChildAgentAllowanceCard` on the agent detail page.

## 4. Design

Two independent, user-set, per-agent settings. Both default to `false`.

| Setting (column) | When `false` (today) | When `true` |
|---|---|---|
| `grantAnySkillToChildren` (`grant_any_skill_to_children`) | The child's skills must be a subset of the parent's. | The child's skills may be any skill the owner may select. |
| `grantAnyConnectionToChildren` (`grant_any_connection_to_children`) | The child's connections must be a subset of the parent's active connections. | The child's connections may be any active connection the owner has. |

Two settings, not one, because the risk differs. A skill adds tools and instructions. A connection adds access to an account. A user may accept the first and not the second.

Unchanged by either setting:

- The owner checks in §3 (selectability, ownership, `active`).
- `agent.create.grant_user_only` for the children skill.
- Permission level cap, allowance, depth, plan total and rate.
- The agent cannot change the settings. They are written only through user-only routes, so the settings stay fixed at runtime, as the risk-gate rules in `AGENTS.md` require for user-configured limits.
- No new hidden constraint is added to agent behavior (Agent Mode Purity). The settings widen what the user allows. They add no policy the creator did not ask for.

The flags apply to the creating agent's own children only. A child does not inherit them. A child starts with both `false`, like `childAgentLimit` starts at 0.

### Policy change

In `lockParentAgent`, select the two columns with the parent row (already locked, so the read is consistent with the allowance check). Pass them to `assertGrantsHeldByParent`. Skip the held check for skills when `grantAnySkillToChildren` is true, and for connections when `grantAnyConnectionToChildren` is true. The check for a skipped kind falls back to the owner checks in the create route, which already run for agent callers. No new code path reads another user's data.

### Audit

- `agent.child_grant_scope_set`: written by the new PUT (§6).
- `agent.child_created` (existing, written in the creation transaction): its detail gains `grantedNotHeld: { skills: string[], connections: string[] }`. These are the requested ids the parent did not hold and the flags let through. Both arrays are empty when nothing was let through. `assertGrantsHeldByParent` returns this value instead of `void`, `evaluateAgentCreatePolicy` passes it up on `AgentLineage` (or a sibling return field), and the route adds it to the detail object it already writes. Ids only, no names or secrets. Computed from the parent's grants read in the same transaction, so it shares the known grant-read window in the parent plan §5.

### Refusal detail

A refused create already carries `params: { kind, missing }`. Pass those through to the agent's tool result. Today the agent sees only "The platform refused the request (HTTP 403)", so it cannot tell which skill failed. Include the missing ids and a hint that names the remedy: ask the user to assign the skills or turn on the grant setting. This applies whether or not the flags are on.

## 5. Data Model

One additive migration on `agents`, next number after `0091_merge_ext_prefixed_skills.sql`:

- `grant_any_skill_to_children` — `boolean`, not null, default `false`.
- `grant_any_connection_to_children` — `boolean`, not null, default `false`.

Defaults keep every existing agent unchanged. Update `packages/db/src/schema/agents.ts`, the drizzle migration and snapshot, and the exports.

## 6. API

- `PUT /agents/:id/child-grant-scope`, `requireUserCaller`. Body: `{ grantAnySkillToChildren: boolean, grantAnyConnectionToChildren: boolean }`, strict. One `UPDATE` scoped to the owner, so another user's agent returns 404. The audit row is written in the same transaction: action `agent.child_grant_scope_set`, detail with both values. Mirrors `PUT /agents/:id/child-limit`.
- `POST /agents` for user callers accepts the two fields, so the create flow can set them in one step. Agent keys are unaffected: the field allowlist (`AGENT_CHILD_CREATE_FIELDS`) already refuses them with `agent.create.field_not_allowed`. Add a test that pins this.
- `GET /agents/:id/child-allowance` returns both flags. The worker reads them with `getOwnAllowance`.
- The agent response includes both flags for the UI.
- The settings are not accepted by `PATCH` or `PUT /agents/:id`, so a single route owns the audit.

## 7. Worker and Agent Tools

- Extend `AgentAllowance` and `AllowanceResponseSchema` in `agent-platform-client.ts` with the two flags.
- `create_child_agent` descriptions currently say "Only skills you hold can be granted". Make the text true under both settings. Static schema text cannot depend on the agent, so say that the allowed set depends on the agent's grant settings and list the exact refusal remedy.
- Discovery. With the skill flag on, the agent needs a way to find skill ids it does not hold. `search_skills` exists. Check that its output carries the id and slug that `create_child_agent` accepts, and fix the description if not.
- Connections: no agent tool lists the owner's connections. With the connection flag on, add a read-only `list_owner_connections` (id, provider, status, label only; no secrets), shown only when the flag is on. Without it the flag has no use. Confirm with the owner of the tool catalogue before adding a tool, because of the tool-budget gap (f) in the parent plan.
- Update the `child-agent-management` skill text so the agent reports a grant refusal to the user and does not retry with other skills.

## 8. UI

- `ChildAgentAllowanceCard` ([ChildAgentAllowanceCard.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/ChildAgentAllowanceCard.tsx)) gets two checkboxes under the limit field, saved with the same card. It is already hidden when the plan ceiling is 0. Show the checkboxes only when the limit is above 0, or label them as taking effect once the limit is above 0.
  - "Allow this agent to give children skills it does not have."
  - "Allow this agent to give children any of my connections." Add a warning line: a child with a trading connection can trade on that account. Say that children start by default.
- Create flow (`CreateAgentFlow.tsx`): show the same two checkboxes when the children skill is selected and the plan ceiling is above 0, since that is where the user chooses delegation. Send them in the `POST /agents` body.
- Add `api-client.ts` types and a `setChildGrantScope` call. Add i18n message ids next to the `agents.allowance.*` ids, in every locale file the project keeps.
- The hierarchy list shows no change.

## 9. Risks and Checks Before Building

| Risk | Handling |
|---|---|
| A prompt-injected or confused coordinator gives children a live trading connection. | Connection flag is separate, off by default, with a UI warning. The owner checks still require `active` and owner-match. |
| The skill flag is thought to be a security boundary, but `add_skills` lets an agent self-assign skills. | Confirm the broker's rules for agent self-assignment, then state the real boundary in user docs: the skill flag changes convenience and the parent's footprint, the connection flag changes access. |
| The race where the parent's grants change mid-create (known gap in the parent plan §5). | Not relevant when the flag is on. When it is off, unchanged. |
| A user turns the flag off after children exist. | Existing children keep what they have. The setting governs future creates only. Say so in the UI. |
| Operator wants to forbid the flags. | Out of scope (decided 2026-11-22). Revisit if abuse appears. |

Check before coding:

1. Read the broker handler for `add_skills` to see whether agent self-assignment has any gate.
2. Confirm `search_skills` returns ids and slugs usable by `create_child_agent`.
3. Search `docs/bug-reports/` and read `git log` for `agent-create-policy.ts` and `ChildAgentAllowanceCard.tsx`, per the repo rules.
4. Read `docs/best-practices/README.md` and the best-practice docs it points to for API and UI changes.

## 10. Tests

- Policy unit tests ([agent-create-policy.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/agents/agent-create-policy.test.ts)):
  - Skill not held, flag off: refused with `grant_not_held`, `kind: 'skill'` (existing).
  - Skill not held, skill flag on: allowed. Connection not held, skill flag on and connection flag off: still refused.
  - Connection not held, connection flag on: allowed. Skill not held, connection flag on and skill flag off: still refused.
  - Children skill requested, either flag on: still `grant_user_only`.
  - The policy returns the ids it let through (`grantedNotHeld`), split by kind, and an empty set when all were held.
  - Permission level above the parent's, either flag on: still refused.
- Integration ([agent-child-create.integration.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agent-child-create.integration.test.ts)):
  - With the skill flag on, a skill the owner cannot select (paid, not entitled) is still refused with the owner-check error, and no child row is written.
  - A connection owned by another user is refused whatever the flag.
  - An inactive connection is refused whatever the flag.
  - Agent key sending `grantAnySkillToChildren` in the create body: `agent.create.field_not_allowed`.
  - Agent key calling `PUT /agents/:id/child-grant-scope`: 403.
  - Another user's agent: 404. Audit row written once per change, and none on 404.
  - A child created with the flags on has both flags `false`.
  - `agent.child_created` detail lists `grantedNotHeld` with exactly the skills and connections the parent did not hold. It is empty when the parent held everything, and when the flags are off.
- Worker: the allowance client parses the new fields; the tool refusal output includes `missing` and the remedy hint.
- Web: the card saves both flags; the checkboxes follow the limit; the create flow sends them only when the children skill is selected.
- Migration: existing rows read `false`/`false`.

## 11. Rollout

1. DONE — Refusal detail in the tool result (§4). Safe on its own and useful at once. Pass the response body through for all 4xx responses, not only grant refusals. A 400 `validation_error` was also reduced to "HTTP 400" and hid its cause. The [Agent Child Execution Mode](../000-agent-child-execution-mode/001-plan.md) plan shares this step. Do it once.
2. DONE — Migration, policy change and the `grantedNotHeld` audit field, flags default off. No behavior change.
3. DONE — User-only route, audit and allowance read.
4. PENDING — Worker client and tool text. Add `list_owner_connections` only if the connection flag ships.
5. PENDING — UI: card, then create flow.
6. PENDING — Docs: [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md) (Grant rule row and the creator action list), the parent plan's §6 note, user docs for the two settings, CHANGELOG.

Steps 1 and 2 to 3 can ship separately. Step 5 depends on 3.

No `.env` or operator config change in this plan, so no `.example` update is needed.

## 12. Decisions and Open Questions

Decided 2026-11-22:

1. Both flags ship now: `grantAnySkillToChildren` and `grantAnyConnectionToChildren`. Connections stay off by default with a UI warning.
2. No operator or plan-level cap on the flags. Add one later if abuse appears. The owner checks already bound what a user can grant.
3. The flags do not carry to grandchildren. Each agent has its own settings, defaulting to `false`.

4. Add `grantedNotHeld: { skills, connections }` to the detail of the existing `agent.child_created` audit row (see §4, Audit). Effort: about 15 lines and two tests, no schema change. The `agent.child_grant_scope_set` row on the new PUT is separate and stays. It copies `agent.child_limit_set`.

Open: none.

## Outstanding Issues

Refusal-body passthrough (rollout step 1) issues are recorded in the execution-mode plan.

### Item 2 — Migration, policy, `grantedNotHeld`

- Medium: no migration test proving existing rows read `false`/`false` (current test seeds through the new schema). Add one like `ext-prefixed-skills-migration.integration.test.ts`.
- Low: owner-check and permission-cap integration tests assert only `>= 400`; pin status and code.
- Low: `grantedNotHeld` may list duplicate ids if request arrays are not deduped; dedupe or confirm.
- Low: §10 lists `grant_user_only` and permission-cap with a flag on as unit tests; they exist only as integration tests.
- Low: add the "agent key sends `grantAnySkillToChildren` → `field_not_allowed`" test (planned for step 3).

### Item 3 — User-only route, audit, allowance read

- Medium: user `POST /agents` with a flag on writes no audit row (only the PUT audits). Decide: add flags to `agent.created` detail, or record creation as deliberately unaudited.
- Medium: no tests pinning the strict PUT body (extra key, missing field, non-boolean → 400, no audit row).
- Medium: `PATCH` silently drops the flags with 200; consider a 400 pointing to the new route, or document it.
- Low: audit detail spreads `...row`; name the two fields explicitly.
- Low: a no-op PUT still writes an audit row, with no previous values.
- Low: the PUT accepts child agents (POST forces false for children); note in plan.
- Low: flags can be stored on agents without the children skill; UI should send them only when the skill is selected.
- Low: duplicated comment on the create-schema fields and insert.
- Note: the "permission level above the parent" integration test was passing for the wrong reason (agent keys cannot send `permissionLevel`); it now pins `field_not_allowed`. The real cap is covered only in `agent-create-policy.test.ts`.
- Note: duplicate ids in `skillIds` on `POST /agents` return 500 (pre-existing `agent_skills` PK conflict).
