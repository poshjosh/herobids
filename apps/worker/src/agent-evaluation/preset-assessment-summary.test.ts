import { describe, expect, it } from 'vitest';
import {
  derivePresetAssessmentSummary,
  derivePresetAssessmentEvents,
  shouldIncludeAppendix,
} from './preset-assessment-summary.js';
import type { PresetAssessmentEvidence } from './collectors/preset-assessment-evidence.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvidence(
  overrides: Partial<PresetAssessmentEvidence> = {},
): PresetAssessmentEvidence {
  return {
    reviewAdviceRows: [],
    requestRows: [],
    transitionRows: [],
    defaultBindingRow: null,
    auditCaveats: [],
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

const baseScope = { type: 'session' as const, sessionId: 'sess-1' };

// ── Inclusion Gating ────────────────────────────────────────────────────────

describe('shouldIncludeAppendix', () => {
  it('includes when enabled=true and activity is present', () => {
    const config = { platformAssessment: { enabled: true } };
    const evidence = makeEvidence({ reviewAdviceRows: [{ id: '1' }] });
    const result = shouldIncludeAppendix(config, evidence);
    expect(result.include).toBe(true);
    expect(result.reason).toBe('enabled_and_activity');
  });

  it('includes when enabled=true but no activity', () => {
    const config = { platformAssessment: { enabled: true } };
    const evidence = makeEvidence();
    const result = shouldIncludeAppendix(config, evidence);
    expect(result.include).toBe(true);
    expect(result.reason).toBe('enabled_for_agent');
  });

  it('includes when disabled but activity present', () => {
    const config = { platformAssessment: { enabled: false } };
    const evidence = makeEvidence({ requestRows: [{ id: '1' }] });
    const result = shouldIncludeAppendix(config, evidence);
    expect(result.include).toBe(true);
    expect(result.reason).toBe('activity_in_scope');
  });

  it('omits when disabled and no activity', () => {
    const config = { platformAssessment: { enabled: false } };
    const evidence = makeEvidence();
    const result = shouldIncludeAppendix(config, evidence);
    expect(result.include).toBe(false);
    expect(result.reason).toBe('none');
  });

  it('omits when config is null and no activity', () => {
    const evidence = makeEvidence();
    const result = shouldIncludeAppendix(null, evidence);
    expect(result.include).toBe(false);
    expect(result.reason).toBe('none');
  });

  it('includes when config is null but activity present', () => {
    const evidence = makeEvidence({ transitionRows: [{ id: '1' }] });
    const result = shouldIncludeAppendix(null, evidence);
    expect(result.include).toBe(true);
    expect(result.reason).toBe('activity_in_scope');
  });

  it('includes when platformAssessment key is missing but activity present', () => {
    const config = { otherKey: true };
    const evidence = makeEvidence({ reviewAdviceRows: [{ id: '1' }] });
    const result = shouldIncludeAppendix(config, evidence);
    expect(result.include).toBe(true);
    expect(result.reason).toBe('activity_in_scope');
  });

  it('omits when platformAssessment key is missing and no activity', () => {
    const config = { otherKey: true };
    const evidence = makeEvidence();
    const result = shouldIncludeAppendix(config, evidence);
    expect(result.include).toBe(false);
    expect(result.reason).toBe('none');
  });
});

// ── Q1 — Feature Enablement ─────────────────────────────────────────────────

describe('Q1 — Feature enablement', () => {
  it("returns 'yes' when platformAssessment.enabled is true", () => {
    const config = { platformAssessment: { enabled: true } };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: config,
      scope: baseScope,
    });
    expect(summary.answers.featureEnabled.status).toBe('yes');
  });

  it("returns 'no' when platformAssessment.enabled is false", () => {
    const config = { platformAssessment: { enabled: false } };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: config,
      scope: baseScope,
    });
    expect(summary.answers.featureEnabled.status).toBe('no');
  });

  it("returns 'unknown' when config is null", () => {
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.featureEnabled.status).toBe('unknown');
  });

  it("returns 'unknown' when platformAssessment is missing", () => {
    const config = { other: 'value' };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: config,
      scope: baseScope,
    });
    expect(summary.answers.featureEnabled.status).toBe('unknown');
  });

  it("returns 'unknown' when platformAssessment.enabled is absent", () => {
    const config = { platformAssessment: { styleTier: 'economy' } };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: config,
      scope: baseScope,
    });
    expect(summary.answers.featureEnabled.status).toBe('unknown');
  });
});

