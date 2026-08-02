# Agent Evaluation — Implementation Plan (Revised)

**Status:** Done  
**Created:** 2026-06-28  
**Feature ID:** 001-agent-evaluation  
**Supersedes:** `002-implementation-plan.md` (retains intent, fixes architectural gaps)

## Changes From Original Plan

1. Added Phase 0: extract reusable data loaders from `exports.ts` into `packages/db/` before building collectors.
2. Moved storage interface to `packages/domain/` and storage implementation + job contract to `packages/db/` so both API (artifact downloads) and worker (artifact writes) share them without violating dependency direction.
3. Added explicit evaluation scope (session, time-range, latest-session, all-time) to the run request contract.
4. Added scope-aware concurrency control: one active evaluation per agent per normalized scope.
5. Added timeout/cancellation model with configurable `maxRuntimeMs`.
6. Added retry semantics and `attempt` counter.
7. Moved shared job types to `packages/db/` (the shared infra layer both apps already depend on).
8. Added observability requirements (structured logging, dead-run reaper).
9. Actor-based requester provenance (user/system/agent) instead of mandatory user FK, supporting system-triggered and scheduled evaluations.

## Execution Rules

1. Build Level 1 only. Do not start Level 2 until Level 1 runs against a real agent.
2. Deterministic evidence and analysis is the source of truth. LLM narrative is optional.
3. Trading-specific analysis lives in a dedicated analyzer. The core pipeline must stay valid for non-trading agents.
4. Do not turn `exports.ts` into the evaluator. Extract data loaders, keep evaluation orchestration in dedicated modules.
5. Evaluations run in the worker via BullMQ, never in request/response handlers.
6. After each phase, run the smallest useful validation before moving on.

## Package Dependency Direction

```
packages/domain  ←  packages/db  ←  apps/worker
                                  ←  apps/api
```

New evaluation code must respect this. Shared types and interfaces live in `domain`. DB access in `db`. Orchestration in `worker`. HTTP surface in `api`.

## Proposed File Layout

### Domain contracts and interfaces

```
packages/domain/src/agent-evaluation.ts       # types, enums, DTOs, storage port
packages/domain/src/index.ts                  # re-export
```

### DB schema, repository, and shared infra

```
packages/db/src/schema/agent-evaluations.ts
packages/db/src/schema/index.ts               # re-export
packages/db/src/agent-evaluation-repository.ts
packages/db/src/agent-evidence-loaders.ts     # extracted from exports.ts
packages/db/src/agent-evaluation-storage-fs.ts # FS implementation of storage port (shared by API + worker)
packages/db/src/agent-evaluation-job.ts       # job contract (shared by API enqueue + worker consume)
packages/db/src/index.ts                      # re-export
packages/db/drizzle/XXXX_agent_evaluations.sql
```

### Worker evaluation modules

```
apps/worker/src/agent-evaluation/index.ts
apps/worker/src/agent-evaluation/evaluation-runtime.ts
apps/worker/src/agent-evaluation/run-evaluation.ts
apps/worker/src/agent-evaluation/render-report.ts
apps/worker/src/agent-evaluation/redaction.ts
apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts
apps/worker/src/agent-evaluation/collectors/redis-snapshot.ts
apps/worker/src/agent-evaluation/collectors/container-logs.ts
apps/worker/src/agent-evaluation/analyzers/core.ts
apps/worker/src/agent-evaluation/analyzers/trading.ts
apps/worker/src/agent-evaluation/analyzers/security.ts
```

### API routes

```
apps/api/src/routes/agent-evaluations.ts
```

### Tests

```
packages/db/src/agent-evidence-loaders.test.ts
packages/db/src/agent-evaluation-storage-fs.test.ts
apps/worker/src/agent-evaluation/run-evaluation.test.ts
apps/worker/src/agent-evaluation/analyzers/core.test.ts
apps/worker/src/agent-evaluation/analyzers/trading.test.ts
apps/worker/src/agent-evaluation/redaction.test.ts
apps/api/src/routes/agent-evaluations.test.ts
```

---

