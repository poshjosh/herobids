# Execution Mode Immutability & "Go Live" Clone

## Problem Statement

Users can currently change an agent's execution mode (paper/shadow/live) after creation via multiple entry points (API PATCH, API PUT, Telegram `/mode` command, chat-based edits). This creates dangerous state contamination:

- Paper/shadow fills bleed into live equity and risk calculations
- Orphaned simulated positions trigger reconciliation failures on live startup
- No clean separation between test runs and real-money operations

We want execution mode to be **immutable after creation**. The path from test to live is creating a new agent via "Go Live" — a clone of the test agent's configuration with `executionMode: 'live'`.

## Requirements

1. **Execution mode is immutable** — once an agent is created, its `executionDefaults.mode` cannot be changed by any entry point (UI, API, Telegram).
2. **paper↔shadow auto-transition is preserved** — these are interchangeable test modes; the existing connection-aware upgrade/downgrade logic remains.
3. **"Go Live" creates a new agent** — copies configuration (goal, skills, risk, connections, strategy, capital, model policy, etc.) into a brand-new agent with `executionMode: 'live'`.
4. **Source agent is unaffected** — stays as-is, can keep running in parallel.
5. **No linkage** — the cloned live agent is fully independent (no `sourceAgentId` field needed).

## Background

### Current Entry Points for Mode Mutation

| Entry Point | Location | Mechanism |
|---|---|---|
| PATCH /agents/:id | `apps/api/src/routes/agents.ts` | `resolveExecutionModeForSkills()` — reads mode from `executionDefaults.mode` (nested) |
| PUT /agents/:id | `apps/api/src/routes/agent-interactivity.ts` | `resolveExecutionModeForSkills()` — reads mode from `executionMode` (top-level) |
| `/mode` command | `apps/api/src/routes/telegram-command-handlers.ts` | Calls `setExecutionMode()` directly (bypasses `resolveExecutionModeForSkills`) |
| `setExecutionMode()` | `apps/api/src/services/agent-config-service.ts` | Raw DB write of new mode |
| Connection grant/revoke side-effect | `resolveExecutionModeForSkills()` carry-forward path | Auto paper↔shadow transition |

### PATCH vs PUT Differences

| Aspect | PATCH (`agents.ts`) | PUT (`agent-interactivity.ts`) |
|--------|---------------------|-------------------------------|
| Input location | `executionDefaults.mode` (nested) | `executionMode` (top-level) |
| `executionModeProvided` | Both `executionDefaults` and `mode` must be present | Just `executionMode !== undefined` |
| Execution capability check | Yes (validates against venue type) | No |
| Status guard | Allows `stopped` or `crashed` | Only allows `stopped` |

Both routes call `resolveExecutionModeForSkills()` — the single chokepoint for immutability enforcement.

### `unifiedConfig` — Authored Config, Not Runtime State

The `unifiedConfig` JSONB column carries **authored configuration** set at creation time via `resolveUnifiedConfig()` in `agent-create-normalization.ts`. It is NOT disposable runtime state. Fields include:

| Field | Source | Purpose |
|---|---|---|
| `technical` | Strategy preset or explicit input | Scanner/candle config, filters, indicators, regime |
| `intelligence` | Explicit input | Intelligence-mode LLM config |
| `capabilityMode` | Input or default `'intelligence'` | Agent operating mode: `intelligence` / `hybrid` |
| `hybridMode` | Input or default `'mixed'` for hybrid | Scanner sub-mode: `mixed` / `scanner_gated` |
| `execution` | Preset-derived | Position sizing mode and fixed size |
| `risk` | Preset-derived | Risk overrides from preset |
| `platformAssessment` | Explicit input | Opt-in + review interval for platform assessments |
| `authorizationMode` | Explicit input or default `'direct'` | Trade authorization: `direct` / `approval_required` |
| `allowedPresets` | Explicit input | Allowed preset policy |
| `presetTransition` | Explicit input | Preset transition policy |
| `metadata` | Derived | `strategyPreset`, `skillPresetId` |

The `blueprint-projection.ts` service treats the entire column as **authored recipe** (not runtime state). The runtime write path (`persistConfig`) exists but is not currently exercised by any agent tool.

