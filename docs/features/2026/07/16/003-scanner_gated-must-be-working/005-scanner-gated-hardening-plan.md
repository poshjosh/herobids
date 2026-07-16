# Plan: Scanner-Gated Runtime Hardening and Verification

**Status:** Revised proposal. Do not implement until explicitly authorized.
**Scope:** Required implementation sequence items 2–4 in [`004-evidence-based-decisions.md`](004-evidence-based-decisions.md).
**Prerequisite:** Before implementation starts, verify with read-only staging evidence that the seven storming staging agents have been stopped. This plan does not perform staging mutations.

## Evidence Boundary

This plan distinguishes verified findings from implementation requirements. It does not prescribe an adapter, configuration shape, event name, dashboard change, provider catalogue, test symbol, or scheduling policy unless source evidence establishes that choice.

### Verified Findings

- The worker scanner path obtains a raw agent record and casts raw `unifiedConfig.technical` to `TechnicalConfig`.
- API writes parse technical configuration, but the scanner actor path bypasses that parsing/defaulting path.
- In the captured staging data, missing `scanBatchSize` causes the technical-phase batching increment to become `NaN`; no candle fetch is attempted.
- Missing `scanIntervalMs` causes the technical scan timer to run with an unintended near-zero delay.
- The 90-minute staging capture did not call the scanner candle fetcher. It therefore proves neither success nor failure of the scanner's candle-provider path.
- Other agents already use data, regime checks, trading actions, and tools successfully. The existing Admin Dashboard already exposes aggregate market-data discovery, freshness, regime, and provider-counter information.

### Required Outcomes

- A malformed scanner-gated configuration cannot create an active scan loop.
- A valid scan has bounded work and cannot overlap with itself.
- The runtime makes no-candidate, unsupported/unusable data, provider failure, healthy no-signal, and actionable-signal outcomes distinguishable.
- Verification proves the scanner-gated path from a scan result through wake routing and decision intake without relying on a live signal.
- A live verification records actual provider outcomes for the selected deployed path before release approval.

### Phase 0: Required Decision Record

The implementing agent must inspect the relevant existing contracts and record these decisions in this feature folder before changing the affected surface. Do not treat these as optional discovery notes; they are implementation gates.

1. The strict persisted-config validation mechanism and the existing lifecycle/event contract used when actor startup is rejected.
2. The appropriate capacity-control boundary: existing provider limiter, worker scheduler, technical config, operator config, or a combination.
3. The available source of candle-provider eligibility and whether existing provider responses are sufficient to classify unsupported instruments without a new catalogue.
4. The existing provider counter taxonomy and whether scanner candle traffic is already represented in the Admin Dashboard data.
5. The smallest existing test harness that can deterministically exercise scanner event publication, wake routing, and decision intake.
6. The deployed staging connection and symbols that can be used to demonstrate the actual scanner candle path without assuming a particular venue mapping.

Decision 1 must be recorded before Phase 1. Decisions 2–4 must be recorded before Phase 2. Decision 5 must be recorded before deterministic integration work. Decision 6 must be recorded before live-provider smoke verification.

## Why One Plan

One plan is required, rather than separate plans for items 2–4, because they form one release-critical path:

```text
complete persisted config
  -> validated actor startup
  -> bounded, non-overlapping scan
  -> structured scan result
  -> scan event and scanner wake
  -> hybrid evaluator and decision intake
  -> deterministic and live-provider verification
```

Splitting those changes would leave a deployable intermediate state that either starts malformed actors, overloads the candle provider, or lacks a reliable proof that scanner-gated routing works.

## Goals

1. A hybrid agent can never start a scanner from incomplete persisted configuration.
2. Candidate scanning remains within a configured global candle-provider budget as scanner-agent count grows.
3. An in-progress scan cannot overlap with a timer-triggered successor for the same actor.
4. Operators can distinguish no market signal from no usable candle data or a configuration failure.
5. Automated tests prove the complete scanner-gated event chain without relying on live market conditions.
6. Live smoke verifies the deployed provider integration with a bounded, confirmed-supported input set, without requiring a signal or trade.
7. Existing observability is used wherever it already represents the relevant scanner/provider activity; any gap is recorded and resolved through the smallest compatible extension.

