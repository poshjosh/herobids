# Agent Evaluation — Narrative LLM Selection

**Status:** Done  
**Created:** 2026-06-29  
**Feature ID:** 001-agent-evaluation

## Goal

Allow callers to specify the LLM used for optional evaluation narrative generation when submitting an agent evaluation request.

If no narrative model override is provided, resolve the narrative LLM using the same selection path used for the agent judge model:

- resolve provider/light/heavy from agent config plus user AI settings
- derive the effective heavy model through the normal cost-profile logic
- use that final provider + effective heavy model for commentary generation

## Decision Summary

1. Narrative generation remains optional and non-authoritative.
2. Deterministic analyzers remain the source of truth for findings and scores.
3. Narrative LLM selection is resolved at enqueue time, not worker execution time.
4. The worker receives a fully resolved narrative LLM config in the job payload.
5. A model-only override keeps the normally resolved provider.
6. A provider override requires a model override.
7. Narrative generation failure at runtime is best-effort and must not fail the evaluation run.
8. Narrative usage is billed.
9. Narrative model provenance lives in artifacts only, unless it is trivial to also include later in the persisted run record.
10. Explicit provider override is supported when the caller specifies both provider and model.

## Scope

This plan covers:

- request contract changes for narrative model override
- shared extraction of judge-model resolution helpers so API and worker use the same logic
- enqueue-time resolution and validation
- worker narrative generation using the resolved config
- billing/provenance handling for narrative generation
- tests for resolution, validation, and runtime behavior

This plan does not change:

- deterministic scoring logic
- evaluation scope semantics
- artifact download APIs
- the existing analyzer thresholds

## Proposed Request Shape

Keep the existing `includeNarrative` flag and add an optional override object:

```ts
{
  scope?: ...,
  includeNarrative?: boolean,
  narrativeLlm?: {
    provider?: string,
    model: string
  }
}
```

Validation rules:

- if `includeNarrative` is false, `narrativeLlm` must be omitted
- if `narrativeLlm.provider` is present, `narrativeLlm.model` must be present
- if `narrativeLlm.model` is present and `provider` is omitted, keep the resolved default provider and replace only the final model
- if `includeNarrative` is true and no valid narrative LLM can be resolved, reject the request with HTTP 400

## Architectural Change Required First

The current judge-model resolution logic is app-local to the worker, so the API cannot reuse it directly.

Before implementing the request override, extract these helpers into a shared package:

- `resolveEffectiveLlmSelection`
- `resolveAgentCostProfile`
- the related shared types used by those helpers

Recommended destination:

- `packages/domain/src/llm-selection.ts`
- `packages/domain/src/cost-profile.ts`

Then update worker imports to consume the shared helpers instead of the app-local copies.

## Phase 1: Extract Shared Narrative/Judge Model Resolution

### Goal

Move judge-model selection primitives out of `apps/worker` so the API can resolve narrative defaults using the exact same logic.

### Files

- `packages/domain/src/llm-selection.ts`
- `packages/domain/src/cost-profile.ts`
- `packages/domain/src/index.ts`
- `apps/worker/src/llm-selection.ts`
- `apps/worker/src/cost-profile.ts`
- worker imports that currently reference those files directly

### Tasks

- Move `resolveEffectiveLlmSelection` and its supporting types into `packages/domain`.
- Move `resolveAgentCostProfile` and `CostPreset` into `packages/domain`.
- Re-export both from `packages/domain/src/index.ts`.
- Update worker code to import the shared versions.
- Move or duplicate the current unit tests so the shared helpers remain covered.

### Validation

- existing `llm-selection` tests still pass
- existing `cost-profile` tests still pass
- `pnpm lint`

## Phase 2: Extend Evaluation Request and Job Contracts

### Goal

Carry narrative override intent through the enqueue boundary and into worker execution.

### Files

- `packages/domain/src/agent-evaluation.ts`
- `packages/db/src/agent-evaluation-job.ts`
- `apps/api/src/routes/agent-evaluations.ts`
- tests for the route and job contract

### Tasks

- Add an optional `narrativeLlm` request field to the trigger API contract.
- Add a resolved narrative config field to the BullMQ job payload, for example:

```ts
narrativeLlm?: {
  provider: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  maxTokens: number;
}
```

- Keep `includeNarrative` for the on/off decision.
- Do not resolve the narrative LLM again in the worker if a resolved config is present.

### Validation

- request schema accepts valid combinations
- request schema rejects invalid combinations
- job payload type-checks end to end
- `pnpm lint`

## Phase 3: Resolve Narrative LLM at Enqueue Time

### Goal

When a request is submitted, resolve the final narrative LLM selection before the job is enqueued.

### Files

- `apps/api/src/routes/agent-evaluations.ts`
- `apps/api/src/index.ts`
- possibly a small new helper under `apps/api/src/routes/` or `apps/api/src/lib/`

### Tasks

- Extend `agentEvaluationRoutes` dependencies to accept:
  - operator `llm` config
  - `providersYaml`
- Reuse `AgentRepository.getUserAiModelConfig(userId)` for user AI defaults.
- Read the agent’s persisted `modelPolicy`, `costPreset`, and `dailySpendBudgetUsd`.
- Resolve the default provider/light/heavy via the extracted shared helper.
- Derive the effective heavy model via the extracted shared cost-profile helper.
- Apply the override rules:
  - no override: use resolved provider + effective heavy model
  - model-only override: use resolved provider + override model
  - provider+model override: use override provider + override model