### Existing Clone-Adjacent Code We Must Reuse Safely

There is already production code that performs the two halves of "clone authored agent config":

| Concern | Location | Notes |
|---|---|---|
| Agent -> authored payload projection | `apps/api/src/services/blueprint-projection.ts` | Produces `AgentBlueprintRevisionPayload` from an agent row |
| Agent -> blueprint draft route | `apps/api/src/routes/agents.ts` (`POST /agents/:id/blueprints`) | Uses `projectAgentToBlueprintPayload()` |
| Keep agent's blueprint in sync | `apps/api/src/services/agent-blueprint-sync-service.ts` | Uses the same projection logic on agent start |
| Authored payload -> agent creation | `apps/api/src/routes/blueprints.ts` (`POST /blueprints/:blueprintId/instantiate`) | Rebuilds agent rows from blueprint payload |

"Go Live" should avoid inventing a second independent authored-payload-to-agent mapping. The safest path is to extract the existing blueprint instantiation core into a shared internal service, keep blueprint behavior unchanged, and make Go Live a thin wrapper over that shared core plus its agent-specific rules.

### Current Normalization Boundary

The existing `prepareAgentCreateFields()` / `resolveUnifiedConfig()` pipeline does **not** currently accept every authored `unifiedConfig` subtree as an explicit input. Today it directly models:

- `technical`
- `strategyPreset`
- `capabilityMode`
- `hybridMode`
- `platformAssessment`
- `authorizationMode`
- `skillPresetId`

Additional authored subtrees such as `intelligence`, `executionPolicy`, `allowedPresets`, and `presetTransition` are still part of the persisted authored recipe and must not be dropped during clone.

### Key Design Decisions

- The `resolveExecutionModeForSkills()` function is the central chokepoint for PATCH/PUT/chat-based paths.
- The `setExecutionMode()` service is used by Telegram and is the only path that bypasses `resolveExecutionModeForSkills()`.
- paper↔shadow is NOT considered a mode change for the purpose of this feature — both are "test" modes.
- `unifiedConfig` must be carried over during clone — it is authored config, not runtime state.
- "Go Live" must go through the existing agent creation pipeline (validation, normalization, skill selectability, plan limits) rather than raw column copying.
- `prepareAgentCreateFields()` covers config normalization, not the entire create pipeline. Name validation and skill selectability must still run as explicit steps, and authored `unifiedConfig` subtrees not yet modeled by that helper must still be preserved.
- Do not break existing blueprint behavior. Extract the shared authored-payload-to-agent creation core from the blueprint instantiate path first, keep blueprint route behavior byte-for-byte equivalent where intended, then add Go Live as a separate wrapper.

## Proposed Solution

### Part A: Mode Immutability

Add a guard in `resolveExecutionModeForSkills()` that rejects explicit mode changes (excluding paper↔shadow auto-transition). Remove `setExecutionMode()`.

**Concretely:**
1. In `resolveExecutionModeForSkills()`: when `executionModeProvided === true` and `currentExecutionMode` exists, reject if the submitted mode crosses the test/live boundary (i.e., reject paper→live, shadow→live, live→paper, live→shadow).
2. Delete the `setExecutionMode()` function from `agent-config-service.ts`.
3. Update the Telegram `/mode` command handler to become read-only and inform users about `/golive`.
4. Update all Telegram help text and usage strings to reflect the change.

### Part B: "Go Live" (Clone as Live)

A new API endpoint that clones a test agent's config into a new live agent.

**Endpoint:** `POST /agents/:id/go-live`

**Architecture:** extract a shared internal authored-payload-to-agent creation service from the existing blueprint instantiate flow, then add Go Live as a thin wrapper over that service.

**Shared-core rule:**
- First refactor the code in `apps/api/src/routes/blueprints.ts` that turns an `AgentBlueprintRevisionPayload` into a stopped agent row into an internal service or helper module.
- Make `POST /blueprints/:blueprintId/instantiate` call that new shared service with no intended behavior change.
- Only after the blueprint route is using the extracted shared core should `cloneAgentAsLive()` be added as a second caller.
- Go Live must not call the public blueprint route end-to-end and must not create blueprint attribution or usage side effects.

