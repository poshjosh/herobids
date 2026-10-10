import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveNotificationPolicy, resolveExecutionModeForSkills, resolveAuthorizationMode, validateConnectionRequirement, registerBackendRefFamilies, validateMaxHoldDurationInvariant, resolveAgentRiskContractForResponse } from './agent-config-helpers.js';

describe('resolveNotificationPolicy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for create-time empty notificationPolicy payloads', () => {
    expect(resolveNotificationPolicy({}, null)).toBeNull();
    expect(resolveNotificationPolicy({ sendMessage: {} }, null)).toBeNull();
  });

  it('preserves the current policy when a PATCH payload omits nested email fields', () => {
    const current = {
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_update' as const,
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    };

    expect(resolveNotificationPolicy({}, current)).toEqual(current);
    expect(resolveNotificationPolicy({ sendMessage: {} }, current)).toEqual(current);
  });

  it('writes enabledAt when enabling email for the first time', () => {
    expect(resolveNotificationPolicy({
      sendMessage: {
        email: { enabled: true, source: 'explicit_update' },
      },
    }, null)).toEqual({
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_update',
          enabledAt: '2026-06-11T12:00:00.000Z',
        },
      },
    });
  });

  it('preserves enabledAt when email stays enabled', () => {
    expect(resolveNotificationPolicy({
      sendMessage: {
        email: { enabled: true, source: 'explicit_update' },
      },
    }, {
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_prompt',
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    })).toEqual({
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_update',
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    });
  });

  it('clears enabledAt when disabling email', () => {
    expect(resolveNotificationPolicy({
      sendMessage: {
        email: { enabled: false, source: 'explicit_update' },
      },
    }, {
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_prompt',
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    })).toEqual({
      sendMessage: {
        email: {
          enabled: false,
          source: 'explicit_update',
        },
      },
    });
  });
});

// Phase 4 (D21): trading capability now resolves from an external skills.sh ref
// via the config-registered backend-ref family map (registerBackendRefFamilies).
// Register the map so hasSkillCapabilityFamily(skillIds, 'trading') resolves.
const CRYPTO_TRADING_REF = 'traderton/skills/crypto-trading';
const NONTRADING_ID = 'base';

beforeEach(() => {
  registerBackendRefFamilies([{
    refs: [
      'traderton/skills/crypto-trading',
      'traderton/skills/crypto-bot-management',
      'traderton/skills/crypto-risk-monitoring',
    ],
    family: 'trading',
  }]);
});

