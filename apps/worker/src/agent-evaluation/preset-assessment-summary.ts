import type { ResolvedEvaluationScope } from '@herobids/domain';
import type { PresetAssessmentEvidence } from './collectors/preset-assessment-evidence.js';
import { buildCompactIdentity } from './collectors/preset-assessment-evidence.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type AnswerStatus = 'yes' | 'partial' | 'no' | 'not_applicable' | 'unknown';

export interface PresetAssessmentSummary {
  schemaVersion: 1;
  generatedAt: string;
  scope: ResolvedEvaluationScope;
  includedInReport: boolean;
  inclusionReason: 'enabled_for_agent' | 'activity_in_scope' | 'enabled_and_activity' | 'none';
  configSnapshot: {
    platformAssessmentEnabled: boolean | null;
    styleTier: string | null;
    allowedPresets: string[] | null;
    allowedTransitionModes: string[] | null;
    supportedApplyTransitionModes: string[] | null;
    source: 'current_unified_config' | 'unavailable';
  };
  answers: {
    featureEnabled: { status: AnswerStatus; detail: string };
    reviewAdviceReceived: { status: AnswerStatus; detail: string };
    assessmentRequestsAndReuse: { status: AnswerStatus; detail: string };
    presetChangesCleanAndAuditable: { status: AnswerStatus; detail: string };
  };
  reviewAdvice: {
    totalRows: number;
    advisedRows: number;
    consumedRows: number;
    outcomes: {
      advised: number;
      not_advised: number;
      blocked_by_cooldown: number;
      blocked_by_no_credit_indication: number;
      fresh_artifact_exists: number;
      no_candidate: number;
    };
    topAdvisedIdentities: string[];
  };
  assessmentRequests: {
    totalRows: number;
    successfulFreshRuns: number;
    successfulCacheHits: number;
    reuseDefinition: 'cache_hit_only';
    requestInFlight: number;
    billingBlocked: number;
    cooldownBlocked: number;
    identityUnresolved: number;
    providerFailed: number;
    lastSuccessfulArtifactId: string | null;
  };
  presetTransitions: {
    totalRows: number;
    applied: number;
    deferred: number;
    rejected: number;
    failed: number;
    partiallyApplied: number;
    modesObserved: string[];
    lastAppliedTransition: {
      id: string;
      oldPresetKey: string;
      newPresetKey: string;
      transitionMode: string;
      assessmentArtifactId: string | null;
      appliedAt: string;
    } | null;
  };
  currentDefaultBinding: {
    activePresetKey: string | null;
    behaviorVersion: string | null;
    styleTier: string | null;
    sourceArtifactId: string | null;
    sourceTransitionId: string | null;
  };
  identityScopedTransitionsObserved: boolean;
  auditCaveats: string[];
}

export interface PresetAssessmentEvent {
  eventType: 'review_advice' | 'assessment_request' | 'preset_transition';
  id: string;
  occurredAt: string;
  identity?: string;
  // review_advice fields
  outcome?: string;
  activePreset?: string;
  presetBehaviorVersion?: string;
  consumedAt?: string | null;
  expiresAt?: string;
  supportingFacts?: Record<string, unknown>;
  // assessment_request fields
  status?: string;
  billingOutcome?: string | null;
  assessmentArtifactId?: string | null;
  failureCode?: string | null;
  requestGroupKey?: string;
  // preset_transition fields
  state?: string;
  oldPresetKey?: string;
  newPresetKey?: string;
  transitionMode?: string;
  openPositionCount?: number;
  reason?: string | null;
  mode?: string;
  transitionScope?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function str(val: unknown): string {
  return val == null ? '' : String(val);
}

function extractPlatformAssessment(
  config: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!config) return null;
  const pa = config.platformAssessment;
  if (typeof pa !== 'object' || pa === null) return null;
  return pa as Record<string, unknown>;
}

// ── Inclusion Gating ────────────────────────────────────────────────────────

export type InclusionReason =
  | 'enabled_for_agent'
  | 'activity_in_scope'
  | 'enabled_and_activity'
  | 'none';

