# Plan: Agent Evaluation

**Status:** Done  
**Created:** 2026-06-28  
**Feature ID:** 001-agent-evaluation

## Context

OpenAIdom already has the beginnings of an evaluation workflow, but it is still operator-driven and fragmented.

Current building blocks:

- Manual evaluation prompt in `.ignore/eval/eval-prompt.md`
- Operator workflow skill in `.github/skills/evaluate-agent/SKILL.md`
- Agent export bundle in `apps/api/src/routes/exports.ts`
- Minimal computed report in `apps/api/src/routes/exports.ts`
- Trading analytics primitives in `packages/db/src/repositories.ts`
- Existing non-trading separation principle in `docs/features/2026/06/12/002-non-trading-agent-tick-guard/plan.md`
- Related prior analysis in `docs/features/2026/06/28/001-agent-evaluation/000-aitradingbot-analysis.md`

The key gap is that the current export route gives a narrow trading summary, while the manual evaluation process asks broader questions about behavior, performance, reliability, cost, security, wake signals, persistence, and anomalies.

## Problem

We need a first-class Agent Evaluation feature that can automatically analyze an agent after a run or trading session.

The feature must:

- evaluate behavior, performance, reliability, cost, and security
- support trading agents first without hard-coding trading assumptions into the core
- be extendable to non-trading agents
- produce a durable evidence bundle, a machine-readable scorecard, and a human-readable report
- support both on-demand and automated evaluation triggers

## Goals

1. Build one phased evaluation system that covers Levels 1, 2, and 3.
2. Make evidence collection deterministic and primary.
3. Keep LLM-written narrative optional and downstream of deterministic facts.
4. Support trading evaluation first, while keeping the core generic enough for non-trading agents.
5. Make the final operator experience bundle-first, with email used for summary and notification rather than as the primary artifact transport.
6. Require every evaluation run to declare an explicit scope.

## Non-Goals

- automatic bug fixing or self-remediation as part of this feature
- exposing model chain-of-thought or provider thinking traces
- emailing raw logs or sensitive bundles as attachments by default
- building a global ranking or leaderboard in the initial rollout
- replacing all existing observability surfaces in one step

## Product Decisions

1. The feature name is Agent Evaluation.
2. The canonical output is a stored evaluation bundle plus structured JSON plus markdown report.
3. Email is summary-only and should link back to the stored evaluation rather than carry raw evidence.
4. Deterministic analyzers are the source of truth; LLM narrative is commentary over facts, not the other way around.
5. The core engine must be domain-agnostic, with trading and non-trading analyzers plugged into it.
6. Trading-specific sections must disappear cleanly when an agent has no trading capability.
7. Sensitive data must be redacted before storage in user-facing artifacts and before any email summary is generated.
8. Environment-specific collectors such as Docker logs or Redis snapshots must be best-effort and adapter-based, not assumed everywhere.
9. Only one active evaluation run should exist per agent and scope unless an operator explicitly forces a rerun.
10. Deterministic JSON and markdown reports are the Level 1 requirement; container-log collection and LLM narrative are optional follow-ups.

## High-Level Architecture

The feature should be split into six layers.

1. Evaluation contract layer.  
   Place shared types, DTOs, rubric shapes, finding severity enums, artifact manifest contracts, and scope definitions in `packages/domain/src`.

2. Shared evaluation data access layer.  
   Extract reusable evidence read-model assembly out of route-local code such as `apps/api/src/routes/exports.ts` into a shared package-level surface. Worker collectors must consume this shared layer rather than duplicating API route logic or importing from the API app.

3. Evidence collection layer.  
   Build collectors that assemble facts from existing surfaces:
   - export bundle from `apps/api/src/routes/exports.ts`
   - trading analytics from `packages/db/src/repositories.ts`
   - runtime sessions, journal events, costs, memory summaries, and other DB-backed state
   - optional Redis snapshots
   - optional container or worker logs

4. Evaluation engine layer.  
   Run deterministic analyzers over the collected evidence and produce:
   - normalized findings
   - section scores
   - artifact manifest
   - structured summary facts

5. Narrative layer.  
   Optionally call an LLM with a tightly scoped facts payload to produce a readable `REPORT.md`. The LLM must never be the only source of any finding.

6. Delivery layer.  
   Expose results through API, web UI, downloads, and later email summaries.

## Delivery Phases

This feature should be implemented as one plan with three explicit levels.

