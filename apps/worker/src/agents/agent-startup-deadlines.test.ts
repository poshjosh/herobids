import { describe, it, expect } from 'vitest';
import { computeCapacityStartupDeadline, type StartupDeadlineFacts } from './agent-startup-deadlines.js';

const STARTED = new Date('2026-10-30T10:00:00.000Z');
const STARTED_MS = STARTED.getTime();
const TIMINGS = { capacityWaitTimeoutMs: 600_000, placedStartTimeoutMs: 120_000 };
const LEGACY_START_MS = 60_000;
const ABSOLUTE_MS = STARTED_MS + 600_000 + 120_000;

function facts(overrides: Partial<StartupDeadlineFacts> = {}): StartupDeadlineFacts {
  return { startedAt: STARTED, runtimeRegisteredAt: null, firstPlacedAt: null, ...overrides };
}

describe('computeCapacityStartupDeadline', () => {
  it('gives a registered, unplaced session the queue deadline measured from start', () => {
    const registered = new Date(STARTED_MS + 5_000);

    expect(computeCapacityStartupDeadline(
      facts({ runtimeRegisteredAt: registered }), TIMINGS, LEGACY_START_MS, 'observed',
    )).toEqual({ atMs: STARTED_MS + 600_000, reason: 'queue_deadline' });
  });

  it('does not extend the queue deadline when inspection fails', () => {
    expect(computeCapacityStartupDeadline(
      facts({ runtimeRegisteredAt: STARTED }), TIMINGS, LEGACY_START_MS, 'inspect_failed',
    )).toEqual({ atMs: STARTED_MS + 600_000, reason: 'queue_deadline' });
  });

  it('fails a registered session immediately when the scheduler no longer reports its job', () => {
    expect(computeCapacityStartupDeadline(
      facts({ runtimeRegisteredAt: STARTED }), TIMINGS, LEGACY_START_MS, 'not_found',
    )).toEqual({ atMs: STARTED_MS, reason: 'observation_failure' });
  });

  it('gives a placed session the boot deadline from its first placement', () => {
    const placed = new Date(STARTED_MS + 300_000);

    expect(computeCapacityStartupDeadline(
      facts({ runtimeRegisteredAt: STARTED, firstPlacedAt: placed }), TIMINGS, LEGACY_START_MS, 'observed',
    )).toEqual({ atMs: STARTED_MS + 420_000, reason: 'boot_deadline' });
  });

  it('caps the boot deadline at the absolute bound for a late placement', () => {
    const placed = new Date(STARTED_MS + 650_000);

    expect(computeCapacityStartupDeadline(
      facts({ runtimeRegisteredAt: STARTED, firstPlacedAt: placed }), TIMINGS, LEGACY_START_MS, 'observed',
    )).toEqual({ atMs: ABSOLUTE_MS, reason: 'boot_deadline' });
  });

  it('keeps a placed session on its boot deadline even when the scheduler later reports not_found', () => {
    const placed = new Date(STARTED_MS + 300_000);

    expect(computeCapacityStartupDeadline(
      facts({ runtimeRegisteredAt: STARTED, firstPlacedAt: placed }), TIMINGS, LEGACY_START_MS, 'not_found',
    )).toEqual({ atMs: STARTED_MS + 420_000, reason: 'boot_deadline' });
  });

  it('keeps the legacy start budget for an unregistered session the scheduler confirms is absent', () => {
    expect(computeCapacityStartupDeadline(
      facts(), TIMINGS, LEGACY_START_MS, 'not_found',
    )).toEqual({ atMs: STARTED_MS + LEGACY_START_MS, reason: 'start_timeout' });
  });

  it.each(['observed', 'inspect_failed', 'not_observed'] as const)(
    'uses the absolute bound for an unregistered session when observation is %s',
    (outcome) => {
      expect(computeCapacityStartupDeadline(
        facts(), TIMINGS, LEGACY_START_MS, outcome,
      )).toEqual({ atMs: ABSOLUTE_MS, reason: 'observation_failure' });
    },
  );
});