describe('resolveExecutionModeForSkills', () => {
  describe('non-trading agents', () => {
    it('returns null when no skills are set and no mode provided', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: null,
        submittedExecutionMode: undefined,
        executionModeProvided: false,
      });
      expect(result.value).toBeNull();
      expect(result.issue).toBeUndefined();
    });

    it('returns null when agent only has non-trading skills', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [NONTRADING_ID],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
      });
      expect(result.value).toBeNull();
    });

    it('returns an issue when a non-trading agent provides an execution mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [NONTRADING_ID],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('executionMode');
    });

    it('silently ignores explicit null mode for non-trading agent', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [NONTRADING_ID],
        submittedExecutionMode: null,
        executionModeProvided: true,
      });
      // null mode with trading-capable flag false is treated as "not set" (no issue)
      expect(result.issue).toBeUndefined();
      expect(result.value).toBeNull();
    });
  });

  describe('trading agents — mode provided', () => {
    it('resolves paper mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
      });
      expect(result.value).toBe('paper');
      expect(result.issue).toBeUndefined();
    });

    it('resolves shadow mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'shadow',
        executionModeProvided: true,
      });
      expect(result.value).toBe('shadow');
    });

    it('resolves live mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'live',
        executionModeProvided: true,
      });
      expect(result.value).toBe('live');
    });

    it('returns an issue when test mode is submitted (non-canonical, rejected)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'test',
        executionModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('executionMode');
      expect(result.value).toBeNull();
    });

    it('returns an issue when an invalid mode string is submitted', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: null, // null is treated as "unset" → issue
        executionModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('executionMode');
    });
  });

  describe('trading agents — mode immutability guard', () => {
    const IMMUTABILITY_MSG = "Execution mode cannot be changed after creation. Use 'Go Live' to create a live agent from this configuration.";

    it('rejects paper → live', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'live',
        executionModeProvided: true,
        currentExecutionMode: 'paper',
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.message).toBe(IMMUTABILITY_MSG);
      expect(result.value).toBeNull();
    });

    it('rejects shadow → live', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'live',
        executionModeProvided: true,
        currentExecutionMode: 'shadow',
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.message).toBe(IMMUTABILITY_MSG);
      expect(result.value).toBeNull();
    });

    it('rejects live → paper', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
        currentExecutionMode: 'live',
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.message).toBe(IMMUTABILITY_MSG);
      expect(result.value).toBeNull();
    });

    it('rejects live → shadow', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'shadow',
        executionModeProvided: true,
        currentExecutionMode: 'live',
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.message).toBe(IMMUTABILITY_MSG);
      expect(result.value).toBeNull();
    });

    it('allows paper → shadow (test↔test)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'shadow',
        executionModeProvided: true,
        currentExecutionMode: 'paper',
      });
      expect(result.value).toBe('shadow');
      expect(result.issue).toBeUndefined();
    });

    it('allows shadow → paper (test↔test)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
        currentExecutionMode: 'shadow',
      });
      expect(result.value).toBe('paper');
      expect(result.issue).toBeUndefined();
    });

    it('allows paper → paper (no-op)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
        currentExecutionMode: 'paper',
      });
      expect(result.value).toBe('paper');
      expect(result.issue).toBeUndefined();
    });

    it('allows shadow → shadow (no-op)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'shadow',
        executionModeProvided: true,
        currentExecutionMode: 'shadow',
      });
      expect(result.value).toBe('shadow');
      expect(result.issue).toBeUndefined();
    });

    it('allows live → live (no-op)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: 'live',
        executionModeProvided: true,
        currentExecutionMode: 'live',
      });
      expect(result.value).toBe('live');
      expect(result.issue).toBeUndefined();
    });

    it('allows any mode when currentExecutionMode is null (creation path)', () => {
      for (const mode of ['paper', 'shadow', 'live'] as const) {
        const result = resolveExecutionModeForSkills({
          skillIds: [CRYPTO_TRADING_REF],
          submittedExecutionMode: mode,
          executionModeProvided: true,
          currentExecutionMode: null,
        });
        expect(result.value).toBe(mode);
        expect(result.issue).toBeUndefined();
      }
    });

    it('allows any mode when currentExecutionMode is undefined (creation path)', () => {
      for (const mode of ['paper', 'shadow', 'live'] as const) {
        const result = resolveExecutionModeForSkills({
          skillIds: [CRYPTO_TRADING_REF],
          submittedExecutionMode: mode,
          executionModeProvided: true,
        });
        expect(result.value).toBe(mode);
        expect(result.issue).toBeUndefined();
      }
    });

    it('allows paper↔shadow auto-transition when executionModeProvided is false (carry-forward path unchanged)', () => {
      const upgradeResult = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'paper',
        hasConnections: true,
      });
      expect(upgradeResult.value).toBe('shadow');
      expect(upgradeResult.issue).toBeUndefined();

      const downgradeResult = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'shadow',
        hasConnections: false,
      });
      expect(downgradeResult.value).toBe('paper');
      expect(downgradeResult.issue).toBeUndefined();
    });
  });

  describe('trading agents — mode not provided', () => {
    it('carries forward existing mode when available', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'live',
      });
      expect(result.value).toBe('live');
      expect(result.issue).toBeUndefined();
    });

    it('defaults to paper when no existing mode is set (creation path)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: null,
      });
      expect(result.value).toBe('paper');
      expect(result.issue).toBeUndefined();
    });

    it('defaults to paper when currentExecutionMode is omitted entirely', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
      });
      expect(result.value).toBe('paper');
    });

    it('ignores a corrupt currentExecutionMode and defaults to paper', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'invalid-mode',
      });
      expect(result.value).toBe('paper');
    });

    it('upgrades paper to shadow when connections become available', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'paper',
        hasConnections: true,
      });
      expect(result.value).toBe('shadow');
    });

    it('downgrades shadow to paper when connections are removed', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'shadow',
        hasConnections: false,
      });
      expect(result.value).toBe('paper');
    });

    it('keeps shadow when connections are still present', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'shadow',
        hasConnections: true,
      });
      expect(result.value).toBe('shadow');
    });

    it('keeps paper when no connections are present', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [CRYPTO_TRADING_REF],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'paper',
        hasConnections: false,
      });
      expect(result.value).toBe('paper');
    });
  });
});