## Level 1 — Operator-Grade Automatic Evaluation

### Phase 0: Extract reusable data loaders from exports.ts

#### Goal

Move the data-fetching logic (fills for agent + agent-owned bots, journal events, sessions, positions) out of route handlers into a shared repository module so both the API and the worker can use it.

#### File targets

- `packages/db/src/agent-evidence-loaders.ts` (new)
- `packages/db/src/index.ts` (re-export)
- `apps/api/src/routes/exports.ts` (refactor to call the shared loaders)

#### Tasks

- [ ] Extract `loadAgentFills(db, agentId, opts?: { from?, to? })` from the agent trades export route.
- [ ] Extract `loadAgentJournalEvents(db, agentId, opts?: { from?, to? })` from the agent journal export route.
- [ ] Extract `loadAgentRuntimeSessions(db, agentId, opts?: { from?, to? })`.
- [ ] Extract `loadAgentPositions(db, agentId, opts?: { at?: Date })` — scope-aware: when `at` is provided, returns positions as of that timestamp (for session-end or time-range-end snapshot); when omitted, returns current positions.
- [ ] Extract `loadAgentBotIds(db, agentId)` helper (shared across all loaders).
- [ ] Refactor `exports.ts` routes to call the new shared loaders.
- [ ] Export from `packages/db/src/index.ts`.

#### Validation

- [ ] Existing export route tests still pass.
- [ ] `pnpm lint`

#### Stop rule

Do not build evaluation contracts until the shared loaders work and exports.ts is refactored.

---

### Phase 1: Define core evaluation contracts

#### Goal

Create shared types for evaluation runs, findings, artifacts, scores, scopes, and the storage port.

#### File targets

- `packages/domain/src/agent-evaluation.ts`
- `packages/domain/src/index.ts`

#### Types to define

```typescript
/**
 * What time window the evaluation covers.
 *
 * Scope resolution rules:
 * - `session` and `timeRange` are concrete — used as-is by loaders.
 * - `latestSession` is resolved to a concrete `session` at enqueue time (not execution time).
 *   The API/enqueue layer looks up the most recent completed session for the agent,
 *   stores the resolved sessionId, and persists both the original requested scope and
 *   the resolved scope in the run metadata.
 * - `allTime` is an explicit override, not the default. Level 1 defaults to `latestSession`.
 */
type EvaluationScope =
  | { type: 'session'; sessionId: string }
  | { type: 'latestSession' }              // resolved at enqueue time to concrete session
  | { type: 'timeRange'; from: Date; to: Date }
  | { type: 'allTime' };                   // explicit override only

/**
 * The concrete scope after resolution. This is what the worker actually uses.
 * `latestSession` is never seen here — it has been resolved to `session`.
 */
type ResolvedEvaluationScope =
  | { type: 'session'; sessionId: string }
  | { type: 'timeRange'; from: Date; to: Date }
  | { type: 'allTime' };

type EvaluationTrigger = 'manual' | 'session_stop' | 'scheduled' | 'trade_test';

/** Who requested the evaluation. Mirrors the codebase actor model. */
type EvaluationRequester =
  | { type: 'user'; id: string }
  | { type: 'system' }                     // scheduled, session-stop, trade-test
  | { type: 'agent'; id: string };         // agent self-evaluation (future)

type EvaluationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out';

type EvaluationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type EvaluationSectionKey =
  | 'session_health'
  | 'tool_usage'
  | 'cost'
  | 'security'
  | 'persistence'
  | 'trading_performance'
  | 'trading_behavior'
  | 'market_data'
  | 'rate_limits';

interface EvaluationFinding {
  section: EvaluationSectionKey;
  severity: EvaluationSeverity;
  code: string;              // e.g. 'trading.high_drawdown'
  title: string;
  detail: string;
  evidence?: string;         // reference to artifact or data point
}

interface EvaluationSectionScore {
  section: EvaluationSectionKey;
  score: number;             // 0-100
  findings: EvaluationFinding[];
  applicable: boolean;       // false → section skipped for this agent type
}

interface EvaluationScorecard {
  overallScore: number;
  sections: EvaluationSectionScore[];
}

interface EvaluationArtifactRef {
  name: string;              // e.g. 'evaluation.json', 'REPORT.md', 'fills.csv'
  mimeType: string;
  sizeBytes: number;
}

interface EvaluationRunResult {
  scorecard: EvaluationScorecard;
  artifactManifest: EvaluationArtifactRef[];
  summary: { totalFindings: number; criticalCount: number; highCount: number };
}

interface EvaluationRunRequest {
  agentId: string;
  scope: EvaluationScope;
  trigger: EvaluationTrigger;
  requester: EvaluationRequester;
  /** If true, include optional LLM narrative in REPORT.md */
  includeNarrative?: boolean;
}

/** Persisted run metadata includes both requested and resolved scope. */
interface EvaluationRunRecord {
  id: string;
  agentId: string;
  status: EvaluationRunStatus;
  trigger: EvaluationTrigger;
  requestedScope: EvaluationScope;       // what the caller asked for
  resolvedScope: ResolvedEvaluationScope; // what the worker evaluates against
  scopeKey: string;                       // dedupe key (from resolved scope)
  requester: EvaluationRequester;
  requestedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  timedOutAt?: Date;
  attempt: number;
  result?: EvaluationRunResult;
}

/** Storage port — lives in domain so both API and worker can reference it. */
interface EvaluationArtifactStore {
  write(runId: string, name: string, content: Uint8Array | string): Promise<EvaluationArtifactRef>;
  read(runId: string, name: string): Promise<Uint8Array | null>;
  list(runId: string): Promise<EvaluationArtifactRef[]>;
}
```

