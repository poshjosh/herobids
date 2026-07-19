# Implementation Plan: Platform LLM Ranking And Artifact Assembly

**Status:** Draft - rewritten after implementation review
**Depends on:** [008-real-evidence-and-scorecards.md](./008-real-evidence-and-scorecards.md)
**Companion:** [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)
**Purpose:** Replace placeholder ranking text with a platform-owned, bounded, validated LLM analysis over persisted deterministic evidence.

## Authoritative Plan

This section supersedes the archived draft below. Implement only this section.

### Scope And Safety Boundary

The platform LLM ranks market-preset fit for one canonical symbol identity. It is advisory only.

- It receives immutable shared evidence and deterministic dry-run scorecards from `008`.
- It does not receive agent identity, account balances, positions, creator constraints, PnL, private prompts, or tool history.
- It does not decide whether any particular agent switches, mutate configuration, create a wake, or submit a trade.
- It cannot change the allowed-preset policy. Style-tier and agent-policy eligibility remain deterministic transition checks.
- It creates no artifact when evidence is incomplete, provider work fails, parsing fails, or semantic validation fails.

The selected provider/model is resolved operator configuration. Do not hard-code a provider, model ID, cost, or latency claim. The platform assessor must never fall back to an agent's LLM configuration.

### Worker Composition Root

`PlatformAssessor` has an injected `callLlm` dependency but is not currently constructed in worker startup. Add one factory at the worker composition root that constructs the shared service with resolved assessor policy, the `008` evidence/scorecard ports, a preset-catalog adapter, persistence repository, logger/telemetry hooks, and a platform-owned LLM adapter.

The adapter uses the existing `@herobids/llm` boundary and retry/error classification conventions. At worker startup, validate provider/model availability against the loaded provider registry. Missing, disabled, or invalid platform configuration is a loud assessor-construction failure; it must not be inferred from an agent model choice.

Configure timeout, retry policy, input/output token limits, concurrency, and maximum evidence-projection size in `PlatformAssessorConfigSchema` and `config/default.yaml`. Remove the obsolete cycle-oriented `maxLlmCallsPerCycle`; on-demand queue/concurrency policy belongs to the assessor/request-service composition.

### Prompt Projection

Build a typed, bounded projection from the persisted evidence snapshot and scorecards. Do not concatenate raw Redis, DB, provider, or candle payloads.

Include only canonical identity and style tier; evidence availability, source timestamps, and calculation versions; deterministic regime/volatility/liquidity/breadth facts; each candidate preset's behavior version and dry-run results; a controlled catalog description of behavior-affecting characteristics; and output constraints.

Exclude all agent/user/account data. Cap arrays, string lengths, candle-level data, provider payloads, and total serialized input before the provider call. Use evidence references and summary statistics instead of raw candles. Snapshot-test the exact projected request.

The system instruction must require JSON only, ranking every provided candidate exactly once, use of only supplied facts, no invented preset, and an explicit distinction between unavailable input and negative evidence.

### Response Schema And Semantic Validation

Define a syntactic `PlatformAssessmentLlmResponseSchema` in the domain package. It accepts bounded summaries, confidence, urgency, and an ordered ranking of every candidate with score, pros, cons, and fit note.

After parsing, apply deterministic validation:

1. Output preset-key set exactly equals the candidate set.
2. Ranks are a complete, unique `1..N` sequence.
3. Output behavior versions equal the catalog-derived versions passed in the projection.
4. Scores, confidence, cardinalities, and text limits meet policy.
5. No response contains an unrecognised identity, policy mutation, tool instruction, or free-form control directive.

Reject malformed JSON, code fences unless explicitly normalized by a tested parser, provider failures, and semantic violations with stable `assessment.llm_*` error codes. Record only bounded, redacted diagnostics. Provider thinking must be stripped at the `@herobids/llm` boundary and must never be stored or logged.

### Deterministic Artifact Assembly

The model does not own artifact policy fields.

- Derive score bands from configured bands after validation.
- Derive `relativeUplift` deterministically in score points, never as a predicted trading-performance percentage. Use `null` for one candidate.
- Derive `recommendedPreset` from the validated rank-one entry only if configured confidence/score policy permits it; otherwise retain the ordering and set the recommendation to `null`.
- Use one resolved `cacheFreshnessMs` for expiry. Store absolute timestamps for actor/wake deadlines, or implement an ISO-duration parser consistently. Do not write `PT12H` to a field later passed to `new Date()`.
- Keep artifact candidate presets deterministic. Do not let an LLM score cutoff redefine the agent's allowed preset policy. Rename misleading `allowedPresets` storage semantics if necessary during the clean-slate migration.
- Persist evidence, scorecard, prompt, artifact, and ranking-policy versions plus exact evidence references.

