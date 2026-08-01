## Plan: Wire Preset Tool Ports into Agent Containers

**Status:** Ready for implementation
**Scope:** Wire `AssessmentRequestPort` and `PresetTransitionPort` into agent containers so `assess_strategy_preset` and `change_strategy_preset` work end-to-end, plus tests to prevent regression.

**TL;DR:** Both preset tools are fully implemented and wired in the worker process (`index.ts`) but return `"Assessment request port not available"` in agent containers (`agent.ts`) because the module-level ports are never set. Agents are actively calling these tools (13 calls observed, all failing). This plan wires the ports in the agent container and adds tests to verify the wiring stays intact.

---

## Current Code Truth (verified)

Do not re-diagnose these. They are confirmed facts about the code as it exists today.

1. **`assess_strategy_preset` uses a module-level `port` variable.** Defined at `apps/worker/src/tools/assess-strategy-preset.ts:16`: `let port: AssessmentRequestPort | null = null;`. Set via `setAssessmentRequestPort()` (line 22). When `port` is `null`, the tool returns `"Assessment request port not available. Assessments will be available once the service is deployed."` (errorCode: `assessment.service_unavailable`) — see the fallback block at lines ~200-215.

2. **`change_strategy_preset` uses the same pattern.** Defined at `apps/worker/src/tools/change-strategy-preset.ts:17`: `let port: PresetTransitionPort | null = null;`. Set via `setPresetTransitionPort()` (line 23). When `port` is `null`, the tool returns an appropriate error.

3. **The worker process wires both ports.** In `apps/worker/src/index.ts`:
   - Line 75: `import { setAssessmentRequestPort } from './tools/assess-strategy-preset.js';`
   - Line 76: `import { setPresetTransitionPort } from './tools/change-strategy-preset.js';`
   - Line 2365: `setAssessmentRequestPort(assessmentRequestService);`
   - Line 2475: `setPresetTransitionPort(presetTransitionService);`

4. **The agent container does NOT wire either port.** `apps/worker/src/agent.ts` imports neither `setAssessmentRequestPort` nor `setPresetTransitionPort`. A grep for both function names in `agent.ts` returns zero results.

5. **The agent container already has the dependencies needed to construct these services.** `agent.ts` already initializes: `db` (Postgres), `redis` (Redis), `marketDataConfig` (parsed from `MARKET_DATA_CONFIG_JSON`), `providersYaml` (forwarded by worker), `usageBillingService`, `agentRepo`, `llmArtifactRepo`, `instrumentRepo`. The `agentRuntimeConfigJson` and `marketDataConfigJson` are passed as env vars from the worker.

6. **`AssessmentRequestService` constructor requires:** `db` (Database), `usageBillingRepo` (UsageBillingRepository), `platformAssessorConfig` (PlatformAssessorConfig), `platformAssessor` (PlatformAssessor). See `apps/worker/src/market-intelligence/assessment-request-service.ts`.

7. **`PresetTransitionService` constructor requires:** `db` (Database), `notifyActor` callback. See `apps/worker/src/market-intelligence/index.ts`. The `notifyActor` callback in the worker calls `actorRegistry.get(agentId)` to find the running actor and apply config updates. In the agent container, there is no `actorRegistry` — the agent IS the actor.

8. **`PlatformAssessor` is heavy.** It requires: `PlatformAssessorConfig`, `providersBaseUrlMap`, `db`, `redisClient`, `evidencePorts`, `getPresets` (preset catalog), and makes LLM calls. Constructing this inside every agent container would be expensive and duplicate the worker's singleton.

9. **The existing tests treat "not wired" as expected behavior.** `assess-strategy-preset.test.ts:76` has a test titled `'returns service unavailable when AssessmentRequestPort is not wired'` that asserts `result.data.results[0]?.errorCode === 'assessment.service_unavailable'` and passes. This test validates the fallback path rather than flagging it as a gap.

10. **Agent containers already use broker-mediated execution for some tools.** The agent's `submit_decision` goes through the broker (`AgentMessageBroker` → `AgentDecisionHandler`) rather than executing directly in-process. This pattern could be extended to preset tools.

---

## Design Decision

**Broker-mediated execution is the correct approach for both tools.**

Rationale:
- `AssessmentRequestPort` depends on `PlatformAssessor` which makes LLM calls — constructing this per-agent-container is wasteful and duplicates the worker's singleton
- `PresetTransitionPort` depends on `notifyActor` which needs access to the `actorRegistry` — the agent container has no actor registry (it IS the actor)
- The broker already handles similar patterns (`submit_decision` goes through `AgentDecisionHandler`)
- This avoids the architectural complexity of replicating heavy service construction in every agent container
- It keeps the preset tools' business logic centralized in the worker, where it already lives and is tested

The tools will publish requests to Redis (via the existing agent outbound stream), the worker's broker picks them up, executes them against the wired ports, and publishes results back to the agent's inbound stream.

---

## Goals

1. `assess_strategy_preset` returns real assessment results (not `"service_unavailable"`) when called by agents
2. `change_strategy_preset` can apply preset transitions when called by agents with valid assessment artifacts
3. Agent containers do NOT construct `PlatformAssessor` or `PresetTransitionService` — the worker handles these
4. Tests verify the end-to-end flow: agent calls tool → broker mediates → worker executes → result returns
5. Existing unit tests for tool logic continue to pass (they test the tool in isolation with mock ports)
6. A new integration/functional test verifies the wiring stays intact across code changes