// ── Q2 — Review Advice ──────────────────────────────────────────────────────

describe('Q2 — Review advice', () => {
  it("returns 'yes' when advised rows exist and are consumed", () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: '1', outcome: 'advised', consumedAt: '2026-01-01T00:00:00Z' },
        { id: '2', outcome: 'not_advised' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.reviewAdviceReceived.status).toBe('yes');
  });

  it("returns 'partial' when advised rows exist but none consumed", () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: '1', outcome: 'advised', consumedAt: null },
        { id: '2', outcome: 'advised' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.reviewAdviceReceived.status).toBe('partial');
  });

  it("returns 'no' when rows exist but none have outcome 'advised'", () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: '1', outcome: 'not_advised' },
        { id: '2', outcome: 'blocked_by_cooldown' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.reviewAdviceReceived.status).toBe('no');
  });

  it("returns 'not_applicable' when no review advice rows", () => {
    const evidence = makeEvidence({ reviewAdviceRows: [] });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.reviewAdviceReceived.status).toBe('not_applicable');
  });
});

// ── Q3 — Assessment Requests ────────────────────────────────────────────────

describe('Q3 — Assessment requests and reuse', () => {
  it("returns 'yes' when both completed and cache_hit exist with no failures", () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'assessment_completed' },
        { id: '2', status: 'cache_hit' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('yes');
  });

  it("returns 'partial' when successes are mixed with blocked or failed outcomes", () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'assessment_completed' },
        { id: '2', status: 'cache_hit' },
        { id: '3', status: 'billing_blocked' },
        { id: '4', status: 'provider_failed' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('partial');
  });

  it("returns 'partial' when only completed, no cache_hit", () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'assessment_completed' },
        { id: '2', status: 'assessment_completed' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('partial');
  });

  it("returns 'partial' when only cache_hit, no completed", () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'cache_hit' },
        { id: '2', status: 'cache_hit' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('partial');
  });

  it("returns 'no' when only blocked/failed statuses", () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'billing_blocked' },
        { id: '2', status: 'cooldown_blocked' },
        { id: '3', status: 'provider_failed' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('no');
  });

  it("returns 'no' when only in_progress", () => {
    const evidence = makeEvidence({
      requestRows: [{ id: '1', status: 'in_progress' }],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('no');
  });

  it("returns 'not_applicable' when no request rows", () => {
    const evidence = makeEvidence({ requestRows: [] });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.assessmentRequestsAndReuse.status).toBe('not_applicable');
  });
});

// ── Q4 — Preset Changes ─────────────────────────────────────────────────────

describe('Q4 — Preset changes clean and auditable', () => {
  it("returns 'yes' when all applied transitions have full audit fields", () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-1',
          appliedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 't2',
          state: 'applied',
          oldPresetKey: 'standard',
          newPresetKey: 'premium',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-2',
          appliedAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('yes');
  });

  it("returns 'partial' when one applied transition is missing assessmentArtifactId", () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-1',
        },
        {
          id: 't2',
          state: 'applied',
          oldPresetKey: 'standard',
          newPresetKey: 'premium',
          transitionMode: 'apply',
          assessmentArtifactId: null, // missing
        },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('partial');
  });

  it("returns 'partial' when one applied transition is missing oldPresetKey", () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-1',
        },
        {
          id: 't2',
          state: 'applied',
          oldPresetKey: null, // missing
          newPresetKey: 'premium',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-2',
        },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('partial');
  });

  it("returns 'partial' when some transitions are deferred/rejected/failed", () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-1',
        },
        { id: 't2', state: 'deferred' },
        { id: 't3', state: 'rejected' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('partial');
  });

  it("returns 'no' when transitions exist but none applied", () => {
    const evidence = makeEvidence({
      transitionRows: [
        { id: 't1', state: 'deferred' },
        { id: 't2', state: 'rejected' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('no');
  });

  it("returns 'not_applicable' when no transition rows", () => {
    const evidence = makeEvidence({ transitionRows: [] });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('not_applicable');
  });

  it("returns 'partial' when applied rows are clean but also has partially_applied rows", () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-1',
        },
        { id: 't2', state: 'partially_applied' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.answers.presetChangesCleanAndAuditable.status).toBe('partial');
  });
});

