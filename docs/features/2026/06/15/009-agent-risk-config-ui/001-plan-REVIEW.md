# Review: Agent Risk Configuration UI

## Verdict

Partially implemented, with one worker-side correctness gap.

The branch adds the API fields and bounds checks in [apps/api/src/routes/agents.ts](../../../../apps/api/src/routes/agents.ts), persists the new columns in the agent schema and migration, exposes defaults to the web UI, and renders the new controls in the agent forms. But the worker's risk-limit resolver still drops one of the new hard caps in a valid user flow.

## Findings

1. High: `maxPositionSizePct` is ignored when the user does not also provide `capital`.
   In [apps/worker/src/agent-risk-limits.ts](../../../../apps/worker/src/agent-risk-limits.ts), `maxPositionSizePct` is only included inside the `capital != null` branch. The UI and API both allow users to set `maxPositionSizePct` independently, so a saved hard cap can be silently omitted from the worker-resolved limits.

2. Medium: the product does not explain or enforce the dependency between percentage-based limits and capital-based risk budgeting.
   The current UI exposes `maxPositionSizePct` as a standalone field, but the worker implementation treats capital as part of the calculation path. If capital is truly required for this control to be meaningful, the API or UI should say so explicitly instead of accepting a value that may not take effect.

## Suggested Change List

1. High: modify [apps/worker/src/agent-risk-limits.ts](../../../../apps/worker/src/agent-risk-limits.ts) so a user-configured `maxPositionSizePct` is preserved in the resolved risk limits instead of being dropped when `capital` is null.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: if this field fundamentally requires capital, then the fix should move to validation instead of silently carrying a meaningless value.
   Test expectation: unit-test `buildAgentRiskLimits()` for `maxPositionSizePct` with and without capital.

2. Medium: add explicit validation or UX guidance connecting [apps/api/src/routes/agents.ts](../../../../apps/api/src/routes/agents.ts) and [apps/web/src/features/agents/AgentControlsSection.tsx](../../../../apps/web/src/features/agents/AgentControlsSection.tsx) so users understand whether percentage-based limits require capital.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: decide whether the correct contract is "capital required" or "percentage limit still valid without capital baseline" and enforce one answer consistently.
   Test expectation: unit-test validation behavior; render-test the explanatory text; no visual verification needed.