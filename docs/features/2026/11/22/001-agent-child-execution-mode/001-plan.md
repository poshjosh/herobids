# Agent Child Execution Mode — Plan

Status: Ready to build (revision 2, no open questions)
Date: 2026-11-22
Builds on: [Agent-Created Agents](../../2026/10/25/001-agent-creating-agents/001-plan.md) §5, §6. Sibling plan: [Agent Child Grant Scope](docs/features/2026/11/22/002-agent-child-grant-scope/001-plan.md). The two ship independently.

Revision 2 drops the mode cap. Revision 1 capped a child's mode at its parent's. That needed a mode ranking, a read of the parent's mode over the boundary, and a traderton export, all to guard modes that move no real money. The decision record is in §3.

## 1. Problem

An agent cannot create a child that holds a trading skill. Seen on a local stack with agent `crypto-trading-coord` (`51c5c436-94f5-4b47-845a-5387fc25bcc8`): three `create_child_agent` calls returned `agent.platform.invalid_request` (HTTP 400, about 2 ms) once the parent held `traderton/skills/crypto-trading`.

Cause, inferred from the code and the timing. The response body is not logged, so this was not confirmed on the wire:

- `traderton/skills/crypto-trading` is a trading-family skill. `CreateAgentSchema` (`apps/api/src/routes/agents.ts` ~line 406) requires `executionDefaults` for any trading-capable agent.
- An agent key may send only `name`, `prompt`, `skillIds`, `connectionIds` and `start` (`AGENT_CHILD_CREATE_FIELDS`). `executionDefaults` is refused with `agent.create.field_not_allowed`.
- The schema check runs before any server-side default exists, so the create can never pass.
- The earlier runs got past the schema only because `openaidom/skills/crypto-trading` is not registered as a trading-family skill.

The parent plan assumed the server would set `executionDefaults` for the child. It does not, for trading children.

## 2. Goal

1. Any agent may create a child of either kind, trading or not.
2. An agent may pass `executionDefaults` for a trading child. Whatever it sets, the child gets. Anything it leaves out falls back to what a user-created child gets.
3. `live` is not supported for agent-created children yet. The API refuses it with a clear error.

Herobids gains no new knowledge of trading. It adds no mode ranking, no read of the parent's mode and no cap.

## 3. Decisions (2026-11-22)

- Trading and non-trading agents can create each other.
- Agents may specify `executionDefaults` (`mode`, `slippageBps`). The child gets exactly what the parent sets.
- Everything the parent does not set falls back to what a user-created child gets: server defaults, as today. Nothing is copied from the parent's profile, capital, risk or authorization mode.
- No cap. A child's mode is not limited by its parent's mode.
- `live` is refused for agent-created children with `agent.create.live_not_supported`. The platform plans to support live later, so this is "not yet", not "never".
- Dropped from revision 1: mode ranking, parent-mode resolution, `parent_mode_unavailable`, the `executionModeCeiling` allowance field, authorization-mode inheritance, and the traderton owner confirmation and contracts export.

Why dropping the cap is low risk:

- `paper` and `shadow` are the test modes, and test modes are simulated: no real orders (glossary, Execution Mode).
- A `shadow` child still needs a connection (`validateConnectionRequirement`). A parent with none cannot create one, unless the user turned on the grant-any-connection toggle in the sibling plan. That is a deliberate user choice.
- It matches Agent Mode Purity in `AGENTS.md`: no constraint the creator did not ask for.
- The only mode that could move money is refused outright, with no override.

## 4. What the code does today

- `ExecutionDefaultsSchema` is `{ mode: 'paper' | 'shadow' | 'live', slippageBps?: number | null }`. `mode` defaults to `paper`.
- `resolveExecutionModeForSkills` (`agent-config-helpers.ts`) returns `paper` for a trading child that supplies no mode ("No existing mode and none provided — default to paper"). So the `executionDefaults is required` check in `CreateAgentSchema` is redundant for an agent caller. It rejects a mode for a non-trading child ("Execution mode is only valid for agents with trading skills"). Both behaviors stay.
- `validateConnectionRequirement` refuses `shadow` or `live` without at least one connection. `paper` needs none.
- A user-created child with no explicit values takes the existing server defaults: test-provisioning defaults (capital, mode) from traderton over `get_operator_defaults`, server-set risk, and `direct` authorization.
- Refusals from the create policy and route pass the error code through. The agent client currently drops the response body, so the agent sees only the status summary. That hid the cause of this error and the grant error.

## 5. Design

### 5.1 Allowlist and default