Note: `Uint8Array` instead of `Buffer` keeps the domain contract runtime-neutral.

#### Tasks

- [ ] Define all types above.
- [ ] Export from domain barrel.

#### Validation

- [ ] `pnpm lint`

---

### Phase 2: Add DB persistence for evaluation runs

#### Goal

Persist run metadata so the queue can report status, enforce concurrency limits, and Level 2 history is additive.

#### File targets

- `packages/db/src/schema/agent-evaluations.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/agent-evaluation-repository.ts`
- `packages/db/src/index.ts`
- migration in `packages/db/drizzle/`

#### Schema

```sql
CREATE TABLE agent_evaluations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id),
  status        TEXT NOT NULL DEFAULT 'queued',
  trigger       TEXT NOT NULL,
  requested_scope_json  JSONB NOT NULL,  -- original caller intent (may be latestSession)
  resolved_scope_json   JSONB NOT NULL,  -- concrete scope used by worker (always session/timeRange/allTime)
  -- Normalized scope key for dedupe (always derived from resolved scope)
  scope_key     TEXT NOT NULL,
  -- Actor-based provenance: supports user, system, agent requesters
  requested_by_type TEXT NOT NULL,  -- 'user' | 'system' | 'agent'
  requested_by_id   UUID,           -- null for system-triggered
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  timed_out_at  TIMESTAMPTZ,
  attempt       INTEGER NOT NULL DEFAULT 1,
  error_code    TEXT,
  error_message TEXT,
  scorecard_json    JSONB,
  summary_json      JSONB,
  artifact_manifest JSONB,
  -- Scope-aware dedupe: only one active run per agent per resolved scope
  CONSTRAINT one_active_per_agent_scope EXCLUDE USING btree (agent_id WITH =, scope_key WITH =)
    WHERE (status IN ('queued', 'running'))
);

CREATE INDEX idx_agent_evaluations_agent_id ON agent_evaluations(agent_id);
CREATE INDEX idx_agent_evaluations_status ON agent_evaluations(status);
```

**Scope resolution and dedupe key derivation (all happen at enqueue time, not execution time):**

- `{ type: 'session', sessionId: 'abc' }` → resolved: same → key: `"session:abc"`
- `{ type: 'latestSession' }` → resolved: `{ type: 'session', sessionId: '<looked-up-id>' }` → key: `"session:<looked-up-id>"`
- `{ type: 'timeRange', from, to }` → resolved: same → key: `"range:<from_iso>-<to_iso>"`
- `{ type: 'allTime' }` → resolved: same → key: `"allTime"`

