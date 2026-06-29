/**
 * Agent Evaluation — shared domain contracts.
 *
 * These types define the evaluation pipeline contract: what can be requested,
 * how scope is resolved, what findings look like, and the artifact storage
 * port that both API (downloads) and worker (writes) consume.
 */

// ── Scope ───────────────────────────────────────────────────────────────────

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
export type EvaluationScope =
  | { type: 'session'; sessionId: string }
  | { type: 'latestSession' }
  | { type: 'timeRange'; from: Date; to: Date }
  | { type: 'allTime' };

/**
 * The concrete scope after resolution. This is what the worker actually uses.
 * `latestSession` is never seen here — it has been resolved to `session`.
 */
export type ResolvedEvaluationScope =
  | { type: 'session'; sessionId: string }
  | { type: 'timeRange'; from: Date; to: Date }
  | { type: 'allTime' };

// ── Trigger & Requester ─────────────────────────────────────────────────────

export type EvaluationTrigger = 'manual' | 'session_stop' | 'scheduled' | 'trade_test';

/** Who requested the evaluation. Mirrors the codebase actor model. */
export type EvaluationRequester =
  | { type: 'user'; id: string }
  | { type: 'system' }
  | { type: 'agent'; id: string };

// ── Run lifecycle ───────────────────────────────────────────────────────────

export type EvaluationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out';

// ── Findings ────────────────────────────────────────────────────────────────

export type EvaluationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type EvaluationSectionKey =
  | 'session_health'
  | 'tool_usage'
  | 'cost'
  | 'security'
  | 'persistence'
  | 'trading_performance'
  | 'trading_behavior'
  | 'market_data'
  | 'rate_limits';

export interface EvaluationFinding {
  section: EvaluationSectionKey;
  severity: EvaluationSeverity;
  /** Dot-namespaced error/finding code, e.g. 'trading.high_drawdown' */
  code: string;
  title: string;
  detail: string;
  /** Reference to artifact or data point (optional) */
  evidence?: string;
}

export interface EvaluationSectionScore {
  section: EvaluationSectionKey;
  /** 0–100 score for this section */
  score: number;
  findings: EvaluationFinding[];
  /** false → section was skipped (e.g. trading for non-trading agent) */
  applicable: boolean;
}

// ── Scorecard ───────────────────────────────────────────────────────────────

export interface EvaluationScorecard {
  overallScore: number;
  sections: EvaluationSectionScore[];
}

// ── Artifacts ───────────────────────────────────────────────────────────────

export interface EvaluationArtifactRef {
  name: string;       // e.g. 'evaluation.json', 'REPORT.md', 'fills.json'
  mimeType: string;
  sizeBytes: number;
}

// ── Run result ──────────────────────────────────────────────────────────────

export interface EvaluationRunResult {
  scorecard: EvaluationScorecard;
  artifactManifest: EvaluationArtifactRef[];
  summary: {
    totalFindings: number;
    criticalCount: number;
    highCount: number;
  };
}

// ── Narrative LLM override ─────────────────────────────────────────────────

/** Caller-specified narrative LLM override. */
export interface NarrativeLlmRequest {
  /** Provider override. If omitted, uses the resolved default provider. */
  provider?: string;
  /** Model override. Always required when narrativeLlm is specified. */
  model: string;
}

// ── Run request ─────────────────────────────────────────────────────────────

export interface EvaluationRunRequest {
  agentId: string;
  scope: EvaluationScope;
  trigger: EvaluationTrigger;
  requester: EvaluationRequester;
  /** If true, include optional LLM narrative in REPORT.md */
  includeNarrative?: boolean;
  /** Optional narrative LLM override (only valid when includeNarrative is true) */
  narrativeLlm?: NarrativeLlmRequest;
}

// ── Persisted run record ────────────────────────────────────────────────────

/** Persisted run metadata includes both requested and resolved scope. */
export interface EvaluationRunRecord {
  id: string;
  agentId: string;
  status: EvaluationRunStatus;
  trigger: EvaluationTrigger;
  /** What the caller asked for (may include `latestSession`) */
  requestedScope: EvaluationScope;
  /** What the worker evaluates against (always concrete) */
  resolvedScope: ResolvedEvaluationScope;
  /** Dedupe key derived from resolved scope */
  scopeKey: string;
  requester: EvaluationRequester;
  requestedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  timedOutAt?: Date;
  attempt: number;
  result?: EvaluationRunResult;
}

// ── Artifact storage port ───────────────────────────────────────────────────

/**
 * Storage port for evaluation artifacts.
 * Lives in domain so both API (downloads) and worker (writes) can depend on it
 * without importing each other's code.
 *
 * Accepts `Uint8Array | string` to stay runtime-neutral (no Node Buffer dependency).
 */
export interface EvaluationArtifactStore {
  write(runId: string, name: string, content: Uint8Array | string): Promise<EvaluationArtifactRef>;
  read(runId: string, name: string): Promise<Uint8Array | null>;
  list(runId: string): Promise<EvaluationArtifactRef[]>;
}