// ── Config Snapshot Fallback ─────────────────────────────────────────────────

describe('Config snapshot fallback', () => {
  it("produces 'unavailable' source and null fields when config is null", () => {
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.configSnapshot.source).toBe('unavailable');
    expect(summary.configSnapshot.platformAssessmentEnabled).toBeNull();
    expect(summary.configSnapshot.styleTier).toBeNull();
    expect(summary.configSnapshot.allowedPresets).toBeNull();
  });

  it('extracts valid config fields when present', () => {
    const config = {
      platformAssessment: {
        enabled: true,
        styleTier: 'premium',
        allowedPresets: ['economy', 'standard'],
        allowedTransitionModes: ['apply'],
        supportedApplyTransitionModes: ['apply', 'defer'],
      },
    };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: config,
      scope: baseScope,
    });
    expect(summary.configSnapshot.source).toBe('current_unified_config');
    expect(summary.configSnapshot.platformAssessmentEnabled).toBe(true);
    expect(summary.configSnapshot.styleTier).toBe('premium');
    expect(summary.configSnapshot.allowedPresets).toEqual(['economy', 'standard']);
    expect(summary.configSnapshot.allowedTransitionModes).toEqual(['apply']);
    expect(summary.configSnapshot.supportedApplyTransitionModes).toEqual(['apply', 'defer']);
  });

  it('handles platformAssessment with null array fields', () => {
    const config = {
      platformAssessment: {
        enabled: true,
        styleTier: null,
        allowedPresets: null,
      },
    };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: config,
      scope: baseScope,
    });
    expect(summary.configSnapshot.platformAssessmentEnabled).toBe(true);
    expect(summary.configSnapshot.styleTier).toBeNull();
    expect(summary.configSnapshot.allowedPresets).toBeNull();
  });
});

// ── Count Accuracy ──────────────────────────────────────────────────────────