### Level 1: Operator-Grade Automatic Evaluation

#### Outcome

A developer or operator can trigger an evaluation for an agent and receive:

- an evidence bundle
- a structured JSON scorecard
- a markdown report

This level replaces the current mostly manual prompt-following flow with a repeatable evaluation job.

#### Scope

- on-demand evaluation only
- internal or operator-facing endpoint first
- trading support first
- non-trading-safe core behavior
- explicit scope required in the request
- no user-facing history UI yet
- no email yet
- no hard dependency on container-log collection
- no hard dependency on LLM narrative generation

#### Implementation Plan

1. Define core contracts in `packages/domain/src`.
   Add types for:
   - evaluation run request
   - evaluation scope
   - evaluation run result
   - finding
   - evidence reference
   - analyzer output
   - scorecard sections
   - artifact manifest
   - active-run dedupe semantics

2. Extract shared evaluation data loaders from route-local code before building worker collectors.
   The current export bundle and related evidence assembly should move out of `apps/api/src/routes/exports.ts` into a shared package-level surface that both API and worker can use safely.

3. Build a bundle assembler in `apps/worker/src` or a closely related shared module.
   It should gather:
   - agent export bundle
   - analytics
   - runtime sessions
   - journal events
   - relevant DB rows
   - cost records
   - optional Redis and logs when available

4. Extend the current export and evidence surfaces where necessary.
   The existing bundle in `apps/api/src/routes/exports.ts` is too narrow for full evaluation. Expand reusable data access first instead of stuffing all logic into one route.

5. Implement deterministic analyzers.
   Shared analyzers:
   - session health
   - tool failure rate
   - token and cost usage
   - security redaction checks
   - persistence completeness
   - runtime anomaly detection

   Trading analyzers:
   - fills and positions
   - realized and unrealized PnL
   - hold vs trade behavior
   - wake-signal and trigger analysis
   - market-data availability
   - rate-limit anomalies
   - restriction enforcement
   - reconciliation or drift anomalies

   All non-trivial analyzers should be backed by explicit rules or thresholds, ideally sourced from operator config rather than hard-coded literals.

6. Add a report writer.
   First produce structured JSON and markdown directly from deterministic findings. Optional LLM narrative generation can be added on top of the facts payload after the deterministic report is stable.

7. Add an internal API surface in `apps/api/src/routes`.
   Needed endpoints:
   - trigger evaluation
   - fetch evaluation status
   - download artifacts
   - fetch structured results

   This API surface should define what happens when a matching active run already exists for the same agent and scope.

8. Store artifacts through a simple storage abstraction.
   The implementation may start with local disk for development, but the contract must live in a shared package-level surface. API artifact downloads should not depend on importing worker code.

9. Add focused tests.
   Cover:
   - deterministic analyzers
   - evidence manifest correctness
   - non-trading agents omitting trading-specific findings
   - report generation without LLM
   - redaction rules
   - scope handling
   - active-run dedupe or locking behavior
   - timeout or retry behavior

#### Level 1 Exit Criteria

- An operator can trigger evaluation for one agent.
- The run is explicitly scoped.
- The system produces bundle, JSON, and `REPORT.md`.
- Findings are evidence-backed and severity-tagged.
- Non-trading agents do not get fake trading findings.
- Only one active run per agent and scope is allowed unless explicitly overridden.
- LLM output is optional, not required for correctness.

#### Estimated Effort

7 to 10 engineering days.

### Level 2: Productized Evaluation

#### Outcome

Agent Evaluation becomes a real product surface rather than an operator tool.

#### Scope

- persisted evaluation runs
- history per agent
- UI in the agent detail area
- scheduled and event-triggered evaluations
- email summary notifications
- user-facing permissions and retention behavior

#### Implementation Plan

1. Add persistence in `packages/db/src`.
   Introduce evaluation-oriented tables for:
   - evaluation runs
   - evaluation findings
   - artifact manifests
   - delivery state

2. Add user-facing API routes in `apps/api/src/routes`.
   Needed capabilities:
   - list evaluations for an agent
   - fetch one evaluation
   - trigger evaluation
   - download bundle
   - fetch report and findings separately

3. Build a web surface in `apps/web/src/features/agents`.
   Add:
   - Evaluations tab on the agent detail page
   - run-now action
   - status history
   - finding summaries
   - download link for full bundle
   - report viewer

