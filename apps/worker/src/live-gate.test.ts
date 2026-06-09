import { describe, it, expect } from 'vitest';
import { assertLiveReadiness, LiveGateError } from './live-gate.js';
import type { LiveGateInput } from './live-gate.js';
import type { LiveRolloutConfig } from '@herobids/domain';

const DEFAULT_ROLLOUT: LiveRolloutConfig = {
  enabled: true,
  allowedVenues: ['hyperliquid'],
  requireDbCredentials: true,
  maxInitialOrderNotionalUsd: '50',
  maxConsecutiveVenueErrors: 3,
  slippageAlertBps: 50,
};

const VALID_LIVE_INPUT: LiveGateInput = {
  executionMode: 'live',
  venue: 'hyperliquid',
  venueType: 'orderbook',
  venueAccountId: 'va-prod-1',
  credentialsFromDb: true,
  credentialsPresent: true,
  driftAlertOnly: false,
  instanceMaxOrderNotional: '100',
};

describe('assertLiveReadiness', () => {
  describe('non-live modes pass through', () => {
    it('returns undefined notional for paper mode when instance has no cap', () => {
      const disabled = { ...DEFAULT_ROLLOUT, enabled: false };
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, executionMode: 'paper', instanceMaxOrderNotional: undefined };
      const result = assertLiveReadiness(disabled, input);
      expect(result.effectiveMaxOrderNotional).toBeUndefined();
    });

    it('preserves instance notional for paper mode when configured', () => {
      const disabled = { ...DEFAULT_ROLLOUT, enabled: false };
      const result = assertLiveReadiness(disabled, { ...VALID_LIVE_INPUT, executionMode: 'paper' });
      expect(result.effectiveMaxOrderNotional!.toNumber()).toBe(100);
    });

    // bug-010 regression: paper mode must NOT be blocked by credential checks.
    //
    // Before the fix, the credential guard in the worker (index.ts) would throw
    // CredentialResolutionError for paper-mode instances that had no credential
    // linked to their venue account — because the guard did not check execution
    // mode. After the fix the guard is mode-aware: paper mode proceeds without
    // credentials.
    //
    // assertLiveReadiness() mirrors this policy: it is only invoked after
    // credential resolution succeeds (or is intentionally skipped for paper mode),
    // so it must also pass paper-mode instances even when credentialsFromDb and
    // credentialsPresent are both false.
    it('does not reject paper mode even when no credentials are present (bug-010 regression)', () => {
      const input: LiveGateInput = {
        ...VALID_LIVE_INPUT,
        executionMode: 'paper',
        credentialsFromDb: false,
        credentialsPresent: false,
      };
      // Must not throw regardless of liveRollout.enabled — paper mode bypasses
      // all credential and live-gate enforcement.
      expect(() => assertLiveReadiness(DEFAULT_ROLLOUT, input)).not.toThrow();
      expect(() => assertLiveReadiness({ ...DEFAULT_ROLLOUT, enabled: false }, input)).not.toThrow();
    });

    it('returns undefined notional for shadow mode when instance has no cap', () => {
      const disabled = { ...DEFAULT_ROLLOUT, enabled: false };
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, executionMode: 'shadow', instanceMaxOrderNotional: undefined };
      const result = assertLiveReadiness(disabled, input);
      expect(result.effectiveMaxOrderNotional).toBeUndefined();
    });
  });

  describe('live mode gates', () => {
    it('rejects when liveRollout.enabled is false', () => {
      const disabled = { ...DEFAULT_ROLLOUT, enabled: false };
      expect(() => assertLiveReadiness(disabled, VALID_LIVE_INPUT))
        .toThrow(LiveGateError);
      expect(() => assertLiveReadiness(disabled, VALID_LIVE_INPUT))
        .toThrow('not enabled');
    });

    it('rejects when venue is not in allowedVenues', () => {
      const rollout = { ...DEFAULT_ROLLOUT, allowedVenues: ['kraken'] };
      expect(() => assertLiveReadiness(rollout, VALID_LIVE_INPUT))
        .toThrow('not in liveRollout.allowedVenues');
    });

    it('rejects swap venues', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, venueType: 'swap', venue: 'jupiter' };
      const rollout = { ...DEFAULT_ROLLOUT, allowedVenues: ['jupiter'] };
      expect(() => assertLiveReadiness(rollout, input))
        .toThrow('orderbook venues');
    });

    it('rejects env-var credential fallback when requireDbCredentials is true', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, credentialsFromDb: false };
      expect(() => assertLiveReadiness(DEFAULT_ROLLOUT, input))
        .toThrow('DB-backed credentials');
    });

    it('allows env-var fallback when requireDbCredentials is false', () => {
      const rollout = { ...DEFAULT_ROLLOUT, requireDbCredentials: false };
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, credentialsFromDb: false };
      const result = assertLiveReadiness(rollout, input);
      expect(result.effectiveMaxOrderNotional).toBeDefined();
    });

    it('rejects when credentials are empty', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, credentialsPresent: false };
      expect(() => assertLiveReadiness(DEFAULT_ROLLOUT, input))
        .toThrow('non-empty credentials');
    });

    // bug-006 regression: instance start must be rejected fast when the venue account
    // has no credential linked and no env-var fallback is present.
    //
    // Before the fix, POST /instances/:id/start would succeed at the API layer even when
    // the linked venue account had no credentialId in the DB.  The worker then attempted
    // to decrypt a credential that did not exist, failed with CredentialResolutionError,
    // and crashed the instance.  The operator only saw the crash after the fact.
    //
    // After the fix, the live gate (called by the worker after credential resolution) now
    // enforces that credentials must be non-empty for live mode, so a missing credential
    // is caught before any trade is attempted.  The worker also throws CredentialResolutionError
    // earlier in the startup path for non-paper modes that have no credentialId (see index.ts).
    it('rejects live mode when no credential is linked to the venue account and no env-var fallback exists (bug-006 regression)', () => {
      // Scenario: venue account has no credentialId in DB (credentialsFromDb: false)
      // and no env-var secrets are set (credentialsPresent: false).
      // requireDbCredentials: false relaxes the DB requirement so we isolate the
      // credentialsPresent check — the gate must still reject.
      const rollout = { ...DEFAULT_ROLLOUT, requireDbCredentials: false };
      const input: LiveGateInput = {
        ...VALID_LIVE_INPUT,
        credentialsFromDb: false,
        credentialsPresent: false,
      };
      expect(() => assertLiveReadiness(rollout, input)).toThrow(LiveGateError);
      expect(() => assertLiveReadiness(rollout, input)).toThrow('non-empty credentials');
    });

    it('rejects when driftAlertOnly is true', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, driftAlertOnly: true };
      expect(() => assertLiveReadiness(DEFAULT_ROLLOUT, input))
        .toThrow('driftAlertOnly must be false');
    });
  });

  describe('notional clamping', () => {
    it('clamps instance notional to operator cap', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, instanceMaxOrderNotional: '200' };
      const result = assertLiveReadiness(DEFAULT_ROLLOUT, input);
      // Operator cap is 50, instance wants 200 → clamped to 50
      expect(result.effectiveMaxOrderNotional!.toNumber()).toBe(50);
    });

    it('uses instance notional when below operator cap', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, instanceMaxOrderNotional: '25' };
      const result = assertLiveReadiness(DEFAULT_ROLLOUT, input);
      expect(result.effectiveMaxOrderNotional!.toNumber()).toBe(25);
    });

    it('uses operator cap when instance does not specify notional', () => {
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, instanceMaxOrderNotional: undefined };
      const result = assertLiveReadiness(DEFAULT_ROLLOUT, input);
      expect(result.effectiveMaxOrderNotional!.toNumber()).toBe(50);
    });

    it('preserves fractional precision', () => {
      const rollout = { ...DEFAULT_ROLLOUT, maxInitialOrderNotionalUsd: '49.99' };
      const input: LiveGateInput = { ...VALID_LIVE_INPUT, instanceMaxOrderNotional: '100' };
      const result = assertLiveReadiness(rollout, input);
      expect(result.effectiveMaxOrderNotional!.toString()).toBe('49.99');
    });
  });

  describe('error codes', () => {
    it('includes structured code on LiveGateError', () => {
      const disabled = { ...DEFAULT_ROLLOUT, enabled: false };
      try {
        assertLiveReadiness(disabled, VALID_LIVE_INPUT);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LiveGateError);
        expect((e as LiveGateError).code).toBe('live_rollout.disabled');
      }
    });
  });
});
