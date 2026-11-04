import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_MESSAGE_TIMES,
  ONBOARDING_PAUSE_AFTER,
  ONBOARDING_REDIRECT_DELAY_MS,
  ONBOARDING_STUCK_AFTER_MS,
  applySimulatedStatus,
  isValidOnboardingAgentName,
  nextStatusPollDelay,
  readSimulatedStartDelay,
  resumedMessageOffsets,
  shouldRedirectToAgents,
  shouldShowStuckWarning,
} from './onboardingTiming.js';

describe('resumedMessageOffsets', () => {
  it('keeps messages up to the pause point on their original schedule', () => {
    const offsets = resumedMessageOffsets(30_000);
    expect(offsets[ONBOARDING_PAUSE_AFTER]).toBeUndefined();
    expect(offsets.created).toBeUndefined();
  });

  it('shifts later messages so the first lands 5 seconds after the resume point', () => {
    const offsets = resumedMessageOffsets(30_000);
    const values = Object.values(offsets).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(values[0]).toBe(35_000);
  });

  it('keeps the original gaps between later messages', () => {
    const offsets = resumedMessageOffsets(30_000);
    const gaps = Object.values(offsets).sort((a, b) => a - b);
    for (let i = 1; i < gaps.length; i++) {
      expect((gaps[i] ?? 0) - (gaps[i - 1] ?? 0)).toBe(5_000);
    }
  });
});

describe('isValidOnboardingAgentName', () => {
  it('accepts a normal name and trims surrounding whitespace', () => {
    expect(isValidOnboardingAgentName('Alex')).toBe(true);
    expect(isValidOnboardingAgentName('  Alex  ')).toBe(true);
  });

  it('rejects blank names', () => {
    expect(isValidOnboardingAgentName('')).toBe(false);
    expect(isValidOnboardingAgentName('   ')).toBe(false);
  });

  it('rejects names over 100 characters', () => {
    expect(isValidOnboardingAgentName('a'.repeat(100))).toBe(true);
    expect(isValidOnboardingAgentName('a'.repeat(101))).toBe(false);
  });

  it('rejects the reserved names all and * in any case', () => {
    expect(isValidOnboardingAgentName('all')).toBe(false);
    expect(isValidOnboardingAgentName(' ALL ')).toBe(false);
    expect(isValidOnboardingAgentName('*')).toBe(false);
  });
});

describe('nextStatusPollDelay', () => {
  it('polls first at 5 seconds from the start', () => {
    expect(nextStatusPollDelay(0, 0)).toBe(5_000);
    expect(nextStatusPollDelay(1_000, 0)).toBe(4_000);
  });

  it('never returns a negative first delay', () => {
    expect(nextStatusPollDelay(9_000, 0)).toBe(0);
  });

  it('polls every 3 seconds after the first poll', () => {
    expect(nextStatusPollDelay(5_000, 1)).toBe(3_000);
    expect(nextStatusPollDelay(20_000, 5)).toBe(3_000);
  });
});

describe('shouldRedirectToAgents', () => {
  it('redirects once the agent is active', () => {
    expect(shouldRedirectToAgents('active')).toBe(true);
  });

  it('does not redirect while the agent is starting, however long it takes', () => {
    expect(shouldRedirectToAgents('starting')).toBe(false);
    expect(shouldRedirectToAgents('stopped')).toBe(false);
    expect(shouldRedirectToAgents(null)).toBe(false);
  });
});

describe('shouldShowStuckWarning', () => {
  it('never shows once the agent is active', () => {
    expect(shouldShowStuckWarning({ status: 'active', startFailed: true, budgetExpired: true })).toBe(false);
  });

  it('shows at once when the start request fails', () => {
    expect(shouldShowStuckWarning({ status: 'stopped', startFailed: true, budgetExpired: false })).toBe(true);
  });

  it('shows at once when the agent has crashed', () => {
    expect(shouldShowStuckWarning({ status: 'crashed', startFailed: false, budgetExpired: false })).toBe(true);
  });

  it('does not show early while the agent is stopped or starting', () => {
    expect(shouldShowStuckWarning({ status: 'stopped', startFailed: false, budgetExpired: false })).toBe(false);
    expect(shouldShowStuckWarning({ status: 'starting', startFailed: false, budgetExpired: false })).toBe(false);
  });

  it('shows once the stuck budget has expired without an active agent', () => {
    expect(shouldShowStuckWarning({ status: 'starting', startFailed: false, budgetExpired: true })).toBe(true);
    expect(shouldShowStuckWarning({ status: null, startFailed: false, budgetExpired: true })).toBe(true);
  });
});

describe('onboarding timing constants', () => {
  it('waits 60 seconds before warning and 2 seconds before redirecting', () => {
    expect(ONBOARDING_STUCK_AFTER_MS).toBe(60_000);
    expect(ONBOARDING_REDIRECT_DELAY_MS).toBe(2_000);
  });
});

describe('ONBOARDING_MESSAGE_TIMES', () => {
  it('shows messages in order, all within the 60 second budget', () => {
    const times = Object.values(ONBOARDING_MESSAGE_TIMES);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(Math.max(...times)).toBeLessThan(60_000);
  });
});

// TEMP(onboarding-start-delay): tests for the test-only delay helpers. Remove with the feature.
describe('readSimulatedStartDelay', () => {
  it('reads seconds from the query string in dev builds', () => {
    expect(readSimulatedStartDelay('?onboardingStartDelay=45', true)).toBe(45_000);
    expect(readSimulatedStartDelay('?onboardingStartDelay=never', true)).toBe('never');
  });

  it('ignores the parameter outside dev builds', () => {
    expect(readSimulatedStartDelay('?onboardingStartDelay=45', false)).toBeNull();
  });

  it('ignores missing or invalid values', () => {
    expect(readSimulatedStartDelay('', true)).toBeNull();
    expect(readSimulatedStartDelay('?onboardingStartDelay=abc', true)).toBeNull();
    expect(readSimulatedStartDelay('?onboardingStartDelay=-5', true)).toBeNull();
  });
});

describe('applySimulatedStatus', () => {
  it('passes every status through when no delay is set', () => {
    expect(applySimulatedStatus('active', 1_000, null)).toBe('active');
  });

  it('holds active until the delay has passed', () => {
    expect(applySimulatedStatus('active', 9_000, 10_000)).toBe('starting');
    expect(applySimulatedStatus('active', 10_000, 10_000)).toBe('active');
  });

  it('never reports active in never mode', () => {
    expect(applySimulatedStatus('active', 999_000, 'never')).toBe('starting');
  });

  it('leaves non-active statuses unchanged', () => {
    expect(applySimulatedStatus('crashed', 1_000, 'never')).toBe('crashed');
  });
});