4. Add automation triggers in `apps/worker/src`.
   Trigger sources should include:
   - manual run
   - session stop
   - trade-test completion
   - optional scheduled digest

5. Add email summaries.
   Email should contain:
   - run timestamp
   - top findings
   - scores
   - secure link back to the product
   It should not attach raw logs or the full bundle by default.

6. Improve rubric richness.
   Expand scoring into clear sections such as:
   - behavior
   - performance
   - reliability
   - cost
   - security
   - data quality

7. Add retention, access control, and redaction policy.
   Users should only see their own evaluations and sanitized evidence.

8. Add integration tests across API, worker, and UI.

9. Add timeout, retry, and observability policy for evaluation runs.
   Long-running jobs should have explicit runtime limits, retry semantics, and enough logging or metrics that a stuck `running` evaluation is visible quickly.

#### Level 2 Exit Criteria

- Users can view evaluation history for an agent.
- Users can run an evaluation from the UI or API.
- Scheduled or lifecycle-triggered evaluations work.
- Email summary notifications work with secure deep links.
- Stored evaluations are permissioned and redact-sensitive.

#### Estimated Effort

1 to 2 weeks.

### Level 3: General Evaluation Framework

#### Outcome

The system becomes a reusable evaluation framework for both trading and non-trading agents.

#### Scope

- plugin-based analyzers
- generic evidence collectors
- evaluation presets by capability family
- cross-domain scoring
- clean extension path for future agent types

#### Implementation Plan

1. Formalize plugin contracts in `packages/domain/src`.
   Separate:
   - core analyzer interface
   - evidence collector interface
   - section renderer interface
   - scoring policy interface

2. Split analyzers into packs.
   Initial packs:
   - shared core pack
   - trading pack
   - non-trading pack
   - security pack
   - cost pack

3. Implement non-trading evaluation dimensions.
   Examples:
   - task completion quality
   - tool selection quality
   - tool success and failure patterns
   - latency and turnaround
   - outbound communication quality
   - artifact generation quality
   - policy and boundary compliance

4. Add preset selection by capability family.
   A trading agent should receive shared plus trading analyzers. A non-trading agent should receive shared plus non-trading analyzers. Mixed agents should receive both.

5. Keep delivery generic.
   The UI, API, bundle, and email surfaces should render from the normalized schema rather than special-case trading logic.

6. Add extension tests proving that a new analyzer pack can be added without changing the core pipeline.

#### Level 3 Exit Criteria

- The same engine evaluates trading and non-trading agents.
- Domain-specific analyzers plug into one shared core.
- Delivery surfaces remain schema-driven.
- New analyzer packs can be added without invasive rewrites.

#### Estimated Effort

2 to 4 weeks.

## Recommended Build Order

1. Start with Level 1 contracts and deterministic analyzers.
2. Extract shared evaluation data access before writing worker collectors.
3. Do not start with email.
4. Keep storage abstract from day one.
5. Make redaction mandatory before any persisted report or summary is exposed.
6. Build the non-trading-safe core before expanding trading-specific richness.
7. Productize only after the evidence model is stable.
8. Generalize into plugins only after Level 2 proves the schema is strong enough.

## Risks And Caveats

1. Behavior attribution will be weak unless wake reasons, tool-call outcomes, and decision summaries are persisted in a structured way.
2. Environment-dependent evidence such as Docker logs may not exist uniformly across local Docker, Hetzner, and future Nomad deployment.
3. Raw evidence may contain secrets, tokens, or sensitive prompts and must be redacted.
4. The actor model and evaluator model should be separated where possible to reduce bias in narrative generation.
5. Bundle size can grow quickly; retention policy and storage quotas matter early.
6. The current export bundle is useful but insufficient as the only evaluation input.
7. Running multiple overlapping evaluations against the same scope can produce confusing or contradictory artifacts unless deduped or locked.
8. Without explicit scope, the first implementation will immediately drift into ambiguity over whether to collect latest-session, all-time, or arbitrary historical evidence.

## Validation Strategy

For each level, validation should include:

- unit tests for analyzers and redaction
- integration tests for run orchestration
- API tests for trigger and retrieval flows
- UI tests once Level 2 begins
- one operator-run end-to-end evaluation against a real agent session before closing the phase

## Final Recommendation

Implement this as one phased plan, not three separate plans.

Level 1 should deliver immediate operator value. Level 2 should turn it into a product surface. Level 3 should turn it into a reusable evaluation framework that supports non-trading agents cleanly.