**Fields carried over from source agent:**

| Category | Fields | Notes |
|---|---|---|
| Identity | `name` (suffixed " (Live)"), `prompt`, `style` | Name is re-validated by the create pipeline |
| Config | `unifiedConfig` (full authored recipe), `executionDefaults` (with mode overridden to `'live'`), `strategy`, `risk` | `unifiedConfig` carry-over includes `technical`, `intelligence`, `capabilityMode`, `hybridMode`, `executionPolicy`, `allowedPresets`, `presetTransition`, `platformAssessment`, `authorizationMode`, and `metadata` when present |
| Policies | `toolPolicy`, `modelPolicy`, `runtimePolicyOverrides`, `wakePreferences` | Portable authored config |
| Limits | `capital`, `maxBots`, `tickIntervalMs` | Re-validated against plan ceilings |
| UX | `openPositionEscalationToJudgePolicy`, `notificationPolicy`, `telegramChatId` | Portable |
| Relationships | `agent_skills` rows, active `agent_connections` rows | Copied with new IDs |

**Fields excluded:**

| Field | Reason |
|---|---|
| `riskOverrides` | Runtime agent-adjusted state, not authored |
| `pauseState` | Instance lifecycle state |
| `status` | New agent starts `stopped` |
| `blueprintId`, `blueprintRevisionId` | Attribution is per-instance |

**Response:** `201 Created` with the new agent object.

## Task Breakdown

### Task 1: Guard mode changes in `resolveExecutionModeForSkills()`

**Objective:** Prevent explicit execution mode changes that cross the test/live boundary.

**Implementation guidance:**
- In `apps/api/src/routes/agent-config-helpers.ts`, modify `resolveExecutionModeForSkills()`.
- When `executionModeProvided === true` AND `currentExecutionMode` is non-null:
  - Normalize both values.
  - Define test modes as `paper` and `shadow`, live mode as `live`.
  - If current is test and submitted is `live` → return issue.
  - If current is `live` and submitted is test → return issue.
  - If both are test modes (paper↔shadow) → allow.
  - If current equals submitted → allow (no-op).
- The existing paper↔shadow auto-transition in the carry-forward path (when `executionModeProvided === false`) remains unchanged.
- Error message: `"Execution mode cannot be changed after creation. Use 'Go Live' to create a live agent from this configuration."`

**Test requirements:**
- Unit tests in `agent-config-helpers.test.ts`:
  - Rejects paper→live when currentExecutionMode is paper.
  - Rejects shadow→live when currentExecutionMode is shadow.
  - Rejects live→paper when currentExecutionMode is live.
  - Rejects live→shadow when currentExecutionMode is live.
  - Allows paper→shadow (test↔test explicit change).
  - Allows shadow→paper (test↔test explicit change).
  - Allows paper→paper (no-op).
  - Allows shadow→shadow (no-op).
  - Allows live→live (no-op).
  - Allows paper↔shadow auto-transition when `executionModeProvided` is false (carry-forward path unchanged).
  - Allows creation path (currentExecutionMode is null/undefined, any mode accepted).

**Demo:** After this task, attempting to PATCH or PUT an agent with a different execution mode tier returns a 400 validation error. The primary UI path (PATCH) and the chat-based path (PUT) are both protected.

---

### Task 2: Remove `setExecutionMode()` and update Telegram `/mode` handler and help text

**Objective:** Remove the direct mode-write path, make `/mode` read-only, and align all Telegram help text.

**Implementation guidance:**

*Remove `setExecutionMode()`:*
- Delete `setExecutionMode()` from `apps/api/src/services/agent-config-service.ts`.
- Remove its export and any barrel re-exports.

*Update `/mode` handler in `telegram-command-handlers.ts`:*
- Remove the import of `setExecutionMode`.
- When a mode argument is provided, respond with:
  `"Execution mode cannot be changed after creation. Use /golive <agent> to create a live copy of this agent's configuration."`