## Non-Goals

- Do **not** change the tool contracts (`assess_strategy_preset` and `change_strategy_preset` parameter/response schemas)
- Do **not** change how the worker constructs or wires `AssessmentRequestService` or `PresetTransitionService`
- Do **not** modify the scheduled review scheduler or the manual review runner
- Do **not** add new operator config knobs
- Do **not** change the agent container's Docker image or build process

---

## Proposed Changes

### Change 1 — Add broker message types for preset tool requests and responses

**Files:**
- `packages/domain/src/agent-message-types.ts` (or wherever `AGENT_MESSAGE_TYPES` is defined)

**What:**
Define two new message type pairs:
- `agent.tool.assess_strategy_preset.request` / `agent.tool.assess_strategy_preset.response`
- `agent.tool.change_strategy_preset.request` / `agent.tool.change_strategy_preset.response`

The request payload carries the tool parameters. The response payload carries the tool result.

### Change 2 — Modify preset tools in agent container to publish requests via Redis

**Files:**
- `apps/worker/src/tools/assess-strategy-preset.ts`
- `apps/worker/src/tools/change-strategy-preset.ts`

**What:**
When `port === null` (agent container context), instead of returning `"service_unavailable"`, the tool:
1. Publishes a request message to the agent's Redis outbound stream
2. Waits for a response on the agent's inbound stream (with timeout)
3. Returns the response as the tool result

When `port !== null` (worker context), the tool continues to use the port directly (unchanged behavior for existing worker-side callers like `ManualReviewRunner`).

The agent container already has `redis` and uses Redis streams for inbound/outbound messaging — this reuses the existing transport.

### Change 3 — Add broker handlers for preset tool requests

**Files:**
- `apps/worker/src/agents/agent-message-broker.ts`

**What:**
`AgentMessageBroker` already handles various message types. Add handlers for the two new request types that:
1. Call `assess_strategy_preset` / `change_strategy_preset` directly via their `execute()` functions (the ports are already wired in the worker process)
2. Publish the result back to the agent's inbound stream

### Change 4 — Add agent container initialization test for tool port wiring

**Files:**
- `apps/worker/src/agent-preset-tool-wiring.test.ts` (new file)

**What:**
A test that:
1. Mocks the agent container's Redis, DB, and config dependencies
2. Calls the agent initialization path (tool registry creation)
3. Verifies that `assess_strategy_preset` and `change_strategy_preset` are in the tool registry
4. Calls each tool with valid parameters and verifies they produce a non-`service_unavailable` response (the request goes to the mock Redis stream)
5. Asserts the correct broker message types are published

This test acts as a canary — if someone removes the broker mediation wiring, the test fails.

### Change 5 — Add integration test for end-to-end preset tool flow

**Files:**
- `apps/worker/src/__tests__/preset-tool-broker-integration.test.ts` (new file)

**What:**
An integration test that:
1. Sets up a real Redis instance and DB
2. Constructs the broker with wired ports
3. Simulates an agent calling `assess_strategy_preset` with real symbols
4. Verifies the broker receives the request, executes it, and returns a result
5. Verifies that `market_assessment_requests` rows are created (if the assessment succeeds)
6. Tests the full round-trip: agent → broker → port → broker → agent

### Change 6 — Update existing unit test expectations

**Files:**
- `apps/worker/src/tools/assess-strategy-preset.test.ts`
- `apps/worker/src/tools/change-strategy-preset.test.ts`

**What:**
The existing test `'returns service unavailable when AssessmentRequestPort is not wired'` should either:
- (a) Be updated to verify the broker-mediated path is triggered instead, OR
- (b) Be renamed/reframed to clarify it tests the direct-port path (worker context) and a separate test covers the broker-mediated path (agent context)

Option (b) is preferred — keep the existing test for the worker-context code path, add a new test for the agent-context code path.

---

## Implementation Order

| Step | Change | Depends On | Verifies |
|------|--------|------------|----------|
| 1 | Add broker message types (Change 1) | — | TypeScript compiles |
| 2 | Add broker handlers (Change 3) | Change 1 | Existing broker tests pass |
| 3 | Modify preset tools to broker-mediate (Change 2) | Change 1, 3 | Existing tool unit tests pass |
| 4 | Add agent wiring test (Change 4) | Change 2 | Test passes |
| 5 | Add integration test (Change 5) | Change 2, 3 | Test passes |
| 6 | Update existing test expectations (Change 6) | Change 2 | All existing tests pass |
| 7 | Run full test suite + lint | All | `pnpm test && pnpm lint` passes |
| 8 | Deploy to staging, verify agents can assess presets | All | `assess_strategy_preset` returns real results |

---

## Rollback Plan

If the broker-mediated approach causes issues in staging:
1. The tools already return `"service_unavailable"` as the fallback when the broker is unreachable — this is the current behavior, so the degradation path is identical to today
2. The `port !== null` fast path for worker-context callers is unchanged
3. To fully roll back: revert the agent container changes (Change 2) — the tools go back to `"service_unavailable"`, which is the pre-fix state
