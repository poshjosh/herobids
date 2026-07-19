import { describe, expect, it } from 'vitest';
import { renderPresetAssessmentAppendix } from './render-preset-assessment-appendix.js';
import type { PresetAssessmentSummary } from './preset-assessment-summary.js';

// Helper to create a minimal summary with defaults
function makeSummary(overrides: Partial<PresetAssessmentSummary> = {}): PresetAssessmentSummary {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-19T12:00:00.000Z',
    scope: { type: 'session', sessionId: 'sess-1' },
    includedInReport: true,
    inclusionReason: 'enabled_and_activity',
    configSnapshot: {
      platformAssessmentEnabled: true,
      styleTier: 'standard',
      allowedPresets: ['momentum_v1', 'mean_reversion_v1'],
      allowedTransitionModes: ['entries_only'],
      supportedApplyTransitionModes: ['entries_only'],
      source: 'current_unified_config',
    },
    answers: {
      featureEnabled: { status: 'yes', detail: 'Enabled.' },
      reviewAdviceReceived: { status: 'yes', detail: 'Received and consumed.' },
      assessmentRequestsAndReuse: { status: 'yes', detail: 'Requests succeeded with reuse.' },
      presetChangesCleanAndAuditable: { status: 'not_applicable', detail: 'No transitions.' },
    },
    reviewAdvice: {
      totalRows: 3,
      advisedRows: 2,
      consumedRows: 1,
      outcomes: {
        advised: 2,
        not_advised: 1,
        blocked_by_cooldown: 0,
        blocked_by_no_credit_indication: 0,
        fresh_artifact_exists: 0,
        no_candidate: 0,
      },
      topAdvisedIdentities: ['orderbook:hyperliquid:BTC:standard'],
    },
    assessmentRequests: {
      totalRows: 4,
      successfulFreshRuns: 1,
      successfulCacheHits: 2,
      reuseDefinition: 'cache_hit_only',
      requestInFlight: 0,
      billingBlocked: 0,
      cooldownBlocked: 1,
      identityUnresolved: 0,
      providerFailed: 0,
      lastSuccessfulArtifactId: 'artifact_123',
    },
    presetTransitions: {
      totalRows: 0,
      applied: 0,
      deferred: 0,
      rejected: 0,
      failed: 0,
      partiallyApplied: 0,
      modesObserved: [],
      lastAppliedTransition: null,
    },
    currentDefaultBinding: {
      activePresetKey: 'momentum_v1',
      behaviorVersion: 'hash_abc',
      styleTier: 'standard',
      sourceArtifactId: 'artifact_123',
      sourceTransitionId: null,
    },
    identityScopedTransitionsObserved: false,
    auditCaveats: [],
    ...overrides,
  };
}

describe('renderPresetAssessmentAppendix', () => {
  it('returns empty string when includedInReport is false', () => {
    const summary = makeSummary({ includedInReport: false });
    expect(renderPresetAssessmentAppendix(summary)).toBe('');
  });

  it('renders the appendix header with inclusion reason', () => {
    const output = renderPresetAssessmentAppendix(makeSummary());
    expect(output).toContain('## Preset Assessment Summary');
    expect(output).toContain('Inclusion reason: enabled_and_activity');
    expect(output).toContain('Scope note: current config snapshot');
  });

  it('renders section 1 — Feature Enablement', () => {
    const output = renderPresetAssessmentAppendix(makeSummary());
    expect(output).toContain('### 1. Feature Enablement');
    expect(output).toContain('Answer: yes');
    expect(output).toContain('Current opt-in flag: true');
    expect(output).toContain('Style tier: standard');
    expect(output).toContain('Allowed presets: momentum_v1, mean_reversion_v1');
  });

  it('renders section 2 — Review Advice', () => {
    const output = renderPresetAssessmentAppendix(makeSummary());
    expect(output).toContain('### 2. Review Advice');
    expect(output).toContain('Answer: yes');
    expect(output).toContain('Advice rows in scope: 3');
    expect(output).toContain('Advised rows: 2');
    expect(output).toContain('Consumed advice rows: 1');
    expect(output).toContain('Top advised identities: orderbook:hyperliquid:BTC:standard');
  });

  it('renders section 3 — Assessment Requests And Reuse', () => {
    const output = renderPresetAssessmentAppendix(makeSummary());
    expect(output).toContain('### 3. Assessment Requests And Reuse');
    expect(output).toContain('Answer: yes');
    expect(output).toContain('Successful fresh runs: 1');
    expect(output).toContain('Successful cache hits: 2');
    expect(output).toContain('Reuse definition: cache_hit only');
    expect(output).toContain('Last successful artifact: artifact_123');
  });

  it('renders section 4 — Preset Changes', () => {
    const summary = makeSummary({
      presetTransitions: {
        totalRows: 2,
        applied: 1,
        deferred: 0,
        rejected: 1,
        failed: 0,
        partiallyApplied: 0,
        modesObserved: ['entries_only'],
        lastAppliedTransition: {
          id: 'trans-1',
          oldPresetKey: 'economy',
          newPresetKey: 'standard',
          transitionMode: 'entries_only',
          assessmentArtifactId: 'art-1',
          appliedAt: '2026-07-19T12:00:00Z',
        },
      },
    });
    const output = renderPresetAssessmentAppendix(summary);
    expect(output).toContain('### 4. Preset Changes');
    expect(output).toContain('Answer: not_applicable'); // from the default answers
    expect(output).toContain('Transition rows in scope: 2');
    expect(output).toContain('Last applied transition: economy -> standard via entries_only');
  });

  it('renders Evidence Notes with binding info', () => {
    const output = renderPresetAssessmentAppendix(makeSummary());
    expect(output).toContain('### Evidence Notes');
    expect(output).toContain('Current active default preset binding: momentum_v1 (behavior: hash_abc)');
    expect(output).toContain('Identity-scoped transitions observed in scope: no');
  });

  it('renders audit caveats in Evidence Notes', () => {
    const summary = makeSummary({
      auditCaveats: ['Caveat A', 'Caveat B'],
    });
    const output = renderPresetAssessmentAppendix(summary);
    expect(output).toContain('Audit caveats:');
    expect(output).toContain('  - Caveat A');
    expect(output).toContain('  - Caveat B');
  });

  it('does not render audit caveats section when empty', () => {
    const output = renderPresetAssessmentAppendix(makeSummary({ auditCaveats: [] }));
    expect(output).not.toContain('Audit caveats:');
  });

  it('handles missing config fields gracefully', () => {
    const summary = makeSummary({
      configSnapshot: {
        platformAssessmentEnabled: null,
        styleTier: null,
        allowedPresets: null,
        allowedTransitionModes: null,
        supportedApplyTransitionModes: null,
        source: 'unavailable',
      },
    });
    const output = renderPresetAssessmentAppendix(summary);
    expect(output).toContain('Current opt-in flag: unknown');
    expect(output).toContain('Style tier: unknown');
    expect(output).toContain('Allowed presets: not configured');
  });

  it('renders last applied transition as none when null', () => {
    const output = renderPresetAssessmentAppendix(makeSummary());
    expect(output).toContain('Last applied transition: none');
  });

  it('renders summary with failed or partially applied count', () => {
    const summary = makeSummary({
      presetTransitions: {
        totalRows: 3,
        applied: 1,
        deferred: 0,
        rejected: 0,
        failed: 1,
        partiallyApplied: 1,
        modesObserved: [],
        lastAppliedTransition: null,
      },
    });
    const output = renderPresetAssessmentAppendix(summary);
    expect(output).toContain('Failed or partially applied: 2');
  });
});