- Add `executionDefaults` to `AGENT_CHILD_CREATE_FIELDS` and to the `create_child_agent` tool schema. Shape: `{ mode?: 'paper' | 'shadow', slippageBps?: number | null }`. The tool schema leaves `live` out of the enum, so the model is not offered it. The API still enforces §5.2, because the tool is not the boundary.
- For an agent caller, `CreateAgentSchema` must not require `executionDefaults`. Skip the requirement for agent callers, and let `resolveExecutionModeForSkills` supply `paper`, as it does today when no mode is provided. Choose the mechanism when building: either a flag passed to the schema or a route-level fill with `{}` before the parse (the schema default makes `mode` `paper`). Do not add a new default value.
- A child that is not trading-capable and arrives with `executionDefaults` keeps today's 400 and message.
- A trading parent creating a non-trading child already works. Add a test, since it was not exercised.
- Any other field the parent does not set (`capital`, `risk`, authorization mode, strategy) stays out of the allowlist. It takes the server default.

### 5.2 `live` is not supported

- If an agent caller's `executionDefaults.mode` is `live`, the route refuses the create before any boundary write:
  `403 agent.create.live_not_supported`, with a message that live is not yet supported for agent-created children and that the user can change the mode once the child exists. Use 403 so the tool treats it as non-retryable. A 5xx would be retried.
- This is a fixed rule. It reads no parent data and has no override. It is not a rank. The check is a literal `mode === 'live'`, like the existing `TEST_MODES` use.
- User-created agents are unaffected and may use `live` under the existing plan gates.
- Metrics: the outcome set is closed. Add `live_refused` to `CREATE_AGENT_OUTCOMES`, set it in the route at the refusal (the same way `field_refused` is set), and update `docs/tech/architecture/observability.md`. No change to `createAgentOutcomeForRule`, since this is not a policy rule.

### 5.3 Audit

`agent.child_created` detail gains the child's resolved `executionMode` (null for a non-trading child). One field on an existing row.

## 6. Worker and Agent Tools

- `create_child_agent`: add the optional `executionDefaults` input. The description says the child takes whatever mode is passed, defaults to `paper`, that `shadow` needs a connection, and that `live` is not supported yet.
- Pass the refusal body through to the tool result for all 4xx responses, not only grant refusals. This closes the gap that hid both errors. It is step 1 of both plans. Do it once.
- Update the `child-agent-management` skill text: report a refusal to the user, do not retry with another mode, and do not create a second child.

No change to `AllowanceResponseSchema` or the allowance route.

## 7. Tests

- Route and integration tests:
  - Non-trading parent creates a trading child with no `executionDefaults`: 201, child mode `paper`.
  - Trading parent creates a non-trading child: 201.
  - Agent passes `executionDefaults.mode: 'shadow'` with a granted connection: 201, child mode `shadow`. Without a connection: 400 with the connection message.
  - A paper parent creates a `shadow` child with a granted connection: 201. This pins the decision to have no cap.
  - Agent passes `executionDefaults.mode: 'live'`: 403 `agent.create.live_not_supported`, no child row, no boundary write. A live parent is refused the same way.
  - Agent passes `executionDefaults` for a non-trading child: 400 with today's message.
  - `slippageBps` set by the parent is stored on the child.
  - A user-created agent can still create a `live` agent where the plan allows (regression).
- Field allowlist: `executionDefaults` accepted from an agent key. `capital`, `risk` and `authorizationMode` still refused with `field_not_allowed`.
- Metrics: `live_refused` is in the closed set and is recorded once per refused attempt.
- Worker: the tool schema accepts `paper` and `shadow` and rejects `live`; the tool refusal output carries the response body.

## 8. Rollout

1. DONE — Pass the refusal body through for all 4xx (shared with the grant-scope plan).
2. DONE — Route change: allowlist, schema requirement for agent callers, live refusal, metrics outcome, audit field.
3. DONE — Worker tool schema and description, skill text.
4. DONE — Docs: [agent-creation-tools.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/agents/tools/agent-creation-tools.md) (tool inputs, the allowlist, the live refusal), the parent plan §5 note, CHANGELOG.

Steps 1 and 2 can ship separately. No `.env` or operator config change, so no `.example` update. No migration.

## 9. Before Building

- Search `docs/bug-reports/` and read `git log` for `agents.ts` (create route), `agent-config-helpers.ts` and `agent-create-policy.ts`, per the repo rules.
- Read `docs/best-practices/README.md` and the documents it points to for API and tool changes.
- Check that test provisioning (default capital) runs for agent-created trading children the same way it does for user-created ones. If it does not, the child has no capital until the user sets it, and the plan should say so in the tool text.
- Check whether the web agent page shows a child's execution mode, so the UI matches.

