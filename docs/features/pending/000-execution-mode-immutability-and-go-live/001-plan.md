# Execution Mode Immutability & "Go Live" Clone

## Problem Statement

Users can currently change an agent's execution mode (paper/shadow/live) after creation via multiple entry points (API PUT, Telegram `/mode` command, chat-based edits). This creates dangerous state contamination:

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
| PUT /agents/:id | `apps/api/src/routes/agent-interactivity.ts` | `resolveExecutionModeForSkills()` can resolve a different mode if caller submits one |
| `/mode` command | `apps/api/src/routes/telegram-command-handlers.ts` | Calls `setExecutionMode()` directly |
| `setExecutionMode()` | `apps/api/src/services/agent-config-service.ts` | Raw DB write of new mode |
| Connection grant/revoke side-effect | `resolveExecutionModeForSkills()` carry-forward path | Auto paper↔shadow transition |

### Key Design Decisions

- The `resolveExecutionModeForSkills()` function is the central chokepoint for form/chat-based paths.
- The `setExecutionMode()` service is used by Telegram and is the only path that bypasses `resolveExecutionModeForSkills()`.
- paper↔shadow is NOT considered a mode change for the purpose of this feature — both are "test" modes.

## Proposed Solution

### Part A: Mode Immutability

Add a guard in `resolveExecutionModeForSkills()` that rejects explicit mode changes (excluding paper↔shadow auto-transition). Remove or repurpose `setExecutionMode()`.

**Concretely:**
1. In `resolveExecutionModeForSkills()`: when `executionModeProvided === true` and `currentExecutionMode` exists, reject if the submitted mode crosses the test/live boundary (i.e., reject paper→live, shadow→live, live→paper, live→shadow).
2. Delete the `setExecutionMode()` function from `agent-config-service.ts`.
3. Update the Telegram `/mode` command handler to become read-only (display current mode, remove the set capability) and inform users to use "Go Live" instead.

### Part B: "Go Live" (Clone as Live)

A new API endpoint that clones a test agent's config into a new live agent.

**Endpoint:** `POST /agents/:id/go-live`

**Behavior:**
1. Load source agent (must belong to requesting user).
2. Validate source agent is in paper or shadow mode.
3. Validate user plan has `liveEnabled: true`.
4. Validate source agent has active connections (required for live mode).
5. Validate agent limit not exceeded.
6. Create a new agent with:
   - Same: name (suffixed with " (Live)"), prompt, skills, connections, risk config, strategy, capital, model policy, tool policy, runtime policy overrides, tick interval, max bots, wake preferences, notification policy, telegram chat ID.
   - Changed: `executionDefaults.mode = 'live'`, fresh `id`, `status = 'stopped'`, `createdAt/updatedAt = now`.
   - Excluded: `unifiedConfig` (runtime-only state), `riskOverrides` (agent-adjusted runtime state), `pauseState`.
7. Copy `agent_skills` rows for the new agent.
8. Copy active `agent_connections` rows for the new agent.
9. Return the new agent.

**Response:** `201 Created` with the new agent object.

## Task Breakdown

### Task 1: Guard mode changes in `resolveExecutionModeForSkills()`

**Objective:** Prevent explicit execution mode changes that cross the test/live boundary.

**Implementation guidance:**
- In `apps/api/src/routes/agent-config-helpers.ts`, modify `resolveExecutionModeForSkills()`.
- When `executionModeProvided === true` AND `currentExecutionMode` is non-null:
  - Normalize both values.
  - If current is `'live'` and submitted is `'paper'` or `'shadow'` → return issue.
  - If current is `'paper'` or `'shadow'` and submitted is `'live'` → return issue.
  - If current is `'paper'` and submitted is `'shadow'` (or vice versa) → allow (test↔test).
  - If current equals submitted → allow (no-op).
- The existing paper↔shadow auto-transition in the carry-forward path (when `executionModeProvided === false`) remains unchanged.
- Error message: `"Execution mode cannot be changed after creation. Use 'Go Live' to create a live agent from this configuration."`

**Test requirements:**
- Unit tests in `agent-config-helpers.test.ts`:
  - Rejects paper→live when currentExecutionMode is paper.
  - Rejects shadow→live when currentExecutionMode is shadow.
  - Rejects live→paper when currentExecutionMode is live.
  - Rejects live→shadow when currentExecutionMode is live.
  - Allows paper→shadow (test↔test).
  - Allows shadow→paper (test↔test).
  - Allows paper→paper (no-op).
  - Allows shadow→shadow (no-op).
  - Allows live→live (no-op).
  - Allows paper↔shadow auto-transition when executionModeProvided is false (carry-forward path unchanged).

**Demo:** After this task, attempting to PUT an agent with a different execution mode tier returns a 400 validation error.

---

### Task 2: Remove `setExecutionMode()` and update Telegram `/mode` handler

**Objective:** Remove the direct mode-write path and make `/mode` read-only.