`latestSession` is never stored as the resolved scope — it is always expanded to the concrete session before the row is inserted. This eliminates races where the "latest" session changes between enqueue and execution.

#### Repository methods

- `resolveScope(db, agentId, scope: EvaluationScope): Promise<ResolvedEvaluationScope>` — resolves `latestSession` to concrete session (throws if no session found). All other scope types pass through.
- `normalizeScopeKey(resolved: ResolvedEvaluationScope): string` — deterministic key from resolved scope only.
- `createRun(request: EvaluationRunRequest, resolved: ResolvedEvaluationScope): Promise<{ id: string }>`
- `markRunning(id: string): Promise<boolean>`
- `markSucceeded(id: string, result: EvaluationRunResult): Promise<void>`
- `markFailed(id: string, code: string, message: string): Promise<void>`
- `markTimedOut(id: string): Promise<void>`
- `getRun(id: string): Promise<EvaluationRunRecord | null>`
- `listByAgent(agentId: string, opts?: { limit, offset }): Promise<EvaluationRunRecord[]>`
- `hasActiveRunForScope(agentId: string, scopeKey: string): Promise<boolean>`

#### Tasks

- [ ] Create schema file with both `requested_scope_json` and `resolved_scope_json` columns.
- [ ] Export from schema barrel.
- [ ] Generate migration with `drizzle-kit generate`.
- [ ] Implement `resolveScope()` — queries latest completed session for `latestSession`, passes through otherwise.
- [ ] Implement `normalizeScopeKey()` — operates on `ResolvedEvaluationScope` only (never sees `latestSession`).
- [ ] Implement remaining repository methods.
- [ ] Export from db barrel.

#### Validation

- [ ] `pnpm lint`
- [ ] Repository unit test: create → markRunning → markSucceeded lifecycle.
- [ ] Repository unit test: `hasActiveRunForScope` returns true when a queued/running row exists for same scope.
- [ ] Repository unit test: different scopes for same agent do not conflict.
- [ ] Repository unit test: `resolveScope` with `latestSession` returns the concrete session ID of the most recent completed session.
- [ ] Repository unit test: `resolveScope` with `latestSession` throws if agent has no completed sessions.

#### Stop rule

Do not build queue handlers until status persistence works.

---

### Phase 3: Add the evaluation queue and runtime shell

#### Goal

Run evaluations asynchronously via BullMQ, matching the pattern in `backtest-runtime.ts`.

#### File targets

- `apps/worker/src/agent-evaluation/evaluation-runtime.ts`
- `apps/worker/src/agent-evaluation/index.ts`
- `apps/worker/src/index.ts` (wire up)

#### Job contract (defined in `packages/db/src/agent-evaluation-job.ts`, shared by API and worker)

```typescript
export const EVALUATION_QUEUE_NAME = 'agent-evaluations';

export interface EvaluationJobData {
  runId: string;
  agentId: string;
  /** Always the resolved scope — latestSession has been expanded before enqueue. */
  resolvedScope: ResolvedEvaluationScope;
  includeNarrative: boolean;
}
```

#### Tasks

- [ ] Define job contract in `packages/db/src/agent-evaluation-job.ts` and export from barrel.
- [ ] Create `EvaluationRuntime` class in worker (mirrors `BacktestRuntime` pattern).
- [ ] In the job handler: transition `queued → running → succeeded/failed`.
- [ ] Add BullMQ job timeout via `jobOptions.timeout` set from operator config `evaluation.maxRuntimeMs` (default 120_000).
- [ ] On timeout, call `markTimedOut()`.
- [ ] Deduplicate: before enqueuing, check `hasActiveRunForScope(agentId, scopeKey)`. Reject with 409 if one exists for the same scope.
- [ ] Job handler receives only `ResolvedEvaluationScope` — never needs to resolve `latestSession`.
- [ ] Wire runtime startup in `apps/worker/src/index.ts`.

#### Validation