## 10. Later: supporting live

Not in this release. When live is built for agent-created children, it needs its own plan, because the questions this release skips come back:

- A cap on a child's mode, with the rank owned by traderton (`MODE_RANK` and `checkModeEscalation` in traderton's domain package). Traderton would need to export it through the contracts package, or enforce it behind the boundary as it does for bots today.
- Capital per child, and total exposure across a parent's children.
- Authorization mode (`approval_required` must not be bypassed by a child).
- The existing "Go Live" step, which is deliberately a user action.
- Probably a user-set flag like the grant-scope toggles, off by default.

Replacing the refusal with that design is the point at which `agent.create.live_not_supported` goes away.

## 11. Open Questions

None.

## Outstanding Issues

Grouped by rollout item. Items shared with the grant-scope plan are recorded once, here.

### Item 1 — Refusal body passthrough (shared)

- Medium: `ApiErrorBodySchema` is strict. A malformed optional field (`message: 123`, `details: {}`) makes the whole parse fail and loses the namespaced error code. Make optional fields tolerant (`.catch(undefined)`) and add a test.
- Medium: `refusalContext` drops `params` when over 2,000 chars, losing `kind` and the missing ids. Cap array lengths inside `params` instead, and test with 100+ ids.
- Medium: the grant hint mentions a "grant setting" that does not exist until grant-scope steps 2 to 5 ship. Fine if those ship soon, otherwise reword.
- Low: add a test for another tool (e.g. delete 404) pinning the shared passthrough.
- Low: assert `error.context` in the 403 `forbidden` test.
- Low: oversized-body test should assert which branch ran.
- Low: consider an allowlist of validation-detail fields (`path`, `message`, `code`).
- Low: `Details` repeats `apiError`, which duplicates `errorCode`.
- Low: replace the `params as Record<string, unknown>` cast in `grantNotHeldHint` with a small Zod parse.

### Item 2 — Route change

- Medium: no test that a live parent is refused the same way (§7).
- Medium: the "paper parent" no-cap test does not seed a paper parent, so it pins no-cap only vacuously.
- Medium: no test that the audit row carries a non-null `executionMode` for a trading child.
- Medium: `live_refused` is only unit-tested; no route-level assertion that the outcome is set.
- Medium: test name "before any other check" is inaccurate (the live check runs after allowlist and schema checks).
- Low: tool text (item 3) should state that `mode` defaults to `paper`.
- Low: `slippageBps` test asserts the staged profile write, not the stored child.
- Low: shadow-without-connection test matches only `/connection/i`; assert code/path.
- Low: `executionMode` union in `packages/db/src/agent-audit.ts` duplicates the domain type.
- Low: `refineCreateAgent(boolean)`; consider an options object if more caller variants appear.
- Low: test helper `recordingSaga` uses `as unknown as`; prefer a typed stub.
- Not verified: default-capital provisioning for agent-created trading children; whether the web agent page shows a child's execution mode (§9).
- Note: `agent-child-create.integration.test.ts` is not in the `test:integration` script's file list.

### Item 3 — Worker tool schema and skill text

- Medium: `slippageBps` in the tool schema is unbounded (bot tool uses `.int().max(10000)`); consider capping in the tool.
- Medium: new skill bullet ("do not retry with another mode, do not create a second child") is broader than the plan and conflicts with the grant hint ("do not retry with the same skills"). Scope it or reconcile.
- Medium: confirm changed `CHILD_AGENT_MANAGEMENT_SKILL` text is upserted onto already-seeded system skills.
- Low: duplicate `executionDefaults` shape between port and tool schema.
- Low: prose-regex description tests are brittle.
- Low: no test that `executionDefaults` is omitted from the body when undefined.
- Low: no worker test tying `agent.create.live_not_supported` to the refusal body passthrough.
- Low: "defaults to paper / live not supported" repeated in three places.

### Item 4 — Docs

- Medium: `agent-creation-tools.md` says the child gets "exactly what the parent sets" and server defaults otherwise; backed by tests but not traced end to end.
- Medium: `slippageBps` "stored as given" — confirm persistence into the trading profile write.
- Medium: "`mode` defaults to `paper`" should read "for a trading child".
- Low: vague "trading and non-trading agents can create each other" wording.
- Low: Known gaps have no owner or tracking reference.
- Low: CHANGELOG passthrough bullet could sit under Changed/Fixed.
- Low: parent plan's stale bullet could use a strikethrough.