## Non-Goals

- Do not backfill, migrate, or repair old incomplete agent JSONB.
- Do not preserve malformed scanner-gated agents. They must be replaced after the product fix.
- Do not change trading policy, risk limits, signal scoring, or hybrid evaluator decision semantics.
- Do not require a live-market signal as a test pass condition.
- Do not deploy, restart, create, stop, or delete any staging resource as part of this plan's implementation work.

## Candidate Approaches (Not Yet Decisions)

### Persisted config is an invariant, not a best-effort input

`TechnicalConfigSchema` currently injects defaults at API write time. The implementation must ensure that worker startup rejects incomplete persisted scanner configuration rather than silently defaulting it. Whether this uses a separate persisted-config schema, a strict variant of the existing schema, or another established validation pattern is an implementation decision to verify against the domain and lifecycle contracts.

It must require the fields that `TechnicalConfigSchema` would otherwise default, including `filters`, `indicators`, `candles`, `signalBias`, `scanIntervalMs`, `scanBatchSize`, and `autonomousExit`. It must validate raw JSONB before any defaulting parse occurs.

`TechnicalConfigSchema.parse(raw)` alone is insufficient at actor startup because it silently repairs missing persisted fields. The implementation must use the existing failure/event contract appropriate to rejected actor startup; `scanner.config_invalid` is an illustrative outcome label, not a prescribed event name.

### Capacity respects config-layer ownership

Scanner work must be bounded by a capacity policy compatible with existing provider limits and active scanner-agent count. The implementation must first identify the existing scheduler, request-gate, and operator-config conventions, then choose the smallest control that can enforce all of the following:

- a finite number of entry candidates per scan;
- protection for open-position exit evaluation;
- finite global concurrent scans and candle requests;
- no hidden policy constants; and
- observable rate-limit and data-failure behavior.

Configuration ownership must follow the repository's configuration-layer rules:

- Operator config owns provider budgets, global scanner concurrency, platform ceilings, and any reservation of shared market-data capacity.
- Persisted agent config owns user/strategy scope such as symbol filters, exclusion filters, venue filters, and ranking preferences.
- Runtime code derives the effective per-scan cap from operator capacity and active scanner-agent count. It must not hide global provider protection inside per-agent JSONB, and it must not put user trading-scope policy into operator YAML.

The selected policy, its configured values, and the capacity calculation must be documented with the implementation. The documented calculation must show that worst-case scanner candle requests per minute, including active scanner count and open-position exit checks, stays within the reserved provider budget. No particular new field, semaphore implementation, or default value is approved by this plan in advance.

### Provider eligibility is explicit

Candidate selection must not issue unbounded speculative candle requests for a broad discovery universe. Before adding a provider catalogue or changing provider selection, determine from existing provider APIs, adapters, and error contracts how to classify eligibility and provider failure accurately. Unsupported instruments must be distinguishable from transient provider failures, and neither classification may be mistaken for a healthy no-signal scan.

The current scanner route uses Hyperliquid discovery with the orderbook candle fetcher. Today, resolving a provider symbol is not proof of eligibility: a string such as `FOO -> FOOUSDT` can still be unsupported by the downstream candle provider. The exact provider mapping and whether a replacement provider is needed remain unproven until the post-fix live evidence is captured.

Tests must include at least one known-supported symbol, one known-unsupported instrument, a transient provider failure, a rate-limit rejection, and an empty-candle response. Each must produce a distinct structured outcome.

### Scanner outcome health matrix

The implementation must define and test the scanner outcome matrix before wiring operator-facing health. At minimum:

| Outcome | Required interpretation |
|---|---|
| `discovered = 0` | Discovery/scope outcome; not an actionable signal. Health depends on whether filters intentionally selected no universe. |
| `selected = 0` with `discovered > 0` | Capacity/scope outcome; visible but not a provider failure. |
| `eligible = 0` with `selected > 0` | Scanner-data unhealthy for that provider path. |
| `fetched = 0` because all selected inputs are unsupported | Scanner-data unhealthy; unsupported count must be explicit. |
| `fetched = 0` because all requests failed or were rate-limited | Provider unhealthy or budget exhausted; not a healthy no-signal scan. |
| `fetched > 0`, `scored > 0`, `signalsGenerated = 0` | Healthy no-signal market result; do not wake scanner-gated LLM. |
| `signalsGenerated > 0` | Actionable scanner result; emit scan-completed before scanner wake. |
| exit-advisory-only with `signalsGenerated = 0` | Actionable protective result; emit scanner wake with `signalCount: 0`. |
| overlap skipped | Scheduler outcome; no provider call and no wake. |
| invalid persisted config | Startup failure; no actor timer, no scan loop. |

The exact field names may follow existing telemetry conventions, but these states must not collapse into a single successful zero-signal scan.

### The current staging candle path is unproven

The original 90-minute staging capture never reached `fetchCandles()`: the missing `scanBatchSize` made the batch-loop increment `NaN`, so no provider request was attempted. Therefore, configuration repair alone cannot prove that the current Hyperliquid-discovery-to-Binance-spot candle path works.

This is a release gate. After the configuration and bounded-work changes, the provider smoke must capture a structured outcome for every selected symbol:

- discovered Hyperliquid symbol and instrument identifier;
- resolved Binance symbol;
- catalogue eligibility result;
- candle request result (`fetched`, `unsupported`, or `failed`), including safe transport/status diagnostics for failures;
- candle count returned when fetched.

The implementation must choose compatible locations for aggregate health and per-symbol diagnostic evidence after inspecting current event, log, and dashboard contracts. A successful run requires the selected, confirmed-supported smoke inputs to fetch non-empty candle data. It must not infer provider success from a scan-completed event alone.

The existing Admin Dashboard should be checked during live verification for any already-represented discovery/provider health. Do not assume that its current counters include scanner candle activity. If they do not, record the gap and extend the existing telemetry path only as necessary for release evidence; do not create a parallel dashboard without a separately approved product decision.

## Phase 1: Strict Config Persistence and Actor Startup

### Changes

1. **Domain config schema**
   - Identify the existing schema pattern that can validate a stored scanner configuration without applying write-time defaults.
   - Make the worker reject missing required scanner fields before it can start scan scheduling.
   - Add or extend configuration only if the capacity decision established in the evidence-boundary step requires it.

2. **Operator YAML**
   - Apply the repository's established configuration-layer rules to any capacity setting that is introduced.
   - Document the chosen values and their basis; do not introduce hidden runtime constants.

3. **API create/PATCH path**
   - Preserve the existing `TechnicalConfigSchema.parse()` write step.
   - Trace every create and PATCH writer that can produce a hybrid/scanner-gated configuration.
   - Test that each writer persists a complete configuration suitable for strict worker validation.

4. **Repository and worker startup**
   - Eliminate the current worker raw-JSONB-to-`TechnicalConfig` cast from the actor construction path.
   - Ensure the actor-startup path does not silently repair an incomplete persisted scanner configuration.
   - If broader repository read-time defaulting is removed or renamed, audit every caller and record the compatibility impact separately from the scanner runtime fix.
   - When scanner-gated startup validation fails, use the established actor/session failure and event contract and do not instantiate an actor or start a timer.
   - Intelligence agents remain valid without a technical block.