The ranker returns a validated, unpersisted artifact candidate. Identity-safe replacement, artifact supersession, and billing settlement are owned by `007`.

### Failure And Telemetry Contract

| Condition | Required behavior |
|---|---|
| Required evidence unavailable | Do not call the LLM. Return the `008` evidence error. |
| Assessor LLM disabled or misconfigured | Reject before provider work with a stable configuration error. |
| Timeout, provider error, retry exhaustion | Return a structured provider error to the request-service settlement policy. |
| Invalid or semantically inconsistent output | Return `assessment.llm_response_invalid`; persist no artifact. |
| Valid response | Emit bounded provider/model IDs, input/output token counts, latency, candidate count, validation result, and version telemetry. |

### Required Changes And Tests

| Surface | Change |
|---|---|
| `apps/worker/src/market-intelligence/platform-assessor.ts` | Replace placeholder `rankPresets()` with projection, adapter call, validation, and deterministic assembly. |
| New ranker/prompt module | Keep prompt projection and response mapping unit-testable without provider calls. |
| Worker composition root | Construct and inject the one platform assessor service. |
| `packages/domain/src/market-assessment.ts` | Add LLM response schema, semantic-contract types, and corrected artifact semantics. |
| Config schema and YAML | Add platform LLM, token budget, timeout/retry, score-band, and recommendation policy. |

Unit tests must cover bounded projection, candidate/version presence, malformed output, missing/duplicate candidates, bad ranks, stale versions, out-of-range fields, deterministic bands/uplift/recommendation/expiry, and zero artifact persistence on invalid output. Integration tests use a recorded visible-text fixture through the real provider adapter boundary and prove worker composition uses platform-owned configuration.

This plan is complete only when `rankPresets()` makes a validated platform LLM call, emits no scaffold text, and [006-followup-plan.md](./006-followup-plan.md) C2 has executable proof.

## Archived Draft - Do Not Implement

---

## 0. Scope

This plan covers the **LLM-driven intelligence layer** of the platform assessor — the part that takes collected deterministic evidence + per-preset scorecards and produces a ranked recommendation with narrative explanation.

It does NOT cover:
- Evidence collection or scorecard generation (Plan 008)
- The review-scheduler or scanner pre-check (Plan 010)
- Billing (Plan 007)

---

## 1. Current State (what's broken)

### `rankPresets(identity, evidence, scorecards)` — `platform-assessor.ts`

Returns a completely hardcoded `MarketAssessmentArtifact`:

```ts
// All rankings have score: 0, scoreBand: 'N/A', empty pros/cons
const rankings: MarketAssessmentPresetRanking[] = scorecards.map((sc, idx) => ({
  presetKey: sc.presetKey,
  presetBehaviorVersion: sc.presetBehaviorVersion,
  rank: idx + 1,         // ← arbitrary order (presetKeys array order)
  score: 0,              // ← placeholder
  scoreBand: 'N/A',      // ← placeholder
  pros: [],              // ← placeholder
  cons: [],              // ← placeholder
  fitNotes: null,        // ← placeholder
}));

return {
  // ...
  currentMarketSummary: 'Phase 1 scaffolding — market summary not yet implemented.',
  regimeSummary: 'Phase 1 scaffolding — regime summary not yet implemented.',
  scanHealthSummary: 'Phase 1 scaffolding — scan health not yet computed.',
  presetRankings: rankings,
  recommendedPreset: scorecards.length > 0 ? scorecards[0]!.presetKey : null,  // ← arbitrary (first in array)
  relativeUplift: null,     // ← placeholder
  confidence: 0,            // ← placeholder
  urgency: 'low',           // ← placeholder
  reasoningSummary: 'Phase 1 scaffolding — reasoning not yet implemented.',
  evidenceRefs: [],         // ← placeholder
};
```

**The LLM is never called.** The `callLlm` dependency is injected but unused by `rankPresets()`.

---

## 2. What Needs to Change

### 2.1 LLM Prompt Construction

Build a structured prompt that the platform LLM can reason over. The prompt must include:

**Fixed system preamble** (platform role, not agent persona):
- You are a platform-level market analyst. Your job is to evaluate which trading preset best fits current market conditions for a specific symbol.
- You do NOT have access to the agent's positions, PnL, or risk state. Your recommendation is about market-preset fit only.
- Output valid JSON matching the response schema.

**Context block** (structured data, not narrative):
- Symbol identity: venueFamily, symbol/network+address, instrumentKind, styleTier
- Collected evidence:
  - Breadth: symbolsAboveMA / totalSymbols, breadthRatio
  - Volatility: ATR, volatilityRegime
  - Liquidity: spreadBps, depthUsd, quality
  - Scan health: aggregate signals/discovered/scored, health status
  - Regime: trend alignment, market structure, ADX, choppy flag
- Per-preset scan metrics (from scorecards):
  - For each preset: candidatesDiscovered, candidatesScored, signalsGenerated, topConfidence, scanHealth
- Available presets in this tier (names + behavior versions)

**Output requirements:**
- Rank every preset from best fit (rank 1) to worst fit
- Assign a normalized score (0-100) for each preset
- For each preset, list 2-5 pros and 2-5 cons based on evidence
- Provide a `fitNotes` field explaining why this preset is a good/poor fit
- Assign a `scoreBand`: 'A' (≥80), 'B' (60-79), 'C' (40-59), 'D' (20-39), 'F' (<20)
- Produce narrative summaries:
  - `currentMarketSummary`: 2-4 sentences describing market conditions
  - `regimeSummary`: 1-2 sentences on trend/volatility regime
  - `scanHealthSummary`: 1-2 sentences on scanner performance across presets
  - `reasoningSummary`: 2-4 sentences explaining the top recommendation
- Confidence (0-1): how confident the assessor is in this ranking
- Urgency ('low' | 'medium' | 'high'): how urgent a preset change is
- `recommendedPreset`: the presetKey of rank 1 (or null if all presets are poor fits)
- `relativeUplift`: estimated % score improvement of rank 1 vs. rank 2

### 2.2 LLM Provider Selection

The platform assessor must use a **platform-owned LLM provider**, distinct from the agent's own LLM configuration. This is already wired — `PlatformAssessorDeps.callLlm` is the injection point.

**Configuration:**
- Read the platform LLM config from `PlatformAssessorConfigSchema` (operator config)
- Add fields: `llmProvider`, `llmModel`, `llmTimeoutMs`, `llmMaxTokens`
- **Resolved model:** Claude Fable 5 via OpenRouter (operator configurable). Config shape:
  ```yaml
  platformAssessor:
    llm:
      provider: openrouter
      model: anthropic/claude-fable-5
      timeoutMs: 30000
      maxTokens: 2000
  ```
- The `callLlm` injection point already abstracts the provider — switching models later requires no code change.

### 2.3 Response Parsing

The LLM response must be parsed and validated:

1. Parse the JSON from the LLM response text (strip markdown code fences if present)
2. Validate against a Zod schema (`PlatformAssessmentLlmResponseSchema`)
3. On parse failure: log the raw response, return `err('assessment.llm_response_invalid')`
4. On validation failure: log schema violations, return `err('assessment.llm_response_validation_failed')`

The Zod schema must enforce:
- Every preset key in the input scorecards appears exactly once in the output rankings
- Rank values are 1..N with no gaps or duplicates
- Scores are 0-100
- Confidence is 0-1

### 2.4 Artifact Assembly

After successful LLM ranking, assemble the full `MarketAssessmentArtifact`:
- Map LLM output fields to artifact fields
- Set `assessmentVersion`, `artifactVersion`, `rankingPolicyVersion` (bump as needed)
- Set `expiresAt` based on `cacheFreshnessMs`
- Set `maxActorUseAge` and `maxWakeAge` to ISO 8601 durations
- Set `status = 'active'`
- **`allowedPresets`:** All preset keys with score > `minAllowedScore` (configurable, default 1). Score 0 = LLM found no reason to recommend — the preset is excluded from the allowed list. This is advisory only; agents can still manually switch.
- **`relativeUplift`:** Computed deterministically as `rank1.score − rank2.score`. If only one preset, `null`. If rank 1 and rank 2 tie, `0`.
- Set `evidenceRefs` = references to the raw evidence snapshots (for audit)

---

## 3. Files Changed

