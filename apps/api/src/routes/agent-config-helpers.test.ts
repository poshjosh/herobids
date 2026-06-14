import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveNotificationPolicy, resolveExecutionModeForSkills } from './agent-config-helpers.js';

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
  });
});