- [ ] Unit test: no-op run transitions queued → running → succeeded.
- [ ] Unit test: duplicate enqueue for same scope is rejected.
- [ ] Unit test: different scopes for same agent can run in parallel.
- [ ] `pnpm lint`

#### Stop rule

Do not start evidence collectors until a no-op run completes the full lifecycle.

---

### Phase 4: Implement the filesystem artifact store

#### Goal

Store evidence bundles behind the `EvaluationArtifactStore` port. The implementation lives in `packages/db/` (shared infra) so both API (downloads) and worker (writes) can use it without cross-app imports.

#### File targets

- `packages/db/src/agent-evaluation-storage-fs.ts`
- `packages/db/src/index.ts` (re-export)

#### Tasks

- [ ] Implement `EvaluationArtifactStore` backed by a configurable root directory (default `.ignore/evaluations/<runId>/`).
- [ ] Paths are derived from `runId` only (no agent-id in path to avoid collisions with re-evaluations).
- [ ] `write()` creates directory if needed, returns ref with `mimeType` derived at write time and stored in manifest.
- [ ] `read()` returns null if file missing.
- [ ] `list()` scans directory.
- [ ] Accept `Uint8Array | string` per the domain contract (convert internally to Buffer for fs ops).

#### Validation

- [ ] Unit test: write → list → read roundtrip.
- [ ] `pnpm lint`

---

### Phase 5: Implement evidence collectors

#### Goal

Assemble deterministic evidence into the artifact store using the shared data loaders from Phase 0.

#### File targets

- `apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts`
- `apps/worker/src/agent-evaluation/collectors/redis-snapshot.ts` (best-effort)
- `apps/worker/src/agent-evaluation/collectors/container-logs.ts` (best-effort)

#### Evidence assembler responsibilities

The assembler is the single orchestrator. It calls the Phase 0 shared loaders and writes artifacts:

| Evidence | Source | Artifact |
|----------|--------|----------|
| Fills | `loadAgentFills()` | `fills.json` |
| Journal events | `loadAgentJournalEvents()` | `journal.json` |
| Runtime sessions | `loadAgentRuntimeSessions()` | `sessions.json` |
| Positions (scope-end snapshot) | `loadAgentPositions(at: scopeEndTimestamp)` | `positions.json` |
| Billing/cost | `UsageBillingRepository` | `costs.json` |
| Agent config & metadata | `AgentRepository` | `agent-metadata.json` |
| Skills/capabilities | `agentSkills` table | included in metadata |
| Redis state | Redis adapter (best-effort) | `redis-snapshot.json` |
| Container logs | shell/adapter (best-effort) | `container-logs.txt` |

The assembler returns a typed `EvidenceManifest` listing what was collected and what failed (with reason).

#### Scope filtering

The evidence assembler receives a `ResolvedEvaluationScope` (never `latestSession` — that was resolved at enqueue). All loaders respect the resolved scope:

- `session` → look up session start/end timestamps, filter all loaders by that window. Positions snapshot at session end.
- `timeRange` → filter by `from`/`to`. Positions snapshot at `to`.
- `allTime` → no time filter for event-based loaders. Positions snapshot at current time.

`latestSession` is never seen by collectors — it was resolved to a concrete `session` before the job was enqueued.

#### Tasks

- [ ] Implement `assembleEvidence(ctx)` that calls loaders and writes to store.
- [ ] Return `EvidenceManifest` with success/failure per evidence type.
- [ ] Redis snapshot: catch and record failure, do not abort.
- [ ] Container logs: catch and record failure, do not abort.

#### Validation

- [ ] Unit test with mocked DB loaders: manifest contains expected artifact refs.
- [ ] Unit test: failed Redis does not abort collection.
- [ ] `pnpm lint`

#### Stop rule

Do not write analyzers until the evidence manifest is stable.

---

### Phase 6: Implement deterministic analyzers

#### Goal

Generate findings and section scores from collected evidence without LLM involvement.

#### File targets

- `apps/worker/src/agent-evaluation/analyzers/core.ts`
- `apps/worker/src/agent-evaluation/analyzers/trading.ts`
- `apps/worker/src/agent-evaluation/analyzers/security.ts`