describe('resolveAuthorizationMode', () => {
  describe('non-trading agents', () => {
    it('returns null when no explicit authMode is provided', () => {
      const result = resolveAuthorizationMode({
        skillIds: [NONTRADING_ID],
        submittedAuthorizationMode: undefined,
        authorizationModeProvided: false,
      });
      expect(result.value).toBeNull();
      expect(result.issue).toBeUndefined();
    });

    it('returns an issue when an explicit authMode is provided for a non-trading agent', () => {
      const result = resolveAuthorizationMode({
        skillIds: [NONTRADING_ID],
        submittedAuthorizationMode: 'direct',
        authorizationModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('authorizationMode');
      expect(result.value).toBeNull();
    });

    it('rejects authMode for agents with null/empty skillIds', () => {
      const result = resolveAuthorizationMode({
        skillIds: null,
        submittedAuthorizationMode: 'approval_required',
        authorizationModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('authorizationMode');
      expect(result.value).toBeNull();
    });
  });

  describe('trading agents — mode provided', () => {
    it('resolves explicit "direct" mode', () => {
      const result = resolveAuthorizationMode({
        skillIds: [CRYPTO_TRADING_REF],
        submittedAuthorizationMode: 'direct',
        authorizationModeProvided: true,
      });
      expect(result.value).toBe('direct');
      expect(result.issue).toBeUndefined();
    });

    it('resolves explicit "approval_required" mode', () => {
      const result = resolveAuthorizationMode({
        skillIds: [CRYPTO_TRADING_REF],
        submittedAuthorizationMode: 'approval_required',
        authorizationModeProvided: true,
      });
      expect(result.value).toBe('approval_required');
      expect(result.issue).toBeUndefined();
    });

    it('returns an issue for an invalid authMode string', () => {
      const result = resolveAuthorizationMode({
        skillIds: [CRYPTO_TRADING_REF],
        submittedAuthorizationMode: 'invalid_mode',
        authorizationModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('authorizationMode');
      expect(result.value).toBeNull();
    });

    it('returns an issue for null authMode when explicitly provided', () => {
      const result = resolveAuthorizationMode({
        skillIds: [CRYPTO_TRADING_REF],
        submittedAuthorizationMode: null,
        authorizationModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('authorizationMode');
      expect(result.value).toBeNull();
    });
  });

  describe('trading agents — mode not provided', () => {
    it('defaults to "direct" when no explicit authMode is provided', () => {
      const result = resolveAuthorizationMode({
        skillIds: [CRYPTO_TRADING_REF],
        submittedAuthorizationMode: undefined,
        authorizationModeProvided: false,
      });
      expect(result.value).toBe('direct');
      expect(result.issue).toBeUndefined();
    });

    it('defaults to "direct" when authorizationModeProvided is false even with a value', () => {
      // The submitted value is ignored when the flag indicates it was not provided.
      const result = resolveAuthorizationMode({
        skillIds: [CRYPTO_TRADING_REF],
        submittedAuthorizationMode: 'approval_required',
        authorizationModeProvided: false,
      });
      expect(result.value).toBe('direct');
      expect(result.issue).toBeUndefined();
    });
  });
});

describe('validateConnectionRequirement', () => {
  it('returns an issue when live mode has no granted connection', () => {
    const issue = validateConnectionRequirement('live', false);
    expect(issue).toEqual({
      code: 'custom',
      path: ['connectionIds'],
      message: 'At least one connection is required for live or shadow execution.',
    });
  });

  it('returns an issue when shadow mode has no granted connection', () => {
    const issue = validateConnectionRequirement('shadow', false);
    expect(issue).not.toBeNull();
    expect(issue?.path).toEqual(['connectionIds']);
  });

  it('returns null when live mode has a granted connection', () => {
    expect(validateConnectionRequirement('live', true)).toBeNull();
  });

  it('returns null when shadow mode has a granted connection', () => {
    expect(validateConnectionRequirement('shadow', true)).toBeNull();
  });

  it('returns null for paper mode regardless of connections', () => {
    expect(validateConnectionRequirement('paper', false)).toBeNull();
  });

  it('returns null when execution mode is null', () => {
    expect(validateConnectionRequirement(null, false)).toBeNull();
  });
});

describe('validateMaxHoldDurationInvariant (D9)', () => {
  const TWENTY_FOUR_HOURS_MINS = 1440;
  const CAREFUL_MAX_HOLD_MS = 27_000_000; // 450 min

  it('rejects a 24 h interval on a careful trading agent when skip-unchanged is on', () => {
    const issues = validateMaxHoldDurationInvariant({
      tickIntervalMs: TWENTY_FOUR_HOURS_MINS * 60_000,
      style: 'careful',
      runtimePolicyOverrides: { skipUnchangedTicks: true },
      skillIds: ['traderton/skills/crypto-trading'],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toEqual(['runtimePolicyOverrides', 'maxHoldDurationMs']);
  });

  it('accepts the same 24 h interval when skip-unchanged is off', () => {
    const issues = validateMaxHoldDurationInvariant({
      tickIntervalMs: TWENTY_FOUR_HOURS_MINS * 60_000,
      style: 'careful',
      runtimePolicyOverrides: { skipUnchangedTicks: false },
      skillIds: [],
    });
    expect(issues).toEqual([]);
  });

  it('accepts a 24 h interval for a non-trading agent by default (skip-unchanged resolves off)', () => {
    const issues = validateMaxHoldDurationInvariant({
      tickIntervalMs: TWENTY_FOUR_HOURS_MINS * 60_000,
      style: 'careful',
      runtimePolicyOverrides: null,
      skillIds: [],
    });
    expect(issues).toEqual([]);
  });

  it('still rejects a sub-maxHold interval mismatch when skip-unchanged is on', () => {
    // tick interval just above the careful max hold → invalid.
    const issues = validateMaxHoldDurationInvariant({
      tickIntervalMs: CAREFUL_MAX_HOLD_MS + 60_000,
      style: 'careful',
      runtimePolicyOverrides: { skipUnchangedTicks: true },
      skillIds: ['traderton/skills/crypto-trading'],
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('resolveAgentRiskContractForResponse (B3.1)', () => {
  const defaults = {
    dailyLossLimitDefaultRatio: 0.05,
    maxOpenPositions: 10,
    maxPositionSizePct: 100,
    maxPositionSize: 1_000_000,
    stopLossPct: 10,
    dailyMaxLossPct: 20,
    stopLossCooldownMs: 300_000,
    maxOrderNotionalMultiplier: 1,
    botConfigInvalidHaltThreshold: 1,
    botExecutionErrorHaltThreshold: 5,
    botLlmProviderErrorHaltThreshold: 1,
    agentDecisionNoContextThreshold: 10,
    agentDecisionSwapInstrumentFormatThreshold: 5,
    maxDrawdown: 1_000_000_000,
    maxDrawdownPct: 20,
    perTradeLevelMonitorIntervalMs: 5000,
    maxBots: 5,
  };

  // Test 1 — characterization (should pass today): empty profile → operator-default
  // ceilings only, no creator input, no overrides.
  it('with an empty profile returns only operator-default ceilings and no creator input', () => {
    const contract = resolveAgentRiskContractForResponse({}, defaults);

    expect(contract.maxOpenPositions).toMatchObject({
      effectiveValue: 10,
      source: 'default',
      mutable: true,
      operatorCeiling: 10,
    });
    expect(contract.maxOpenPositions.creatorValue).toBeUndefined();
    expect(contract.maxOpenPositions.overrideValue).toBeUndefined();
    expect(contract.stopLossPct.effectiveValue).toBe(10);
    expect(contract.stopLossCooldownMs.effectiveValue).toBe(300_000);
    expect(contract.maxDrawdownPct.effectiveValue).toBe(20);
    expect(contract.maxPositionSizePct.effectiveValue).toBe(100);
  });

  // Test 4 — no-enforcement guard (should pass both before and after): the
  // resolved contract is a pure display value; nothing here gates a decision.
  it('produces a display-only contract with no enforcement side effects', () => {
    const contract = resolveAgentRiskContractForResponse(
      { capital: '1000', riskPosture: { maxOpenPositions: 3 }, riskOverrides: { stopLossPct: 5 } },
      defaults,
    );

    // The function is pure: it returns a value and mutates nothing external.
    expect(contract.maxOpenPositions.effectiveValue).toBe(3);
    expect(contract.maxOpenPositions.source).toBe('user');
    expect(contract.stopLossPct.effectiveValue).toBe(5);
    expect(contract.stopLossPct.source).toBe('agent_override');
  });
});