**Implementation guidance:**
- Delete `setExecutionMode()` from `apps/api/src/services/agent-config-service.ts`.
- Remove the export from the service barrel/index.
- Update `apps/api/src/routes/telegram-command-handlers.ts`:
  - Remove the import of `setExecutionMode`.
  - Change the `/mode` handler: if a mode argument is provided, respond with a message explaining that mode cannot be changed and suggest using "Go Live" from the web app.
  - Keep the read-only path (show current mode).
- Update any integration tests that exercise mode-set via Telegram to verify the new rejection behavior.

**Test requirements:**
- Unit test for Telegram handler: providing a mode arg returns the rejection message.
- Unit test for Telegram handler: read-only display of current mode still works.
- Verify the integration test in `__tests__/webhook/telegram-slash-commands.integration.test.ts` is updated.

**Demo:** `/mode MyAgent live` returns a user-friendly message saying mode cannot be changed, with guidance to use "Go Live".

---

### Task 3: Implement `POST /agents/:id/go-live` endpoint

**Objective:** Create the "Go Live" API endpoint that clones a test agent as a new live agent.

**Implementation guidance:**
- Add the route in `apps/api/src/routes/agents.ts` (or a new `apps/api/src/routes/agent-go-live.ts` if cleaner).
- Request body: empty (all config comes from the source agent). Optionally accept `{ name?: string }` to override the cloned name.
- Steps:
  1. Load source agent + verify ownership (`userId`).
  2. Validate source mode is paper or shadow (400 if already live — "Agent is already in live mode").
  3. Check plan entitlements: `checkLiveEnabled(plansConfig, userPlanId, isAdmin)`.
  4. Check agent limit: `checkAgentLimit(...)`.
  5. Load source agent's active connections and skill assignments.
  6. Validate at least one active connection exists (required for live mode).
  7. Generate new agent ID.
  8. Insert new agent row copying relevant fields, setting `executionDefaults: { ...sourceExecDefaults, mode: 'live' }`.
  9. Copy `agent_skills` rows with new `agentId`.
  10. Copy active `agent_connections` rows with new `agentId` and new row IDs.
  11. Return the new agent via `decorateAgentResponse(...)`.
- HTTP status: 201 on success.
- Error cases: 404 (not found), 400 (already live, no connections, validation errors), 403 (plan doesn't allow live).

**Test requirements:**
- Unit/integration tests:
  - Successfully clones a paper agent as live — verify new agent has `mode: 'live'`, same skills, same connections.
  - Successfully clones a shadow agent as live.
  - Rejects when source agent is already live (400).
  - Rejects when source agent not found (404).
  - Rejects when user plan doesn't allow live (403).
  - Rejects when no active connections on source (400).
  - Rejects when agent limit exceeded (403).
  - New agent starts in `stopped` status.
  - New agent has independent ID, fresh timestamps.
  - Source agent is unchanged after clone.

**Demo:** `POST /agents/:id/go-live` creates a new live agent, visible in the agent list, startable immediately.

---

### Task 4: Add Telegram `/golive` command

**Objective:** Expose "Go Live" via Telegram for users who manage agents through chat.

**Implementation guidance:**
- Add a `/golive <agent name>` handler in `telegram-command-handlers.ts`.
- Resolves agent by name (same pattern as existing commands).
- Calls the same service logic used by the API endpoint (extract into a shared service function if not already).
- Returns a success message with the new live agent's name and ID, or an error message.

**Test requirements:**
- Unit test: successfully clones and returns success message.
- Unit test: rejects if agent is already live.
- Unit test: rejects if agent has no connections.
- Unit test: handles ambiguous agent names.

**Demo:** `/golive MyTestAgent` responds with "Created live agent 'MyTestAgent (Live)' — ready to start."

---

### Task 5: End-to-end verification and edge case coverage

**Objective:** Verify the full flow works correctly across all entry points with no regressions.

**Implementation guidance:**
- Write a functional test (in `apps/api/src/__tests__/functional/`) that exercises:
  1. Create agent in paper mode.
  2. Attempt to update execution mode to live via PUT → 400.
  3. Attempt `/mode AgentName live` via Telegram → rejection message.
  4. Call `POST /agents/:id/go-live` → 201, new live agent created.
  5. Verify source agent still in paper mode, still running if it was running.
  6. Verify new agent in live mode, stopped, same config.
  7. Attempt to change the new live agent's mode to paper → 400.
- Verify paper↔shadow auto-transition still works:
  1. Create agent in paper mode with no connections.
  2. Grant a connection → agent's mode resolves to shadow on next config read.
  3. Revoke connection → agent's mode resolves back to paper.

**Test requirements:**
- Functional integration test covering the complete flow.
- Regression test for paper↔shadow auto-transition.

**Demo:** Full end-to-end flow from paper agent creation through "Go Live" to live agent start, with mode-change attempts correctly rejected at every step.