#### Core analyzer (always runs)

| Check | Condition → Finding |
|-------|---------------------|
| Session health | No sessions in scope → `critical: no_sessions` |
| Session crashes | Any session with `error` status → `high: session_crashed` |
| Tool failures | Failure rate > threshold (default 20%) → `medium: high_tool_failure_rate` |
| Cost visibility | No billing events → `low: no_cost_data` |
| Persistence | Agent has no journal events → `medium: no_journal_entries` |
| Runtime duration | Session lasted < 60s → `info: very_short_session` |

#### Trading analyzer (runs only if agent has trading capability or fills exist)

| Check | Condition → Finding |
|-------|---------------------|
| No fills | Zero fills in scope → `info: no_trading_activity` |
| Large drawdown | Max drawdown > configurable threshold → `high: high_drawdown` |
| Negative expectancy | Expectancy < 0 → `medium: negative_expectancy` |
| Unrealized exposure | Open positions exist at session end → `info: open_positions_at_end` |
| Rate limit hits | Journal events with rate-limit codes > N → `medium: rate_limit_anomaly` |
| Hold time anomaly | Average hold < 30s (possible churn) → `low: very_short_holds` |

#### Security analyzer (always runs)

| Check | Condition → Finding |
|-------|---------------------|
| Secret leakage | Regex scan of journal/logs for API key patterns → `critical: possible_secret_leak` |
| Thinking traces | LLM thinking blocks in stored messages → `high: thinking_trace_leaked` |

#### Threshold configuration

All numeric thresholds come from operator config under `evaluation.thresholds.*`. Analyzers receive a typed thresholds object — no magic numbers.

#### Additional file targets for config

- `packages/domain/src/config/` — add `EvaluationThresholds` type to the config schema.
- `config/default.yaml` — add `evaluation.thresholds` section with defaults for each analyzer check.

#### Tasks

- [ ] Define `EvaluationThresholds` interface in the domain config schema (tool failure rate %, drawdown %, hold time floor, rate-limit count, etc.).
- [ ] Add default values under `evaluation.thresholds.*` in `config/default.yaml`.
- [ ] Implement each analyzer as a function `(evidence: EvidenceManifest, store: ArtifactStore, thresholds: T) → EvaluationSectionScore`.
- [ ] Trading analyzer returns `{ applicable: false }` when no trading capability detected.
- [ ] Security analyzer uses pre-compiled regexes for common key formats.

#### Validation

- [ ] Core analyzer unit tests with synthetic evidence.
- [ ] Trading analyzer unit test: returns not-applicable for non-trading agent.
- [ ] Trading analyzer unit test: flags high drawdown above threshold.
- [ ] Security analyzer unit test: detects `sk-...` pattern in journal text.
- [ ] `pnpm lint`

---

### Phase 7: Implement report rendering and run orchestration

#### Goal

Wire everything together: collect evidence → analyze → render → persist result.

#### File targets

- `apps/worker/src/agent-evaluation/run-evaluation.ts`
- `apps/worker/src/agent-evaluation/render-report.ts`
- `apps/worker/src/agent-evaluation/redaction.ts`

#### Report rendering

- `evaluation.json`: full structured `EvaluationRunResult`.
- `REPORT.md`: deterministic markdown generated from findings (grouped by section, sorted by severity). No LLM needed.
- If `includeNarrative` is true and an LLM provider is available: append a "Commentary" section generated from a tightly-scoped facts payload (scorecard + top findings, no raw evidence).

#### Redaction

Before writing any user-facing artifact:
- Strip strings matching secret regex patterns.
- Truncate overly large evidence blobs.
- Remove raw prompt/response pairs (summarize instead).

#### Orchestration (`runEvaluation`)

```
1. Load run metadata from DB (includes resolvedScope)
2. assembleEvidence(resolvedScope, store)
3. Run analyzers over evidence
4. Compose scorecard
5. Redact and render report
6. Write evaluation.json and REPORT.md to store
7. markSucceeded(runId, result)
```