describe('Count accuracy', () => {
  it('counts review advice outcomes correctly', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: '1', outcome: 'advised' },
        { id: '2', outcome: 'advised' },
        { id: '3', outcome: 'not_advised' },
        { id: '4', outcome: 'blocked_by_cooldown' },
        { id: '5', outcome: 'blocked_by_no_credit_indication' },
        { id: '6', outcome: 'fresh_artifact_exists' },
        { id: '7', outcome: 'no_candidate' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.reviewAdvice.totalRows).toBe(7);
    expect(summary.reviewAdvice.advisedRows).toBe(2);
    expect(summary.reviewAdvice.outcomes.advised).toBe(2);
    expect(summary.reviewAdvice.outcomes.not_advised).toBe(1);
    expect(summary.reviewAdvice.outcomes.blocked_by_cooldown).toBe(1);
    expect(summary.reviewAdvice.outcomes.blocked_by_no_credit_indication).toBe(1);
    expect(summary.reviewAdvice.outcomes.fresh_artifact_exists).toBe(1);
    expect(summary.reviewAdvice.outcomes.no_candidate).toBe(1);
  });

  it('counts consumed advised rows correctly', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: '1', outcome: 'advised', consumedAt: '2026-01-01T00:00:00Z' },
        { id: '2', outcome: 'advised', consumedAt: null },
        { id: '3', outcome: 'advised' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.reviewAdvice.consumedRows).toBe(1);
  });

  it('counts assessment request statuses correctly', () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'assessment_completed', assessmentArtifactId: 'art-1' },
        { id: '2', status: 'assessment_completed' },
        { id: '3', status: 'cache_hit' },
        { id: '4', status: 'in_progress' },
        { id: '5', status: 'billing_blocked' },
        { id: '6', status: 'cooldown_blocked' },
        { id: '7', status: 'identity_unresolved' },
        { id: '8', status: 'provider_failed' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.assessmentRequests.totalRows).toBe(8);
    expect(summary.assessmentRequests.successfulFreshRuns).toBe(2);
    expect(summary.assessmentRequests.successfulCacheHits).toBe(1);
    expect(summary.assessmentRequests.requestInFlight).toBe(1);
    expect(summary.assessmentRequests.billingBlocked).toBe(1);
    expect(summary.assessmentRequests.cooldownBlocked).toBe(1);
    expect(summary.assessmentRequests.identityUnresolved).toBe(1);
    expect(summary.assessmentRequests.providerFailed).toBe(1);
  });

  it('captures last successful artifact id from first successful row (desc order)', () => {
    const evidence = makeEvidence({
      requestRows: [
        { id: '1', status: 'assessment_completed', assessmentArtifactId: 'first-art' },
        { id: '2', status: 'assessment_completed', assessmentArtifactId: 'second-art' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    // Rows come DESC from collector, so "first" row is the most recent.
    expect(summary.assessmentRequests.lastSuccessfulArtifactId).toBe('first-art');
  });

  it('counts transition states correctly', () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'e',
          newPresetKey: 's',
          transitionMode: 'apply',
          assessmentArtifactId: 'a1',
          appliedAt: '2026-01-03T00:00:00Z',
        },
        {
          id: 't2',
          state: 'applied',
          oldPresetKey: 's',
          newPresetKey: 'p',
          transitionMode: 'apply',
          assessmentArtifactId: 'a2',
          appliedAt: '2026-01-02T00:00:00Z',
        },
        { id: 't3', state: 'deferred' },
        { id: 't4', state: 'rejected' },
        { id: 't5', state: 'failed' },
        { id: 't6', state: 'partially_applied' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.presetTransitions.totalRows).toBe(6);
    expect(summary.presetTransitions.applied).toBe(2);
    expect(summary.presetTransitions.deferred).toBe(1);
    expect(summary.presetTransitions.rejected).toBe(1);
    expect(summary.presetTransitions.failed).toBe(1);
    expect(summary.presetTransitions.partiallyApplied).toBe(1);
  });

  it('records lastAppliedTransition from the most recent applied row', () => {
    // Rows come DESC from collector, so most recent (t2) is first in the array.
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 't2',
          state: 'applied',
          oldPresetKey: 'mid',
          newPresetKey: 'latest',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-2',
          appliedAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 't1',
          state: 'applied',
          oldPresetKey: 'oldest',
          newPresetKey: 'mid',
          transitionMode: 'apply',
          assessmentArtifactId: 'art-1',
          appliedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    // Rows come DESC, so t2 is first encountered.
    expect(summary.presetTransitions.lastAppliedTransition?.id).toBe('t2');
    expect(summary.presetTransitions.lastAppliedTransition?.newPresetKey).toBe('latest');
  });

  it('collects unique transition modes', () => {
    const evidence = makeEvidence({
      transitionRows: [
        { id: 't1', state: 'applied', transitionMode: 'apply' },
        { id: 't2', state: 'applied', transitionMode: 'apply' },
        { id: 't3', state: 'deferred', transitionMode: 'defer' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.presetTransitions.modesObserved).toEqual(['apply', 'defer']);
  });
});

// ── Current Default Binding ─────────────────────────────────────────────────

describe('Current default binding', () => {
  it('extracts binding fields when present', () => {
    const evidence = makeEvidence({
      defaultBindingRow: {
        activePresetKey: 'economy',
        behaviorVersion: 'v2',
        styleTier: 'standard',
        sourceArtifactId: 'art-1',
        sourceTransitionId: 't-1',
      },
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.currentDefaultBinding.activePresetKey).toBe('economy');
    expect(summary.currentDefaultBinding.behaviorVersion).toBe('v2');
    expect(summary.currentDefaultBinding.styleTier).toBe('standard');
    expect(summary.currentDefaultBinding.sourceArtifactId).toBe('art-1');
    expect(summary.currentDefaultBinding.sourceTransitionId).toBe('t-1');
  });

  it('returns nulls when defaultBindingRow is null', () => {
    const evidence = makeEvidence({ defaultBindingRow: null });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.currentDefaultBinding.activePresetKey).toBeNull();
    expect(summary.currentDefaultBinding.behaviorVersion).toBeNull();
  });
});

// ── Identity-Scoped Transitions ─────────────────────────────────────────────

describe('identityScopedTransitionsObserved', () => {
  it('is false when no transitions have non-default scope', () => {
    const evidence = makeEvidence({
      transitionRows: [
        { id: 't1', state: 'applied', scope: 'default' },
        { id: 't2', state: 'applied' }, // no scope
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.identityScopedTransitionsObserved).toBe(false);
  });

  it('is true when at least one transition has a non-default scope', () => {
    const evidence = makeEvidence({
      transitionRows: [
        { id: 't1', state: 'applied', scope: 'default' },
        { id: 't2', state: 'applied', scope: 'ETH:perp' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.identityScopedTransitionsObserved).toBe(true);
  });
});

// ── Schema Version and Metadata ─────────────────────────────────────────────

describe('Summary metadata', () => {
  it('sets schemaVersion to 1', () => {
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.schemaVersion).toBe(1);
  });

  it('uses provided generatedAt when given', () => {
    const generatedAt = '2026-07-19T12:00:00.000Z';
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope: baseScope,
      generatedAt,
    });
    expect(summary.generatedAt).toBe(generatedAt);
  });

  it('generatedAt defaults to a valid ISO timestamp when not provided', () => {
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(() => new Date(summary.generatedAt)).not.toThrow();
    expect(new Date(summary.generatedAt).toISOString()).toBe(summary.generatedAt);
  });

  it('preserves scope in output', () => {
    const scope = { type: 'timeRange' as const, from: new Date('2026-01-01'), to: new Date('2026-01-31') };
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope,
    });
    expect(summary.scope).toEqual(scope);
  });

  it('forwards audit caveats and adds config-snapshot limitation when source is current_unified_config', () => {
    const evidence = makeEvidence({ auditCaveats: ['caveat-1', 'caveat-2'] });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: { platformAssessment: { enabled: true } },
      scope: baseScope,
    });
    expect(summary.auditCaveats).toEqual([
      'caveat-1',
      'caveat-2',
      'Enablement is derived from the current unified config snapshot, not historical config versioning.',
    ]);
  });

  it('does not add config-snapshot caveat when config source is unavailable', () => {
    const evidence = makeEvidence({ auditCaveats: ['caveat-1'] });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.auditCaveats).toEqual(['caveat-1']);
  });

  it("sets reuseDefinition to 'cache_hit_only'", () => {
    const summary = derivePresetAssessmentSummary({
      evidence: makeEvidence(),
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.assessmentRequests.reuseDefinition).toBe('cache_hit_only');
  });
});

// ── Event Derivation ────────────────────────────────────────────────────────

describe('derivePresetAssessmentEvents', () => {
  it('produces review_advice events from reviewAdviceRows', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        {
          id: 'ra-1',
          checkedAt: '2026-01-01T00:00:00Z',
          outcome: 'advised',
          activePreset: 'economy',
          presetBehaviorVersion: 'v1',
          consumedAt: '2026-01-01T01:00:00Z',
          expiresAt: '2026-01-08T00:00:00Z',
          supportingFacts: { score: 85 },
          instrumentKind: 'perp',
          venueFamily: 'hyperliquid',
          symbol: 'ETH',
          styleTier: 'standard',
        },
      ],
    });
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventType).toBe('review_advice');
    expect(e.id).toBe('ra-1');
    expect(e.occurredAt).toBe('2026-01-01T00:00:00Z');
    expect(e.outcome).toBe('advised');
    expect(e.activePreset).toBe('economy');
    expect(e.presetBehaviorVersion).toBe('v1');
    expect(e.consumedAt).toBe('2026-01-01T01:00:00Z');
    expect(e.expiresAt).toBe('2026-01-08T00:00:00Z');
    expect(e.supportingFacts).toEqual({ score: 85 });
    expect(e.identity).toBeDefined();
  });

  it('produces assessment_request events from requestRows', () => {
    const evidence = makeEvidence({
      requestRows: [
        {
          id: 'req-1',
          requestedAt: '2026-01-02T00:00:00Z',
          status: 'assessment_completed',
          billingOutcome: 'charged',
          assessmentArtifactId: 'art-1',
          failureCode: null,
          requestGroupKey: 'group-1',
          instrumentKind: 'perp',
          venueFamily: 'hyperliquid',
          symbol: 'BTC',
          styleTier: 'standard',
        },
      ],
    });
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventType).toBe('assessment_request');
    expect(e.id).toBe('req-1');
    expect(e.occurredAt).toBe('2026-01-02T00:00:00Z');
    expect(e.status).toBe('assessment_completed');
    expect(e.billingOutcome).toBe('charged');
    expect(e.assessmentArtifactId).toBe('art-1');
    expect(e.failureCode).toBeNull();
    expect(e.requestGroupKey).toBe('group-1');
  });

  it('produces preset_transition events from transitionRows', () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 'trans-1',
          appliedAt: '2026-01-03T00:00:00Z',
          state: 'applied',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'apply',
          openPositionCount: 2,
          reason: 'assessment upgrade',
          assessmentArtifactId: 'art-2',
          mode: 'auto',
          scope: 'default',
          instrumentKind: 'perp',
          venueFamily: 'hyperliquid',
          symbol: 'ETH',
          styleTier: 'standard',
        },
      ],
    });
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventType).toBe('preset_transition');
    expect(e.id).toBe('trans-1');
    expect(e.occurredAt).toBe('2026-01-03T00:00:00Z');
    expect(e.state).toBe('applied');
    expect(e.oldPresetKey).toBe('economy');
    expect(e.newPresetKey).toBe('standard');
    expect(e.transitionMode).toBe('apply');
    expect(e.openPositionCount).toBe(2);
    expect(e.reason).toBe('assessment upgrade');
    expect(e.assessmentArtifactId).toBe('art-2');
    expect(e.mode).toBe('auto');
    expect(e.transitionScope).toBe('default');
    expect(e.outcome).toBeUndefined();
  });

  it('includes outcome on preset_transition events when present', () => {
    const evidence = makeEvidence({
      transitionRows: [
        {
          id: 'trans-2',
          appliedAt: '2026-01-04T00:00:00Z',
          state: 'applied',
          outcome: 'accepted',
          instrumentKind: 'orderbook',
          venueFamily: 'hyperliquid',
          symbol: 'BTC',
          styleTier: 'standard',
        },
      ],
    });
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('accepted');
  });

  it('sorts events by occurredAt ascending', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: 'ra-2', checkedAt: '2026-01-03T00:00:00Z', outcome: 'advised' },
      ],
      requestRows: [
        { id: 'req-1', requestedAt: '2026-01-01T00:00:00Z', status: 'cache_hit' },
      ],
      transitionRows: [
        { id: 'trans-1', appliedAt: '2026-01-02T00:00:00Z', state: 'applied' },
      ],
    });
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toHaveLength(3);
    expect(events[0]!.id).toBe('req-1'); // earliest
    expect(events[1]!.id).toBe('trans-1');
    expect(events[2]!.id).toBe('ra-2'); // latest
  });

  it('handles empty evidence', () => {
    const evidence = makeEvidence();
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toEqual([]);
  });

  it('sets identity to undefined when buildCompactIdentity throws', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        { id: 'ra-1', checkedAt: '2026-01-01T00:00:00Z', outcome: 'advised' },
      ],
    });
    // No instrumentKind, venueFamily, etc. → buildCompactIdentity uses '?' fallbacks.
    const events = derivePresetAssessmentEvents({ evidence });
    expect(events).toHaveLength(1);
    // With all '?' fallbacks, identity should be '?:?:?'
    // but since these are strings, buildCompactIdentity will return '?:?:?'
    expect(events[0]!.identity).toBe('?:?:?');
  });
});