- Keep the read-only path (show current mode) unchanged.
- The `/mode` command keeps its optional arg syntax purely so the rejection message can fire — it is syntactically read-only.

*Update help text in `telegram-slash-commands.ts`:*
- Update the `COMMAND_HELP` entry for `mode` (line ~153):
  - Change description from `'Show or set execution mode'` to `'Show execution mode'`.
  - Change syntax from `'/mode <agent> [mode]'` to `'/mode <agent>'`.
- Update the `DETAILED_HELP` entry for `mode` (lines ~253-263):
  - Remove the "With a mode: sets the execution mode" line.
  - Remove the "Accepted modes: test, paper, shadow..." line.
  - Remove set examples (`/mode Momentum test`, `/mode Momentum live`).
  - Add note: `"To switch to live trading, use /golive <agent>."`
- Add a new `COMMAND_HELP` entry for `golive` (in the `config` category):
  - syntax: `'/golive <agent>'`
  - description: `'Create a live copy of a test agent'`
- Add a new `DETAILED_HELP` entry for `golive` with usage info.

*Update integration tests:*
- Update `__tests__/webhook/telegram-slash-commands.integration.test.ts` to verify rejection when mode arg is provided.

**Test requirements:**
- Unit test: providing a mode arg to `/mode` returns the rejection message.
- Unit test: read-only display of current mode still works.
- Integration test: verify updated rejection behavior.
- Verify help text for `/mode` no longer mentions setting mode.
- Verify help text for `/golive` is present.

**Demo:** `/mode MyAgent live` returns a user-friendly message saying mode cannot be changed, with guidance to use `/golive`. `/help mode` shows read-only documentation. `/help golive` shows the new command.

---

### Task 3: Extract shared `cloneAgentAsLive()` service and implement `POST /agents/:id/go-live`

**Objective:** Create the "Go Live" API endpoint using the existing agent creation pipeline.

**Implementation guidance:**

*Step 3A — Extract the shared authored-payload creation core from blueprint instantiate first:*

- Identify the existing agent-instantiation block inside `apps/api/src/routes/blueprints.ts` that maps `AgentBlueprintRevisionPayload` to the inserted `agents` row.
- Move that authored-payload-to-agent creation logic into a dedicated internal service/helper, for example:
  - `apps/api/src/services/agent-authored-instantiation-service.ts`, or
  - a similarly-scoped helper module under `services/`.
- The extracted service should accept authored payload plus caller-supplied context and return enough data for both callers:
  - inserted agent row or inserted agent ID
  - resolved `agent_skills` assignments inserted
  - final `unifiedConfig` / `risk` / `executionDefaults` used for persistence if needed by tests
- The blueprint instantiate route remains responsible for blueprint-only concerns:
  - publication and access checks
  - idempotency keys and replay semantics
  - blueprint attribution fields (`blueprintId`, `blueprintRevisionId`)
  - blueprint usage events
- The extracted service must have **no** blueprint side effects on its own.

*Step 3B — Make blueprint instantiate use the extracted core with no behavior change:*

- Replace the inline agent creation block in `apps/api/src/routes/blueprints.ts` with a call to the extracted service.
- Preserve current blueprint instantiate behavior exactly:
  - same response status / payload
  - same attribution fields
  - same skill pinning behavior
  - same idempotency behavior
  - same unifiedConfig mapping semantics

*Step 3C — Add Go Live as a thin wrapper over the extracted core:*

*Service layer — new file `apps/api/src/services/agent-go-live-service.ts`:*

Extract a `cloneAgentAsLive()` function that:
1. Loads source agent + verifies ownership (`userId`).
2. Validates source mode is paper or shadow (400 if already live).
3. Loads source agent's active connections (`agent_connections` with status `active`) and skill assignments (`agent_skills`).
4. Validates at least one active connection exists (required for live mode).
5. Projects the source agent into an authored payload using the existing shared projection logic (`projectAgentToBlueprintPayload()` or an extracted equivalent), then applies Go Live-specific transformations on that payload:
   - set `executionDefaults.mode = 'live'`
   - override `name` to `source name + " (Live)"` unless caller provides a custom name
   - ensure blueprint attribution is **not** carried over