export function shouldIncludeAppendix(
  config: Record<string, unknown> | null,
  evidence: PresetAssessmentEvidence,
): { include: boolean; reason: InclusionReason } {
  const pa = extractPlatformAssessment(config);
  const enabled = pa?.enabled === true;
  const hasActivity =
    evidence.reviewAdviceRows.length > 0 ||
    evidence.requestRows.length > 0 ||
    evidence.transitionRows.length > 0;

  if (enabled && hasActivity) {
    return { include: true, reason: 'enabled_and_activity' };
  }
  if (enabled && !hasActivity) {
    return { include: true, reason: 'enabled_for_agent' };
  }
  if (!enabled && hasActivity) {
    return { include: true, reason: 'activity_in_scope' };
  }
  return { include: false, reason: 'none' };
}

// ── Answer Derivation ───────────────────────────────────────────────────────

function deriveQ1FeatureEnabled(
  config: Record<string, unknown> | null,
): { status: AnswerStatus; detail: string } {
  const pa = extractPlatformAssessment(config);
  if (!pa) {
    return { status: 'unknown', detail: 'Unified config is missing or does not contain platformAssessment.' };
  }
  if (pa.enabled === true) {
    return { status: 'yes', detail: 'platformAssessment.enabled is true in the unified config.' };
  }
  if (pa.enabled === false) {
    return { status: 'no', detail: 'platformAssessment.enabled is false in the unified config.' };
  }
  return { status: 'unknown', detail: 'platformAssessment.enabled is not set in the unified config.' };
}

function deriveQ2ReviewAdvice(
  rows: Array<Record<string, unknown>>,
): { status: AnswerStatus; detail: string } {
  if (rows.length === 0) {
    return { status: 'not_applicable', detail: 'No review advice rows found in scope.' };
  }

  const advised = rows.filter((r) => r.outcome === 'advised');
  if (advised.length === 0) {
    return { status: 'no', detail: `${rows.length} review advice row(s) exist, but none have outcome 'advised'.` };
  }

  const consumed = advised.filter((r) => r.consumedAt != null);
  if (consumed.length > 0) {
    return { status: 'yes', detail: `${advised.length} advised row(s), ${consumed.length} consumed.` };
  }

  return { status: 'partial', detail: `${advised.length} advised row(s), but none have been consumed.` };
}

function deriveQ3AssessmentRequests(
  rows: Array<Record<string, unknown>>,
): { status: AnswerStatus; detail: string } {
  if (rows.length === 0) {
    return { status: 'not_applicable', detail: 'No assessment request rows found in scope.' };
  }

  const completed = rows.filter((r) => r.status === 'assessment_completed');
  const cacheHits = rows.filter((r) => r.status === 'cache_hit');
  const anySuccess = completed.length > 0 || cacheHits.length > 0;

  if (!anySuccess) {
    return { status: 'no', detail: `${rows.length} request(s) exist, but none succeeded (no assessment_completed or cache_hit).` };
  }

  if (completed.length > 0 && cacheHits.length > 0) {
    return { status: 'yes', detail: `${completed.length} fresh completion(s) and ${cacheHits.length} cache hit(s).` };
  }

  return { status: 'partial', detail: `${completed.length} fresh completion(s), ${cacheHits.length} cache hit(s) — only one kind of success observed.` };
}

function deriveQ4PresetChanges(
  rows: Array<Record<string, unknown>>,
): { status: AnswerStatus; detail: string } {
  if (rows.length === 0) {
    return { status: 'not_applicable', detail: 'No preset transition rows found in scope.' };
  }

  const applied = rows.filter((r) => r.state === 'applied');
  if (applied.length === 0) {
    return { status: 'no', detail: `${rows.length} transition(s) exist, but none have state 'applied'.` };
  }

  // Every applied transition must have all audit fields.
  const allClean = applied.every(
    (r) =>
      r.assessmentArtifactId != null &&
      r.oldPresetKey != null && str(r.oldPresetKey).length > 0 &&
      r.newPresetKey != null && str(r.newPresetKey).length > 0 &&
      r.transitionMode != null && str(r.transitionMode).length > 0,
  );

  if (allClean) {
    // Also check that no rows have deferred/rejected/failed/partially_applied states
    const hasDirty = rows.some(
      (r) =>
        r.state === 'deferred' ||
        r.state === 'rejected' ||
        r.state === 'failed' ||
        r.state === 'partially_applied',
    );
    if (hasDirty) {
      return { status: 'partial', detail: `${applied.length} applied transition(s) have full audit trails, but some transitions were deferred, rejected, failed, or partially applied.` };
    }
    return { status: 'yes', detail: `${applied.length} applied transition(s), all with complete audit trails.` };
  }

  return { status: 'partial', detail: `${applied.length} applied transition(s), but at least one is missing audit fields (assessmentArtifactId, oldPresetKey, newPresetKey, or transitionMode).` };
}