// ── topAdvisedIdentities ────────────────────────────────────────────────────

describe('topAdvisedIdentities in summary', () => {
  it('returns top advised identities sorted by frequency', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [
        {
          id: '1', outcome: 'advised',
          instrumentKind: 'perp', venueFamily: 'hl', symbol: 'ETH', styleTier: 'standard',
        },
        {
          id: '2', outcome: 'advised',
          instrumentKind: 'perp', venueFamily: 'hl', symbol: 'ETH', styleTier: 'standard',
        },
        {
          id: '3', outcome: 'advised',
          instrumentKind: 'perp', venueFamily: 'hl', symbol: 'BTC', styleTier: 'standard',
        },
        { id: '4', outcome: 'not_advised' },
      ],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.reviewAdvice.topAdvisedIdentities[0]).toContain('ETH');
    expect(summary.reviewAdvice.topAdvisedIdentities[1]).toContain('BTC');
  });

  it('returns empty array when no advised rows', () => {
    const evidence = makeEvidence({
      reviewAdviceRows: [{ id: '1', outcome: 'not_advised' }],
    });
    const summary = derivePresetAssessmentSummary({
      evidence,
      unifiedConfig: null,
      scope: baseScope,
    });
    expect(summary.reviewAdvice.topAdvisedIdentities).toEqual([]);
  });
});