6. Re-runs the non-blueprint create-time validation responsibilities that Go Live still owns:
   - request/schema validation for any name override
   - skill selectability resolution via `resolveSkillAssignmentsForUser()`
   - config normalization/validation via `prepareAgentCreateFields()` for helper-supported config
   - plan enforcement via `checkLiveEnabled()` and `checkAgentLimit()`
7. Preserves **all** authored `unifiedConfig` subtrees from the source agent. For fields already modeled by `PrepareAgentCreateFieldsParams`, feed them through the shared normalization path. For authored subtrees that are not yet modeled there (`intelligence`, `executionPolicy`, `allowedPresets`, `presetTransition` today), either extend the helper interfaces to accept them or merge them back after validation. No authored config may be dropped.
8. Calls the extracted authored-payload-to-agent creation core to create the new stopped agent row, while Go Live separately handles agent-only/private fields that blueprints intentionally do not carry (active `agent_connections`, `notificationPolicy`, `telegramChatId`).
9. Copies active `agent_connections` rows to the new agent with fresh IDs.
10. Returns the new agent.

*Route layer — in `apps/api/src/routes/agents.ts`:*

Add `POST /agents/:id/go-live`:
- Request body: `{ name?: string }` (optional name override), validated with the same name schema/rules as POST `/agents`.
- Calls `cloneAgentAsLive()`.
- Returns `201 Created` with the same response shape as POST `/agents`: `decorateAgentResponse(...)`, `enrichAgentResponse(...)`, and `riskContract`.
- Error cases: 404 (not found), 400 (already live, no connections, validation errors), 403 (plan doesn't allow live, agent limit exceeded).

**Test requirements:**
- Unit/integration tests:
  - Refactor safety: existing `POST /blueprints/:blueprintId/instantiate` tests continue to pass unchanged after extraction.
  - Successfully clones a paper agent as live — verify new agent has `mode: 'live'`, same skills, same connections, and all authored `unifiedConfig` fields from the source.
  - Successfully clones a shadow agent as live.
  - Cloned agent has `style` and `openPositionEscalationToJudgePolicy` from source.
  - When the source has `intelligence`, `executionPolicy`, `allowedPresets`, or `presetTransition` in `unifiedConfig`, the clone preserves them.
  - Rejects when source agent is already live (400).
  - Rejects when source agent not found (404).
  - Rejects when user plan doesn't allow live (403).
  - Rejects when no active connections on source (400).
  - Rejects when agent limit exceeded (403).
  - New agent starts in `stopped` status.
  - New agent has independent ID, fresh timestamps.
  - New agent does NOT carry `riskOverrides` or `pauseState` from source.
  - Source agent is unchanged after clone.
  - Name override works (`{ name: "My Custom Name" }`).
  - Name length validation applies (name + " (Live)" suffix does not exceed limit).
  - Skill selectability checks apply — if a source skill has been revoked/unpublished, clone fails with clear error.
  - maxBots ceiling from user plan is respected.
  - Scanner-gated agent clones correctly with full technical config preserved.
  - Route response shape matches POST `/agents` response shape, including unifiedConfig-derived fields and `riskContract`.

*Blueprint-regression tests to add or strengthen as part of this task:*
- In `apps/api/src/routes/blueprints.integration.test.ts`:
  - add a regression test that instantiating an agent blueprint preserves authored payload fields that are easy to lose during extraction: `intelligence`, `executionPolicy`, `allowedPresets`, `presetTransition`, `platformAssessment`, `authorizationMode`, `wakePreferences`, and `openPositionEscalationToJudgePolicy`.
  - keep the existing deterministic-copy and idempotency tests passing after extraction.
- In `apps/api/src/services/blueprint-projection.test.ts`:
  - add or strengthen projection tests for fields that Go Live will rely on from authored payload projection: `intelligence`, `executionPolicy`, `allowedPresets`, `presetTransition`, `platformAssessment`, `authorizationMode`, and `wakePreferences`.
- If the shared authored-payload creation core becomes a new service file:
  - add unit tests for that service covering agent-row creation from a rich `AgentBlueprintRevisionPayload`.
  - verify blueprint-only concerns are *not* handled there (no attribution or usage-event side effects inside the shared core).

**Demo:** `POST /agents/:id/go-live` creates a new live agent, visible in the agent list, startable immediately. The agent has the same technical config, strategy, and capabilities as the source.

---

### Task 4: Add Telegram `/golive` command

**Objective:** Expose "Go Live" via Telegram for users who manage agents through chat.

**Implementation guidance:**
- Add a `/golive <agent name>` handler in `telegram-command-handlers.ts`.
- Resolves agent by name (same pattern as existing commands — handle not_found and ambiguous).
- Calls the shared `cloneAgentAsLive()` service function from Task 3.
- Returns a success message with the new live agent's name and ID, or an error message.
- Error messages should be user-friendly:
  - Already live: `"<name> is already in live mode."`
  - No connections: `"<name> has no active connections. Grant a connection first."`
  - Plan doesn't allow live: `"Live mode is not available on your plan."`
  - Agent limit exceeded: `"Cannot create live agent — agent limit reached."`

**Test requirements:**
- Unit test: successfully clones and returns success message.
- Unit test: rejects if agent is already live.
- Unit test: rejects if agent has no connections.
- Unit test: handles ambiguous agent names.
- Unit test: handles agent not found.

**Demo:** `/golive MyTestAgent` responds with `"Created live agent 'MyTestAgent (Live)' — ready to start with /start MyTestAgent (Live)"`

---

### Task 5: End-to-end verification and edge case coverage

**Objective:** Verify the full flow works correctly across all entry points with no regressions.

**Implementation guidance:**

*Blueprint regression before/alongside Go Live:*

1. Run and keep passing the existing blueprint instantiate and blueprint projection test suites while doing the extraction.
2. Add explicit regression coverage for the extracted shared core before switching Go Live onto it.
3. Confirm `POST /agents/:id/blueprints` projection behavior remains unchanged.

*Functional test (in `apps/api/src/__tests__/functional/`):*

Test the complete mode immutability + Go Live flow:
1. Create agent in paper mode via POST.
2. Attempt to change mode to live via **PATCH** `/agents/:id` → 400 with immutability error.
3. Attempt to change mode to live via **PUT** `/agents/:id` → 400 with immutability error.
4. Attempt `/mode AgentName live` via Telegram → rejection message.
5. Call `POST /agents/:id/go-live` → 201, new live agent created.
6. Verify source agent still in paper mode and unchanged.
7. Verify new agent in live mode, stopped, same config (including all authored `unifiedConfig` fields and the same response-shape enrichments returned by POST `/agents`).
8. Attempt to change the new live agent's mode to paper via PATCH → 400.
9. Attempt to change the new live agent's mode to shadow via PUT → 400.

Test paper↔shadow auto-transition regression:
1. Create agent in paper mode with no connections.
2. Grant a connection → verify next PATCH (without explicit mode) resolves to shadow.
3. Revoke connection → verify next PATCH (without explicit mode) resolves back to paper.
4. Verify explicit paper→shadow and shadow→paper via PATCH both succeed (test↔test allowed).

Test `/golive` Telegram flow:
1. `/golive TestAgent` → success, new live agent.
2. `/golive LiveAgent` (already live) → rejection.
3. `/golive NonExistent` → not found.

**Test requirements:**
- Functional integration test covering the complete flow with both PATCH and PUT paths.
- Regression test for paper↔shadow auto-transition.
- Telegram `/golive` functional test.
- Verify `/help mode` output no longer mentions setting mode.
- Verify `/help golive` output is present and correct.
- Blueprint instantiate regression tests remain green after the shared-core extraction.
- Blueprint projection tests cover the authored fields used by Go Live.
- If `POST /agents/:id/blueprints` has route-level tests already, keep them green; otherwise add a focused regression test for the projection route if the extraction touches its shared projection helper usage.

**Demo:** Full end-to-end flow from paper agent creation through "Go Live" to live agent start, with mode-change attempts correctly rejected at every step via PATCH (primary UI path), PUT (chat-based path), and Telegram.
