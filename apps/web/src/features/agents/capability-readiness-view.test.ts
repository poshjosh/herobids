import { describe, expect, it } from 'vitest';
import type { CapabilityReadiness } from '../../lib/api-client.js';
import { toReadinessView } from './capability-readiness-view.js';

/**
 * Build a CapabilityReadiness fixture. `connectionReadiness`/`agentEligibility`
 * are not read by `toReadinessView` (it keys off `state`, `effectiveReady`, and
 * `reasons`) but are required by the contract, so they carry sensible defaults.
 */
function makeReadiness(overrides: Partial<CapabilityReadiness>): CapabilityReadiness {
  return {
    family: 'trading',
    state: 'unconfigured',
    connectionReadiness: 'unconfigured',
    agentEligibility: 'eligible',
    effectiveReady: false,
    reasons: [],
    ...overrides,
  };
}

describe('toReadinessView', () => {
  it('reports a ready tone and headline with no reason or action when the capability is ready', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'ready',
        effectiveReady: true,
        connectionReadiness: 'ready',
        agentEligibility: 'eligible',
        reasons: [],
      }),
    );

    expect(view.tone).toBe('ready');
    expect(view.headlineId).toBe('agents.capabilityPage.status.readyHeadline');
    expect(view.reasonId).toBeUndefined();
    expect(view.rawReason).toBeUndefined();
    expect(view.action).toBeUndefined();
  });

  it('warns with an assign-connection action when no connection has been assigned', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'unconfigured',
        effectiveReady: false,
        reasons: ['no connections have been assigned for this capability family'],
      }),
    );

    expect(view.tone).toBe('warn');
    expect(view.headlineId).toBe('agents.capabilityPage.status.noConnectionHeadline');
    expect(view.reasonId).toBe('agents.capabilityPage.status.noConnectionReason');
    expect(view.rawReason).toBeUndefined();
    expect(view.action?.labelId).toBe('agents.capabilityPage.status.action.assignConnection');
    expect(view.action?.helperId).toBe('agents.capabilityPage.status.action.assignHelper');
    expect(view.action?.variant).toBe('primary');
    expect(view.action?.action.kind).toBe('assignConnection');
  });

  it('warns with a finish-setup action when the connection has no resolved venue account', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'unconfigured',
        effectiveReady: false,
        reasons: ['connection has no resolved venue account — complete trading setup first'],
      }),
    );

    expect(view.tone).toBe('warn');
    expect(view.headlineId).toBe('agents.capabilityPage.status.setupIncompleteHeadline');
    expect(view.reasonId).toBe('agents.capabilityPage.status.setupIncompleteReason');
    expect(view.rawReason).toBeUndefined();
    expect(view.action?.labelId).toBe('agents.capabilityPage.status.action.finishSetup');
    expect(view.action?.variant).toBe('primary');
    expect(view.action?.action.kind).toBe('finishSetup');
  });

  it('blocks with an assign-connection action when the connection was revoked', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'revoked',
        effectiveReady: false,
        reasons: ['connection has been revoked'],
      }),
    );

    expect(view.tone).toBe('blocked');
    expect(view.headlineId).toBe('agents.capabilityPage.status.revokedHeadline');
    expect(view.reasonId).toBe('agents.capabilityPage.status.revokedReason');
    expect(view.rawReason).toBeUndefined();
    expect(view.action?.labelId).toBe('agents.capabilityPage.status.action.assignConnection');
    expect(view.action?.variant).toBe('primary');
    expect(view.action?.action.kind).toBe('assignConnection');
  });

  it('blocks with an assign-connection action when the agent assignment was revoked', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'revoked',
        effectiveReady: false,
        reasons: ['connection assignment has been revoked'],
      }),
    );

    expect(view.tone).toBe('blocked');
    expect(view.headlineId).toBe('agents.capabilityPage.status.accessRemovedHeadline');
    expect(view.reasonId).toBe('agents.capabilityPage.status.accessRemovedReason');
    expect(view.rawReason).toBeUndefined();
    expect(view.action?.labelId).toBe('agents.capabilityPage.status.action.assignConnection');
    expect(view.action?.variant).toBe('primary');
    expect(view.action?.action.kind).toBe('assignConnection');
  });

  it('falls back to the generic headline and shows the raw reason verbatim for an unhandled state', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'provisioning',
        effectiveReady: false,
        reasons: ['something custom'],
      }),
    );

    expect(view.tone).toBe('warn');
    expect(view.headlineId).toBe('agents.capabilityPage.status.genericNotReadyHeadline');
    expect(view.rawReason).toBe('something custom');
    expect(view.reasonId).toBeUndefined();
    expect(view.action?.variant).toBe('secondary');
    expect(view.action?.action.kind).toBe('assignConnection');
  });

  it('uses the neutral generic reason when a fallback state carries no reasons', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'degraded',
        effectiveReady: false,
        reasons: [],
      }),
    );

    expect(view.headlineId).toBe('agents.capabilityPage.status.genericNotReadyHeadline');
    expect(view.reasonId).toBe('agents.capabilityPage.status.genericNotReadyReason');
    expect(view.rawReason).toBeUndefined();
    expect(view.action?.variant).toBe('secondary');
  });

  it('does not mis-map an unrecognised reason on a known state and shows it verbatim instead', () => {
    const view = toReadinessView(
      makeReadiness({
        state: 'revoked',
        effectiveReady: false,
        reasons: ['totally unrecognized reason'],
      }),
    );

    expect(view.headlineId).toBe('agents.capabilityPage.status.genericNotReadyHeadline');
    expect(view.rawReason).toBe('totally unrecognized reason');
    expect(view.reasonId).toBeUndefined();
    expect(view.action?.variant).toBe('secondary');
  });

  describe('non-trading family (email)', () => {
    it('reports the neutral ready headline when an email capability is ready', () => {
      const view = toReadinessView(
        makeReadiness({
          family: 'email',
          state: 'ready',
          effectiveReady: true,
          connectionReadiness: 'ready',
          reasons: [],
        }),
      );

      expect(view.tone).toBe('ready');
      expect(view.headlineId).toBe('agents.capabilityPage.status.readyHeadlineGeneric');
      expect(view.reasonId).toBeUndefined();
      expect(view.action).toBeUndefined();
    });

    it('uses neutral copy and a generic assign helper when no connection is assigned', () => {
      const view = toReadinessView(
        makeReadiness({
          family: 'email',
          state: 'unconfigured',
          effectiveReady: false,
          reasons: ['no connections have been assigned for this capability family'],
        }),
      );

      expect(view.tone).toBe('warn');
      expect(view.headlineId).toBe('agents.capabilityPage.status.noConnectionHeadlineGeneric');
      expect(view.reasonId).toBe('agents.capabilityPage.status.noConnectionReasonGeneric');
      expect(view.rawReason).toBeUndefined();
      expect(view.action?.labelId).toBe('agents.capabilityPage.status.action.assignConnection');
      expect(view.action?.helperId).toBe('agents.capabilityPage.status.action.assignHelperGeneric');
      expect(view.action?.variant).toBe('primary');
      expect(view.action?.action.kind).toBe('assignConnection');
    });

    it('uses the neutral revoked reason when the connection was revoked', () => {
      const view = toReadinessView(
        makeReadiness({
          family: 'email',
          state: 'revoked',
          effectiveReady: false,
          reasons: ['connection has been revoked'],
        }),
      );

      expect(view.tone).toBe('blocked');
      expect(view.headlineId).toBe('agents.capabilityPage.status.revokedHeadline');
      expect(view.reasonId).toBe('agents.capabilityPage.status.revokedReasonGeneric');
      expect(view.rawReason).toBeUndefined();
      expect(view.action?.labelId).toBe('agents.capabilityPage.status.action.assignConnection');
      expect(view.action?.action.kind).toBe('assignConnection');
    });

    it('keeps the family-neutral access-removed copy when the assignment was revoked', () => {
      const view = toReadinessView(
        makeReadiness({
          family: 'email',
          state: 'revoked',
          effectiveReady: false,
          reasons: ['connection assignment has been revoked'],
        }),
      );

      expect(view.tone).toBe('blocked');
      expect(view.headlineId).toBe('agents.capabilityPage.status.accessRemovedHeadline');
      expect(view.reasonId).toBe('agents.capabilityPage.status.accessRemovedReason');
      expect(view.rawReason).toBeUndefined();
      expect(view.action?.action.kind).toBe('assignConnection');
    });

    it('does not show trading setup copy for a venue-account reason and falls back to the raw reason', () => {
      const view = toReadinessView(
        makeReadiness({
          family: 'email',
          state: 'unconfigured',
          effectiveReady: false,
          reasons: ['connection has no resolved venue account — complete trading setup first'],
        }),
      );

      expect(view.headlineId).toBe('agents.capabilityPage.status.genericNotReadyHeadline');
      expect(view.reasonId).toBeUndefined();
      expect(view.rawReason).toBe('connection has no resolved venue account — complete trading setup first');
      expect(view.action?.variant).toBe('secondary');
    });
  });
});