### Candidate Files to Inspect or Change

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/index.ts` if the persisted schema/type needs barrel export
- `config/default.yaml`
- `apps/api/src/routes/agents.ts`
- `packages/db/src/agent-repository.ts`
- `apps/worker/src/index.ts`
- focused schema, repository, API, and worker startup tests

### Acceptance Criteria

- Every traced POST/PATCH writer persists a complete scanner configuration.
- A raw hybrid record missing a required persisted technical field cannot start an actor and produces the established startup-failure evidence.
- An intelligence agent with no technical object still starts normally.
- No worker code casts raw JSONB to `TechnicalConfig`.
- The actor-startup path validates persisted scanner config before scheduling and does not inject defaults into existing malformed rows.

## Phase 2: Bounded, Eligible, Single-Flight Scanner

### Changes

1. **Candidate selection**
   - Isolate or otherwise test the part of the existing scanner path that selects candidates.
   - Demonstrate that entry evaluation has a finite, policy-derived bound.
   - Preserve open-position exit evaluation when applying an entry-candidate bound.
   - Make selection ordering deterministic whenever the selected capacity policy requires prioritisation.

2. **Provider eligibility**
   - Implement the eligibility classification selected during the evidence-boundary step, using existing adapter and rate-limit patterns where available.
   - Do not issue unbounded speculative candle requests for a broad discovery universe.
   - Preserve enough safe diagnostic data to distinguish unsupported input, eligibility-source failure, candle transport/status failure, and empty candle response.

3. **Global and per-actor concurrency**
   - Enforce the chosen global capacity policy and prevent overlapping scans for one actor.
   - Record overlap prevention as a distinct scan outcome.
   - Retain or deliberately change initial-scan scheduling only after checking the existing actor lifecycle and its tests; document the decision and its effect on first-scan timing.

4. **Structured health**
   - Add structured scan outcomes sufficient to distinguish discovery, selection, eligibility, fetch, scoring, overlap, and wake-routing results.
   - Place aggregate and diagnostic evidence in the existing event/log/telemetry contracts selected during the evidence-boundary step.
   - Define, test, and document the existing-compatible health/event treatment for no usable candle data versus a valid no-signal scan.

### Candidate Files to Inspect or Change

- `apps/worker/src/index.ts`
- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/technical-phase.ts`
- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/agents/instance-event-publisher.ts` if payload typing needs extension
- `packages/market-data/src/binance-candles.ts` and provider registry/exports, or a focused adjacent catalogue module
- `packages/venues/src/candle-fetcher.ts` only if eligibility belongs at this adapter boundary
- focused worker, market-data, and runtime-composition tests

### Acceptance Criteria

- A broad discovery set cannot cause unbounded candle requests.
- Unsupported input is distinguishable from a provider failure and does not create uncontrolled retry/request behavior.
- Candidate ordering is reproducible whenever capacity selection excludes candidates.
- A second timer tick cannot overlap an active scan for the same actor.
- Worker-wide scan/fetch concurrency stays within the selected, documented capacity policy.
- The documented capacity calculation proves worst-case scanner candle requests per minute remain within the reserved provider budget for the tested active scanner count.
- A scan with zero usable candles is visibly unhealthy; a scored scan with zero signals is healthy and does not wake the LLM.
- The scanner outcome health matrix is implemented and covered by focused tests.
- A valid scanner signal still produces `agent.technical.scan_completed` before scanner `agent.wake`.

## Phase 3: Deterministic and Live Verification

### Deterministic Integration Coverage

Add deterministic coverage using the smallest existing test harness that executes real scanner/event/routing components. It must not rely on text-log assertions, live market conditions, or a live signal.

Required assertions:

1. A complete scanner-gated config starts the scanner path and produces a controlled actionable result.
2. The outbound stream receives `agent.technical.scan_completed` before `agent.wake(source='scanner')`.
3. The runtime records a fresh `lastTechnicalScan` and selects the single-shot hybrid evaluator.
4. A controlled valid evaluator decision is sent to decision intake exactly once.
5. A non-scanner wake cannot trigger the scanner-gated evaluator.
6. An exit-advisory-only scan emits a scanner wake with `signalCount: 0`.
7. Invalid config, provider-catalogue failure, unsupported-only candidates, all-candle-fetch failure, and overlap skip each produce their intended distinct status.

### Script Split

Separate configuration-persistence verification from live scanner-provider verification. Whether the current `agent-config-defaults-smoke-test` is split, narrowed, or replaced must follow an inspection of its current responsibilities and scripts conventions.

1. **Configuration-persistence verification**
   - API create/PATCH only.
   - Asserts complete stored technical JSONB and strict invalid-config rejection.
   - Does not require worker logs, a real connection, live candles, signals, or a trade.

2. **Scanner-provider verification**
   - Runs against a stack with an active Hyperliquid connection.
   - Uses a bounded input set confirmed against the deployed scanner/provider path during implementation discovery.
   - Asserts completed scans, no overlap, expected scan cadence under the chosen policy, and the defined healthy-data outcome.
   - Reads structured scan outcomes and asserts every selected input completes the confirmed provider path and returns a non-empty candle set. On failure, its report includes the discovery symbol, resolved provider symbol where applicable, eligibility state, and safe request failure/status detail.
   - Does not accept `agent.technical.scan_completed` by itself as proof that the provider path works.
   - Captures existing Admin Dashboard evidence only for metrics confirmed to represent this traffic. The report separately records any observability gap.
   - Treats `signalsGenerated === 0` as success.
   - Cleans up only the temporary agent and does not revoke a shared test connection.

Keep or adapt existing agent config matrix coverage only after confirming its present scope; it must cover every traced writer of scanner-gated configuration.

### Validation Commands

Run after each phase at minimum:

```bash
pnpm --filter @herobids/domain test
pnpm --filter @herobids/db test
pnpm --filter @herobids/api test
pnpm --filter @herobids/worker test
pnpm lint
```

Then run the two split smoke scripts on a local stack. Staging validation is a later release step and is out of scope until this implementation plan is completed and approved.

## Required Templates

Use these templates in this document or in a sequentially numbered companion document in this feature folder. If a companion document is created, link it from the relevant checklist item before marking that item done.

### Phase 0 Decision Template

```text
Decision: <number and title>
Status: proposed | accepted | rejected
Date:
Owner:

Question:
<The exact decision being made.>

Inspected sources:
- <file, doc, log, test, or staging evidence>

Decision:
<The chosen contract, boundary, harness, provider path, or staging input.>

Rejected alternatives:
- <Alternative>: <why rejected>

Implementation consequences:
- <Code/test/config surface that must follow from this decision>

Required validation:
- <Focused tests, commands, or smoke assertions needed to prove the decision held>

Residual risk or follow-up:
- <Known remaining uncertainty, or "None">
```

### Capacity Calculation Template

```text
Capacity policy name:
Date:

Provider and request class:
Provider budget rpm:
Reserved scanner budget rpm:
Provider max wait ms:

Active scanner-agent count assumed:
Scan interval ms:
Max selected entry candidates per scan:
Max open-position exit symbols per scan:
Max candle requests per agent scan:
Worst-case scanner candle requests per minute:

Formula:
<active scanners> * <requests per agent scan> * (60000 / <scan interval ms>) = <rpm>

Pass/fail:
<PASS if worst-case rpm <= reserved scanner budget; otherwise FAIL>

Backpressure and overlap behavior:
- <How global capacity is enforced>
- <How per-actor single-flight is enforced>
- <What outcome is recorded when capacity prevents work>

Validation evidence:
- <Test names, log/event sample, or smoke output proving the policy>
```

### Evidence Capture Template

```text
Evidence item:
Date/time:
Environment:
Commit/image identity:
Command or source:

Raw evidence location:
- <path, log excerpt, Redis stream key, DB query, dashboard panel, or test report>

Observed result:
- <structured facts only>

Interpretation:
- <what this proves>
- <what this does not prove>

