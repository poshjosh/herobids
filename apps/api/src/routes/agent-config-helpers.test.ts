import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveNotificationPolicy, resolveExecutionModeForSkills, resolveAuthorizationMode, validateConnectionRequirement } from './agent-config-helpers.js';

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

// 'trading', 'bot-management', 'risk-monitoring' all carry the 'trading' capability family
const TRADING_SKILL = 'trading';
const NON_TRADING_SKILL = 'base';

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
        skillIds: [NON_TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
      });
      expect(result.value).toBeNull();
    });

    it('returns an issue when a non-trading agent provides an execution mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [NON_TRADING_SKILL],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('executionMode');
    });

    it('silently ignores explicit null mode for non-trading agent', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [NON_TRADING_SKILL],
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
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: 'paper',
        executionModeProvided: true,
      });
      expect(result.value).toBe('paper');
      expect(result.issue).toBeUndefined();
    });

    it('resolves shadow mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: 'shadow',
        executionModeProvided: true,
      });
      expect(result.value).toBe('shadow');
    });

    it('resolves live mode', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: 'live',
        executionModeProvided: true,
      });
      expect(result.value).toBe('live');
    });

    it('resolves test mode to paper when no venue context exists', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: 'test',
        executionModeProvided: true,
        hasConnections: false,
        hasVenue: false,
      });
      expect(result.value).toBe('paper');
    });

    it('resolves test mode to paper when a venue is selected but no connections exist', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: 'test',
        executionModeProvided: true,
        hasConnections: false,
        hasVenue: true,
      });
      expect(result.value).toBe('paper');
    });

    it('returns an issue when an invalid mode string is submitted', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: null, // null is treated as "unset" → issue
        executionModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('executionMode');
    });
  });

  describe('trading agents — mode not provided', () => {
    it('carries forward existing mode when available', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'live',
      });
      expect(result.value).toBe('live');
      expect(result.issue).toBeUndefined();
    });

    it('defaults to paper when no existing mode is set (creation path)', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: null,
      });
      expect(result.value).toBe('paper');
      expect(result.issue).toBeUndefined();
    });

    it('defaults to paper when currentExecutionMode is omitted entirely', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
      });
      expect(result.value).toBe('paper');
    });

    it('ignores a corrupt currentExecutionMode and defaults to paper', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'invalid-mode',
      });
      expect(result.value).toBe('paper');
    });

    it('upgrades paper to shadow when connections become available', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'paper',
        hasConnections: true,
      });
      expect(result.value).toBe('shadow');
    });

    it('downgrades shadow to paper when connections are removed', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'shadow',
        hasConnections: false,
      });
      expect(result.value).toBe('paper');
    });

    it('keeps shadow when connections are still present', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
        submittedExecutionMode: undefined,
        executionModeProvided: false,
        currentExecutionMode: 'shadow',
        hasConnections: true,
      });
      expect(result.value).toBe('shadow');
    });

    it('keeps paper when no connections are present', () => {
      const result = resolveExecutionModeForSkills({
        skillIds: [TRADING_SKILL],
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
        skillIds: [NON_TRADING_SKILL],
        submittedAuthorizationMode: undefined,
        authorizationModeProvided: false,
      });
      expect(result.value).toBeNull();
      expect(result.issue).toBeUndefined();
    });

    it('returns an issue when an explicit authMode is provided for a non-trading agent', () => {
      const result = resolveAuthorizationMode({
        skillIds: [NON_TRADING_SKILL],
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
        skillIds: [TRADING_SKILL],
        submittedAuthorizationMode: 'direct',
        authorizationModeProvided: true,
      });
      expect(result.value).toBe('direct');
      expect(result.issue).toBeUndefined();
    });

    it('resolves explicit "approval_required" mode', () => {
      const result = resolveAuthorizationMode({
        skillIds: [TRADING_SKILL],
        submittedAuthorizationMode: 'approval_required',
        authorizationModeProvided: true,
      });
      expect(result.value).toBe('approval_required');
      expect(result.issue).toBeUndefined();
    });

    it('returns an issue for an invalid authMode string', () => {
      const result = resolveAuthorizationMode({
        skillIds: [TRADING_SKILL],
        submittedAuthorizationMode: 'invalid_mode',
        authorizationModeProvided: true,
      });
      expect(result.issue).toBeDefined();
      expect(result.issue?.path).toContain('authorizationMode');
      expect(result.value).toBeNull();
    });

    it('returns an issue for null authMode when explicitly provided', () => {
      const result = resolveAuthorizationMode({
        skillIds: [TRADING_SKILL],
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
        skillIds: [TRADING_SKILL],
        submittedAuthorizationMode: undefined,
        authorizationModeProvided: false,
      });
      expect(result.value).toBe('direct');
      expect(result.issue).toBeUndefined();
    });

    it('defaults to "direct" when authorizationModeProvided is false even with a value', () => {
      // The submitted value is ignored when the flag indicates it was not provided.
      const result = resolveAuthorizationMode({
        skillIds: [TRADING_SKILL],
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