// ── Count Derivation ────────────────────────────────────────────────────────

interface OutcomeCounts {
  advised: number;
  not_advised: number;
  blocked_by_cooldown: number;
  blocked_by_no_credit_indication: number;
  fresh_artifact_exists: number;
  no_candidate: number;
}

function countReviewAdviceOutcomes(rows: Array<Record<string, unknown>>): OutcomeCounts {
  const counts: OutcomeCounts = {
    advised: 0,
    not_advised: 0,
    blocked_by_cooldown: 0,
    blocked_by_no_credit_indication: 0,
    fresh_artifact_exists: 0,
    no_candidate: 0,
  };
  for (const r of rows) {
    const outcome = r.outcome;
    if (typeof outcome === 'string' && outcome in counts) {
      counts[outcome as keyof OutcomeCounts]++;
    }
  }
  return counts;
}

function countRequestStatuses(rows: Array<Record<string, unknown>>) {
  let successfulFreshRuns = 0;
  let successfulCacheHits = 0;
  let requestInFlight = 0;
  let billingBlocked = 0;
  let cooldownBlocked = 0;
  let identityUnresolved = 0;
  let providerFailed = 0;
  let lastSuccessfulArtifactId: string | null = null;

  // Rows come ordered by requestedAt DESC from the collector.
  for (const r of rows) {
    const status = r.status;
    if (status === 'assessment_completed') {
      successfulFreshRuns++;
      if (!lastSuccessfulArtifactId && r.assessmentArtifactId != null) {
        lastSuccessfulArtifactId = String(r.assessmentArtifactId);
      }
    } else if (status === 'cache_hit') {
      successfulCacheHits++;
      if (!lastSuccessfulArtifactId && r.assessmentArtifactId != null) {
        lastSuccessfulArtifactId = String(r.assessmentArtifactId);
      }
    } else if (status === 'in_progress') {
      requestInFlight++;
    } else if (status === 'billing_blocked') {
      billingBlocked++;
    } else if (status === 'cooldown_blocked') {
      cooldownBlocked++;
    } else if (status === 'identity_unresolved') {
      identityUnresolved++;
    } else if (status === 'provider_failed') {
      providerFailed++;
    }
  }

  return {
    successfulFreshRuns,
    successfulCacheHits,
    requestInFlight,
    billingBlocked,
    cooldownBlocked,
    identityUnresolved,
    providerFailed,
    lastSuccessfulArtifactId,
  };
}

function countTransitionStates(rows: Array<Record<string, unknown>>) {
  let applied = 0;
  let deferred = 0;
  let rejected = 0;
  let failed = 0;
  let partiallyApplied = 0;
  const modes = new Set<string>();
  let lastAppliedTransition: PresetAssessmentSummary['presetTransitions']['lastAppliedTransition'] = null;

  // Rows come ordered by appliedAt DESC from the collector.
  for (const r of rows) {
    const state = r.state;
    if (state === 'applied') {
      applied++;
      if (!lastAppliedTransition) {
        lastAppliedTransition = {
          id: str(r.id),
          oldPresetKey: str(r.oldPresetKey),
          newPresetKey: str(r.newPresetKey),
          transitionMode: str(r.transitionMode),
          assessmentArtifactId: r.assessmentArtifactId != null ? String(r.assessmentArtifactId) : null,
          appliedAt: str(r.appliedAt),
        };
      }
    } else if (state === 'deferred') {
      deferred++;
    } else if (state === 'rejected') {
      rejected++;
    } else if (state === 'failed') {
      failed++;
    } else if (state === 'partially_applied') {
      partiallyApplied++;
    }
    if (r.transitionMode != null && str(r.transitionMode).length > 0) {
      modes.add(str(r.transitionMode));
    }
  }

  return {
    applied,
    deferred,
    rejected,
    failed,
    partiallyApplied,
    modesObserved: [...modes].sort(),
    lastAppliedTransition,
  };
}

function topAdvisedIdentities(
  rows: Array<Record<string, unknown>>,
  limit: number = 5,
): string[] {
  const countMap = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome === 'advised') {
      const identity = buildCompactIdentity(r);
      countMap.set(identity, (countMap.get(identity) ?? 0) + 1);
    }
  }
  return [...countMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([identity]) => identity);
}