Release relevance:
- <which checklist item or acceptance criterion this satisfies>
```

## Coordinator Execution Checklist

This is the only section the `Coordinator` agent should treat as the implementation task queue. Other sections provide requirements, evidence, and acceptance criteria for these checklist items.

1. **DONE — Verify staging prerequisite** ✅
   - Evidence collected in [006-staging-prerequisite-evidence.md](006-staging-prerequisite-evidence.md).
   - Worker restarted. Re-verified 2026-07-16 ~17:30 UTC: DB shows 0 storming agents, 0 scanner log lines in last 10s, worker CPU at 0.85%. Prerequisite met.

2. **PENDING — Record Phase 0 Decision 1**
   - Decide the strict persisted-config validation mechanism and actor startup rejection contract.
   - Use the Phase 0 Decision Template.

3. **PENDING — Implement Phase 1 strict config persistence and actor startup validation**
   - Implement only the Phase 1 code and tests.
   - Do not modify scanner execution, provider eligibility, or capacity behavior in this item.

4. **PENDING — Validate Phase 1**
   - Run the focused schema, repository, API, and worker startup tests added or changed for Phase 1.
   - Run the relevant package tests from Validation Commands.
   - Record evidence for the commands and results.

5. **PENDING — Record Phase 0 Decisions 2–4**
   - Decide the capacity-control boundary, provider eligibility source/classification, and provider-counter/dashboard treatment.
   - Use the Phase 0 Decision Template for each decision.
   - Complete the Capacity Calculation Template before Phase 2 implementation starts.

6. **PENDING — Implement Phase 2 bounded eligible single-flight scanner**
   - Implement candidate bounding, provider eligibility classification, global/per-actor concurrency, and structured scan health.
   - Implement the scanner outcome health matrix.

7. **PENDING — Validate Phase 2**
   - Run focused worker, market-data, venue-adapter, and runtime-composition tests for Phase 2.
   - Prove the documented capacity calculation with tests or controlled smoke output.
   - Record evidence for overlap prevention, unsupported classification, provider failure classification, healthy no-signal, actionable signal, and exit-advisory-only outcomes.

8. **PENDING — Record Phase 0 Decision 5**
   - Decide the smallest deterministic integration harness for scanner event publication, wake routing, runtime ingestion, evaluator selection, and decision intake.
   - Use the Phase 0 Decision Template.

9. **PENDING — Implement deterministic integration coverage**
   - Add deterministic tests for the complete scanner-gated event chain.
   - Use fixture candles and a controlled evaluator/LLM decision source; do not rely on live market conditions.

10. **PENDING — Record Phase 0 Decision 6**
    - Decide the deployed staging connection and bounded symbols for live-provider smoke.
    - Use the Phase 0 Decision Template.
    - Do not create, start, stop, delete, restart, deploy, or otherwise mutate staging in this item.

11. **PENDING — Split or replace smoke scripts**
    - Separate configuration-persistence verification from scanner-provider verification.
    - Ensure live-provider smoke treats `signalsGenerated === 0` as success when data is healthy.
    - Ensure provider smoke reports per-symbol eligibility, resolved provider symbol, fetch result, safe failure/status detail, and candle count.

12. **PENDING — Run full local validation**
    - Run every command listed in Validation Commands.
    - Run the split local smoke scripts against a local stack when the environment supports them.
    - Record command results using the Evidence Capture Template.

13. **PENDING — Record outstanding issues and stop before staging deployment**
    - Append any remaining non-high/non-critical review findings as Outstanding Issues.
    - Do not deploy to staging or replace staging agents. Staging rollout remains follow-on work.

## Implementation Order and Stop Conditions

1. Verify the staging prerequisite with read-only evidence before implementation starts.
2. Establish and record Decision 1 from **Phase 0** before implementing Phase 1.
3. Implement and validate Phase 1 before modifying scan execution.
4. If strict validation exposes a writer that persists incomplete hybrid config, repair that writer before proceeding. Do not reintroduce runtime repair of malformed persisted scanner configuration.
5. Establish and record Decisions 2–4 from **Phase 0** before implementing Phase 2.
6. Implement and validate Phase 2 before starting any replacement scanner-gated agent.
7. Establish and record Decision 5 before deterministic integration work, and Decision 6 before live-provider smoke verification.
8. Implement Phase 3 before proposing staging deployment.
9. Stop and report rather than deploy if validation shows raw scanner config is still cast at actor startup, a scan can overlap, capacity math exceeds the reserved provider budget, scanner outcome states collapse into ambiguous zero-signal results, live-provider outcomes remain unproven, or live smoke requires a signal to pass.

## Follow-On Work (Explicitly Deferred)

- Replacing the current Binance orderbook candle source with a Hyperliquid-native candle provider.
- A staging deployment/restart plan, replacement-agent creation plan, and progressive rollout plan.
- A new scanner-specific dashboard or separate monitoring surface. The existing Admin Dashboard remains the aggregate operational view.