| File | Change |
|------|--------|
| `apps/worker/src/market-intelligence/platform-assessor.ts` | Rewrite `rankPresets()`: construct prompt, call LLM, parse response, assemble artifact. Remove placeholder ranking code. |
| `apps/worker/src/market-intelligence/platform-assessor.test.ts` | Add tests: LLM prompt construction content, response parsing (valid/invalid JSON), artifact assembly. Mock `callLlm`. |
| `packages/domain/src/config/schema.ts` | Add `PlatformAssessmentLlmConfigSchema` (provider, model, timeout, maxTokens) and embed in `PlatformAssessorConfigSchema`. |
| `packages/domain/src/market-assessment.ts` | Add `PlatformAssessmentLlmResponseSchema` Zod schema for validating LLM JSON output. |
| `config/default.yaml` | Add `llm` block under `platformAssessor` with provider/model defaults. |

---

## 4. Prompt Design Considerations

### 4.1 Token Budget

The prompt must stay within reasonable token limits. Current evidence is lightweight (maybe 2-3 KB of structured JSON). With 3-10 presets, the full prompt should stay under 4K tokens input. Target output is ~1-2K tokens.

### 4.2 Hallucination Guardrails

- The prompt must instruct the LLM to ONLY reference preset keys that appear in the input. If a preset key in output does not match any input preset, reject the response.
- The prompt must instruct the LLM to derive pros/cons from the provided evidence, not invent facts about presets.
- If the LLM outputs rankings that don't cover all input presets, treat as a validation failure.

### 4.3 Cost Control

- Platform LLM calls are billed to the platform, not the agent (agent billing is separate, covered by Plan 007).
- The `maxLlmCallsPerCycle` config (currently unused) should gate the number of LLM calls — but since this is on-demand (one call per agent request), this is effectively a single-call budget. Keep the config for future batching.

### 4.4 Prompt Template Location

**Resolved:** Inline the system prompt in `platform-assessor.ts` for Phase 1. It's ~30 lines of instructions that won't change frequently. Inline is simpler — no file I/O, no loading edge cases, trivially testable. Extract to a config file or `.md` file later if needed for A/B testing or operator customization.

---

## 5. Dependencies

- Plan 008 (real evidence and scorecards) — the LLM prompt needs real evidence to produce meaningful rankings. However, the LLM integration can be developed and tested in parallel with mocked evidence.
- `PlatformAssessorDeps.callLlm` must be wired at construction time (already injected, caller responsibility).
- No dependency on billing, review scheduler, or scanner pre-check.

---

## 6. Test Strategy

- **Unit tests:** Mock `callLlm`. Test prompt construction — verify it includes all evidence fields and all preset keys.
- **Unit tests:** Test response parsing — valid JSON, invalid JSON, missing preset keys, scores out of range.
- **Unit tests:** Test artifact assembly — verify all fields mapped correctly from LLM output.
- **Integration tests:** Call with a real LLM (or a recorded/cached response) and verify the full flow produces a well-formed artifact. Snapshot the artifact for regression.
- **No visual/browser testing needed.**

---

## 7. Completion Bar

- `rankPresets()` calls `this.deps.callLlm()` with a structured prompt.
- LLM response is parsed and validated against a Zod schema.
- Invalid responses produce structured errors (not crashes).
- The returned `MarketAssessmentArtifact` has:
  - Real `currentMarketSummary`, `regimeSummary`, `scanHealthSummary`, `reasoningSummary` (not placeholder text)
  - Real per-preset rankings with non-zero scores, actual pros/cons, and fitNotes
  - Real `confidence` (0-1) and `urgency` values
  - `recommendedPreset` derived from actual ranking logic (not just first in array)
- `pnpm lint` and `pnpm build` pass.
- Tests pass.

---

## 8. Resolved Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **LLM model: Claude Fable 5 via OpenRouter** | ~$10/1M input, ~$50/1M output. Config-driven so operator can swap. |
| 2 | **Prompt template: inline in code** | ~30 lines, stable, simpler than file I/O. Extract to config later if A/B testing needed. |
| 3 | **`allowedPresets` threshold: score > 0 (configurable, default 1)** | Score 0 = LLM found no reason to recommend. Advisory only — agent can still manually switch. |
| 4 | **`relativeUplift`: deterministic (rank1.score − rank2.score)** | Avoids LLM arithmetic errors. Ties → 0, single preset → null. |
