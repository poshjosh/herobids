# Review: Agent Runtime Loop Controls

## Verdict

Partially implemented, with one correctness issue.

The branch adds the new config surface in [packages/domain/src/config/schema.ts](../../../../packages/domain/src/config/schema.ts), documents it in [config/default.yaml](../../../../config/default.yaml), and threads some values into [apps/worker/src/agent.ts](../../../../apps/worker/src/agent.ts). But the controlling runtime path still uses hardcoded constants for scout/judge turn limits and wake timing in the actual scheduling and loop execution paths.

## Findings

1. Critical: the configured scout and judge `maxTurns` values are not the values the loops actually use.
   In [apps/worker/src/agent.ts](../../../../apps/worker/src/agent.ts), the `runStructuredToolLoop()` calls include both configured `maxTurns` entries and the older `SCOUT_MAX_TURNS` / `JUDGE_MAX_TURNS` keys later in the same object literal. The later hardcoded keys win, so the config surface does not control the runtime as intended. This also creates an observability mismatch because activity events report the configured values while execution still follows the constants.

2. High: wake minimum interval is still hardcoded in the controlling scheduler path.
   [apps/worker/src/agent.ts](../../../../apps/worker/src/agent.ts) still defines `const WAKE_MIN_INTERVAL_MS = 15_000` in the scheduling section that drives `resolveNextTickDelay()`. The new config value exists, but the actual wake gate is still pinned to the literal.

## Suggested Change List

1. Critical: modify [apps/worker/src/agent.ts](../../../../apps/worker/src/agent.ts) so the scout and judge loops each provide a single `maxTurns` value sourced from `agentRuntimePolicy`.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: remove the duplicate object keys carefully so activity logging and loop execution report the same effective limits.
   Test expectation: unit-test or narrow integration-test that the configured scout and judge turn caps are actually passed through to `runStructuredToolLoop()`.

2. High: modify [apps/worker/src/agent.ts](../../../../apps/worker/src/agent.ts) so wake scheduling uses `agentRuntimePolicy.wake.minIntervalMs` in the controlling path, not the leftover `15_000` literal.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: verify there is only one authoritative wake-min-interval value after cleanup; right now the file shows two competing definitions.
   Test expectation: integration-test wake scheduling and regression-test early-tick gating.

3. Medium: add a focused runtime usage test that fails if a future refactor reintroduces hardcoded loop-control literals after config parsing succeeds.
   Files/functions: [apps/worker/src/agent.ts](../../../../apps/worker/src/agent.ts), [packages/domain/src/config/schema.test.ts](../../../../packages/domain/src/config/schema.test.ts).
   Change: add.
   Dependencies: steps 1 and 2.
   Risks/Open questions: schema tests alone are not enough because they only prove parsing, not consumption.
   Test expectation: unit or integration test only; no visual verification needed.