On any unhandled error: `markFailed(runId, code, message)`.

#### Tasks

- [ ] Implement `runEvaluation()` orchestrator.
- [ ] Implement `renderReport()` — pure function from scorecard to markdown string.
- [ ] Implement `redact()` — applied to all text artifacts before write.
- [ ] Wire `runEvaluation` as the BullMQ job handler in the runtime.

#### Validation

- [ ] Integration test: seeded DB data → trigger run → verify `evaluation.json` and `REPORT.md` exist in store.
- [ ] Unit test: `renderReport` produces valid markdown with section headers.
- [ ] Unit test: redaction strips `sk-proj-...` patterns.
- [ ] `pnpm lint`

---

### Phase 8: Expose internal API routes

#### Goal

Let operators trigger, inspect, and download evaluations via HTTP.

#### File targets

- `apps/api/src/routes/agent-evaluations.ts`
- `apps/api/src/index.ts` (register route)

#### Routes

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/agents/:id/evaluations` | Validates scope, checks no active run for same scope, enqueues, returns `{ runId }` |
| GET | `/agents/:id/evaluations` | Lists runs for agent (paginated) |
| GET | `/agents/:id/evaluations/:runId` | Returns run status, scorecard, summary |
| GET | `/agents/:id/evaluations/:runId/artifacts` | Returns artifact manifest |
| GET | `/agents/:id/evaluations/:runId/artifacts/:name` | Streams artifact file with `Content-Type` from persisted manifest metadata |

#### Tasks

- [ ] Implement routes.
- [ ] POST resolves scope at enqueue time: calls `resolveScope(db, agentId, scope)` to expand `latestSession` → concrete session. Returns 404 if `latestSession` and no completed session exists.
- [ ] POST returns 409 if `hasActiveRunForScope(agentId, scopeKey)` is true (using resolved scope key).
- [ ] POST validates `scope` with Zod. `allTime` requires explicit opt-in (`allowAllTime: true` query param or a dedicated operator-only route); default scope is `latestSession`.
- [ ] POST sets `requester: { type: 'user', id: request.userId }` for manual triggers.
- [ ] GET artifact streams with `Content-Type` read from the persisted `artifact_manifest` JSONB (not filename heuristics).
- [ ] All user-triggered routes enforce ownership (agent belongs to `request.userId`). System-triggered runs are enqueued internally without ownership checks.

#### Validation

- [ ] Route test: POST enqueues and returns runId.
- [ ] Route test: POST returns 409 on duplicate.
- [ ] Route test: GET artifacts returns 404 for unknown name.
- [ ] `pnpm lint`

---

### Phase 9: Add observability and dead-run reaper

#### Goal

Ensure failed or stuck evaluations are visible and recoverable.

#### Tasks

- [ ] Add structured pino logging throughout the evaluation pipeline (start, evidence collected, analyzers complete, rendered, done).
- [ ] Add a periodic reaper in the worker that marks runs stuck in `running` for longer than `2 × maxRuntimeMs` as `timed_out`.
- [ ] Log reaper actions at `warn` level.

#### Validation

- [ ] Unit test: reaper transitions stale runs.
- [ ] `pnpm lint`

---

## Level 1 Acceptance Checklist

- [ ] One agent evaluation can be enqueued and completed asynchronously.
- [ ] Evaluation scope (session / latest-session / time-range / all-time) is respected by evidence collection.
- [ ] `latestSession` is resolved to a concrete session ID at enqueue time, not execution time.
- [ ] Both requested scope and resolved scope are persisted in the run record.
- [ ] Only one evaluation runs per agent per resolved scope at a time (409 on duplicate).
- [ ] `allTime` requires explicit opt-in; default Level 1 path is `latestSession`.
- [ ] Run metadata is persisted in the DB with attempt count and actor-based requester provenance.
- [ ] Artifacts are written through the storage abstraction (shared `packages/db/` implementation).
- [ ] `evaluation.json` and `REPORT.md` are produced.
- [ ] Findings are deterministic, evidence-backed, and severity-tagged.
- [ ] Non-trading agents do not receive fake trading findings (section marked not-applicable).
- [ ] LLM narrative is optional and gated by request parameter.
- [ ] Artifacts are redacted before persistence.
- [ ] Stuck runs are reaped after timeout.
- [ ] All route tests and evaluator tests pass.
- [ ] `pnpm lint` passes.

---

## Level 2 — Productized Evaluation

Do not start until Level 1 has run against at least one real agent session.

### Phase 10: List/history API and richer queries

- [ ] Paginated listing with filters (status, date range).
- [ ] Summary payloads for history views.
- [ ] Web client bindings.

### Phase 11: Agent-detail evaluation UI

- [ ] Evaluation panel/tab on agent detail page.
- [ ] Run-now button.
- [ ] Status display, finding summary, artifact download.

### Phase 12: Scheduled and event-triggered evaluations

- [ ] Session-stop trigger: auto-enqueue on agent session end.
- [ ] Scheduled trigger: configurable cron per agent.
- [ ] Trigger provenance stored in run metadata.

### Phase 13: Email summaries

- [ ] Summary email with top findings, scores, and secure deep link.
- [ ] No raw evidence in email body or attachments.
- [ ] Respect user delivery preferences.

### Level 2 Acceptance Checklist

- [ ] Users can view evaluation history.
- [ ] Users can trigger from UI.
- [ ] Automatic triggers work.
- [ ] Email summaries work.
- [ ] UI tests and API tests pass.

---

## Level 3 — General Evaluation Framework

Only begin after Level 2 is stable.

### Phase 14: Formalize analyzer-pack plugin contract

- [ ] Define `AnalyzerPack` interface in domain.
- [ ] Move existing analyzers into explicit packs: `core`, `trading`, `security`.
- [ ] Pack selection driven by agent capability family.

### Phase 15: Add non-trading analyzers

- [ ] Task completion quality.
- [ ] Tool selection quality.
- [ ] Outbound communication quality.
- [ ] Artifact generation quality.

### Phase 16: Schema-driven delivery

- [ ] UI and report rendering consume normalized sections.
- [ ] Mixed-capability agents render both trading and non-trading sections.

### Level 3 Acceptance Checklist

- [ ] Same engine evaluates trading and non-trading agents.
- [ ] New analyzer packs plug in without changing core.
- [ ] Delivery surfaces are schema-driven.

---

## Files That Should Not Be First Edit Targets

- `apps/api/src/routes/exports.ts` — reuse-point only (Phase 0 extracts from it, does not add to it).
- `apps/api/src/routes/agents.ts` — later integration point.
- `apps/web/src/features/mission-control/MissionControlPage.tsx` — Level 2+ only.

---

## First Implementation Slice

If work starts now, the absolute minimum proving the execution model:

1. Phase 0: extract `loadAgentFills` and `loadAgentJournalEvents` (the two most used loaders).
2. Phase 1: define `EvaluationScope`, `ResolvedEvaluationScope`, `EvaluationRunRequest`, `EvaluationRunRecord`, `EvaluationRunResult`, `EvaluationArtifactStore`.
3. Phase 2: create `agent_evaluations` table with exclusion constraint + `resolveScope()` + `normalizeScopeKey()`.
4. Phase 3: wire BullMQ runtime with a no-op handler.
5. Phase 8 (minimal): one POST route that resolves `latestSession`, enqueues, returns `{ runId }`.
6. Validate: POST with `latestSession` → resolves concrete session → queued → running → succeeded with placeholder manifest.

That proves scope resolution at enqueue, scope-aware dedupe, async execution, and the storage interface before collector/analyzer complexity arrives.

---

## Estimated Effort

| Level | Phases | Estimate |
|-------|--------|----------|
| Level 1 | 0–9 | 8–12 engineering days |
| Level 2 | 10–13 | 5–8 engineering days |
| Level 3 | 14–16 | 5–10 engineering days |

Level 1 is larger than the original estimate because it correctly accounts for the data-loader extraction, concurrency control, timeout handling, and observability work that would otherwise become rework.