// ── Main Functions ──────────────────────────────────────────────────────────

export function derivePresetAssessmentSummary(params: {
  evidence: PresetAssessmentEvidence;
  unifiedConfig: Record<string, unknown> | null;
  scope: ResolvedEvaluationScope;
  /** ISO timestamp for generatedAt. Defaults to now if not provided (caller should provide for determinism). */
  generatedAt?: string;
}): PresetAssessmentSummary {
  const { evidence, unifiedConfig, scope, generatedAt } = params;
  const pa = extractPlatformAssessment(unifiedConfig);

  const configSnapshot: PresetAssessmentSummary['configSnapshot'] = unifiedConfig
    ? {
        platformAssessmentEnabled:
          pa?.enabled === true ? true : pa?.enabled === false ? false : null,
        styleTier: typeof pa?.styleTier === 'string' ? (pa.styleTier as string) : null,
        allowedPresets: Array.isArray(pa?.allowedPresets)
          ? (pa.allowedPresets as string[])
          : null,
        allowedTransitionModes: Array.isArray(pa?.allowedTransitionModes)
          ? (pa.allowedTransitionModes as string[])
          : null,
        supportedApplyTransitionModes: Array.isArray(pa?.supportedApplyTransitionModes)
          ? (pa.supportedApplyTransitionModes as string[])
          : null,
        source: 'current_unified_config',
      }
    : {
        platformAssessmentEnabled: null,
        styleTier: null,
        allowedPresets: null,
        allowedTransitionModes: null,
        supportedApplyTransitionModes: null,
        source: 'unavailable',
      };

  const inclusion = shouldIncludeAppendix(unifiedConfig, evidence);

  const q1 = deriveQ1FeatureEnabled(unifiedConfig);
  const q2 = deriveQ2ReviewAdvice(evidence.reviewAdviceRows);
  const q3 = deriveQ3AssessmentRequests(evidence.requestRows);
  const q4 = deriveQ4PresetChanges(evidence.transitionRows);

  const adviceOutcomes = countReviewAdviceOutcomes(evidence.reviewAdviceRows);
  const advConsumed = evidence.reviewAdviceRows.filter(
    (r) => r.outcome === 'advised' && r.consumedAt != null,
  ).length;

  const requestCounts = countRequestStatuses(evidence.requestRows);

  const transitionCounts = countTransitionStates(evidence.transitionRows);

  // Current default binding
  const db = evidence.defaultBindingRow;
  const currentDefaultBinding: PresetAssessmentSummary['currentDefaultBinding'] = {
    activePresetKey: db?.activePresetKey != null ? String(db.activePresetKey) : null,
    behaviorVersion: db?.behaviorVersion != null ? String(db.behaviorVersion) : null,
    styleTier: db?.styleTier != null ? String(db.styleTier) : null,
    sourceArtifactId: db?.sourceArtifactId != null ? String(db.sourceArtifactId) : null,
    sourceTransitionId: db?.sourceTransitionId != null ? String(db.sourceTransitionId) : null,
  };

  // Identity-scoped transitions observed: true if any transitionRow has a non-null
  // identitySnapshot (or identity-related columns) that suggest per-identity scoping.
  // We consider it observed if at least one transition has a non-default scope.
  const identityScoped = evidence.transitionRows.some(
    (r) => r.scope != null && str(r.scope) !== 'default' && str(r.scope).length > 0,
  );

  // Add config-snapshot limitation caveat when source is current_unified_config
  const allCaveats = [...evidence.auditCaveats];
  if (configSnapshot.source === 'current_unified_config') {
    allCaveats.push(
      'Enablement is derived from the current unified config snapshot, not historical config versioning.',
    );
  }

  return {
    schemaVersion: 1,
    generatedAt: generatedAt ?? new Date().toISOString(),
    scope,
    includedInReport: inclusion.include,
    inclusionReason: inclusion.reason,
    configSnapshot,
    answers: {
      featureEnabled: q1,
      reviewAdviceReceived: q2,
      assessmentRequestsAndReuse: q3,
      presetChangesCleanAndAuditable: q4,
    },
    reviewAdvice: {
      totalRows: evidence.reviewAdviceRows.length,
      advisedRows: adviceOutcomes.advised,
      consumedRows: advConsumed,
      outcomes: adviceOutcomes,
      topAdvisedIdentities: topAdvisedIdentities(evidence.reviewAdviceRows),
    },
    assessmentRequests: {
      totalRows: evidence.requestRows.length,
      successfulFreshRuns: requestCounts.successfulFreshRuns,
      successfulCacheHits: requestCounts.successfulCacheHits,
      reuseDefinition: 'cache_hit_only',
      requestInFlight: requestCounts.requestInFlight,
      billingBlocked: requestCounts.billingBlocked,
      cooldownBlocked: requestCounts.cooldownBlocked,
      identityUnresolved: requestCounts.identityUnresolved,
      providerFailed: requestCounts.providerFailed,
      lastSuccessfulArtifactId: requestCounts.lastSuccessfulArtifactId,
    },
    presetTransitions: {
      totalRows: evidence.transitionRows.length,
      applied: transitionCounts.applied,
      deferred: transitionCounts.deferred,
      rejected: transitionCounts.rejected,
      failed: transitionCounts.failed,
      partiallyApplied: transitionCounts.partiallyApplied,
      modesObserved: transitionCounts.modesObserved,
      lastAppliedTransition: transitionCounts.lastAppliedTransition,
    },
    currentDefaultBinding,
    identityScopedTransitionsObserved: identityScoped,
    auditCaveats: allCaveats,
  };
}