- Validate explicit override selections against `providersYaml` and the existing provider-catalog validation path.
- Derive `baseUrl` using the same rule as the runtime:
  - if the final provider matches the operator default provider, keep the operator-configured base URL
  - otherwise leave `baseUrl` undefined
- Put the fully resolved config into the queue job payload.

### Failure Behavior

Reject with HTTP 400 when:

- `includeNarrative` is true but provider/model resolution is incomplete
- explicit override provider is unavailable
- explicit override model is invalid for the chosen provider
- explicit override combination is malformed

### Validation

- route test: default narrative resolution uses agent/user settings path
- route test: model-only override keeps resolved provider
- route test: provider+model override works
- route test: invalid override is rejected
- route test: incomplete default resolution is rejected when narrative is requested

## Phase 4: Worker Narrative Generator

### Goal

Replace the placeholder narrative block with real LLM-generated commentary.

### Files

- `apps/worker/src/agent-evaluation/run-evaluation.ts`
- `apps/worker/src/agent-evaluation/evaluation-runtime.ts`
- new helper:
  - `apps/worker/src/agent-evaluation/generate-narrative.ts`

### Tasks

- Extend `RunEvaluationContext` with optional resolved narrative config.
- Extend `EvaluationRuntime` to forward the resolved narrative config from the job payload.
- Create `generateEvaluationNarrative()` helper that:
  - accepts the resolved LLM config
  - uses only redacted deterministic inputs
  - calls the LLM with `toolChoice: 'none'`
  - uses temperature `0`
  - uses the existing retry helper where appropriate
- Build the prompt from:
  - overall score
  - section scores
  - top findings by severity
  - redacted deterministic report text
- Require the output to be concise markdown only.
- Redact the generated narrative again before writing it.
- Append the narrative under `## Commentary` in `REPORT.md`.

### Runtime Failure Behavior

If narrative generation fails due to:

- timeout
- provider error
- parse/format issue
- rate limit

Then:

- log a warning
- continue the evaluation
- write the deterministic report without commentary
- still mark the evaluation as succeeded if the deterministic pipeline succeeded

### Validation

- worker test: `includeNarrative=false` never calls generator
- worker test: successful narrative call appends commentary
- worker test: narrative failure still succeeds the evaluation
- `pnpm lint`

## Phase 5: Billing and Provenance

### Goal

Ensure narrative usage is billed and the chosen narrative model is inspectable after the run.

### Files

- `apps/worker/src/agent-evaluation/run-evaluation.ts`
- `apps/worker/src/agent-evaluation/generate-narrative.ts`
- optional new artifact:
  - `narrative-metadata.json`

### Tasks

- Record narrative LLM usage with the same billing path used by other runtime LLM calls.
- Persist narrative provenance in artifacts.
- Recommended metadata fields:
  - `enabled`
  - `provider`
  - `model`
  - `baseUrlUsed`
  - `tokensUsed`
  - `inputTokens`
  - `outputTokens`
  - `latencyMs`
  - `generated`
  - `error` when generation fails
- If it is trivial to include the same provenance in the persisted run record without widening scope or complicating migrations, allow that as a follow-on within the same implementation.

### Note

This metadata is for auditability only. It must not become the source of truth for findings.

### Validation

- artifact manifest includes metadata artifact if written
- usage billing is invoked on successful narrative generation
- metadata exists for success and failure paths

## Tests

Add or update tests in:

- `apps/api/src/routes/agent-evaluations.test.ts`
- `apps/worker/src/agent-evaluation/run-evaluation.test.ts`
- shared helper tests for extracted LLM selection and cost-profile logic

Minimum scenarios:

- default narrative selection resolves through agent config
- default narrative selection falls back to user AI settings
- cost preset downgrades heavy model the same way judge selection does
- model-only override keeps provider
- provider+model override replaces both
- invalid override provider fails
- invalid override model fails
- narrative generation success appends markdown
- narrative generation failure remains best-effort
- narrative generation success records billable usage
- narrative provenance artifact is written

## Acceptance Criteria

- A caller can request narrative generation and optionally specify a model override.
- If no override is provided, the narrative model matches normal judge-model resolution behavior.
- Default narrative resolution uses the same shared helper path as judge selection.
- A model-only override does not silently change provider.
- Explicit provider override is supported when the caller supplies both provider and model.
- Invalid override combinations are rejected at request time.
- The worker consumes a fully resolved narrative LLM config from the job payload.
- Narrative generation is best-effort and does not affect deterministic evaluation correctness.
- Narrative generation usage is billed.
- Narrative provenance is persisted in artifacts.
- The final report contains commentary only when generation succeeds.

## Open Questions Resolved

1. Should narrative usage be billed or merely logged?
   Answer: Usage billed.
2. Should narrative model provenance live only in artifacts, or also in the persisted run record?
   Answer: Only in the artifacts, except if it is easy to also include later.
3. Should explicit provider override be allowed at all, or should the API only allow model override within the resolved provider?
   Answer: Explicit provider override should be supported when the user specifies both provider and model.