export function derivePresetAssessmentEvents(params: {
  evidence: PresetAssessmentEvidence;
}): PresetAssessmentEvent[] {
  const events: PresetAssessmentEvent[] = [];

  // review_advice rows
  for (const r of params.evidence.reviewAdviceRows) {
    const identity = safeCompactIdentity(r);
    events.push({
      eventType: 'review_advice',
      id: str(r.id),
      occurredAt: str(r.checkedAt),
      identity,
      outcome: r.outcome != null ? String(r.outcome) : undefined,
      activePreset: r.activePreset != null ? String(r.activePreset) : undefined,
      presetBehaviorVersion:
        r.presetBehaviorVersion != null ? String(r.presetBehaviorVersion) : undefined,
      consumedAt: r.consumedAt != null ? String(r.consumedAt) : null,
      expiresAt: r.expiresAt != null ? String(r.expiresAt) : undefined,
      supportingFacts:
        r.supportingFacts != null && typeof r.supportingFacts === 'object'
          ? (r.supportingFacts as Record<string, unknown>)
          : undefined,
    });
  }

  // market_assessment_requests rows
  for (const r of params.evidence.requestRows) {
    const identity = safeCompactIdentity(r);
    events.push({
      eventType: 'assessment_request',
      id: str(r.id),
      occurredAt: str(r.requestedAt),
      identity,
      status: r.status != null ? String(r.status) : undefined,
      billingOutcome: r.billingOutcome != null ? String(r.billingOutcome) : null,
      assessmentArtifactId:
        r.assessmentArtifactId != null ? String(r.assessmentArtifactId) : null,
      failureCode: r.failureCode != null ? String(r.failureCode) : null,
      requestGroupKey:
        r.requestGroupKey != null ? String(r.requestGroupKey) : undefined,
    });
  }

  // agent_preset_transitions rows
  for (const r of params.evidence.transitionRows) {
    const identity = safeCompactIdentity(r);
    events.push({
      eventType: 'preset_transition',
      id: str(r.id),
      occurredAt: str(r.appliedAt),
      identity,
      state: r.state != null ? String(r.state) : undefined,
      oldPresetKey: r.oldPresetKey != null ? String(r.oldPresetKey) : undefined,
      newPresetKey: r.newPresetKey != null ? String(r.newPresetKey) : undefined,
      transitionMode: r.transitionMode != null ? String(r.transitionMode) : undefined,
      openPositionCount:
        r.openPositionCount != null ? Number(r.openPositionCount) : undefined,
      reason: r.reason != null ? String(r.reason) : null,
      assessmentArtifactId:
        r.assessmentArtifactId != null ? String(r.assessmentArtifactId) : null,
      mode: r.mode != null ? String(r.mode) : undefined,
      transitionScope: r.scope != null ? String(r.scope) : undefined,
      outcome: r.outcome != null ? String(r.outcome) : undefined,
    });
  }

  // Sort by occurredAt ascending
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return events;
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Wraps buildCompactIdentity so that if the row is malformed and the
 * identity function throws, we return a fallback string instead of crashing
 * the event derivation.
 */
function safeCompactIdentity(row: Record<string, unknown>): string {
  try {
    return buildCompactIdentity(row);
  } catch {
    return '?:?:?';
  }
}
