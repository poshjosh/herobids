import { describe, expect, it } from 'vitest';
import { computeStartupProgress, type StartupProgressSession } from './agent-startup-deadlines.js';

const STARTED_AT = new Date('2026-10-30T10:00:00.000Z');
const CAPACITY_WAIT_MS = 600_000;
const PLACED_START_MS = 120_000;
const ENABLED = { enabled: true, capacityWaitTimeoutMs: CAPACITY_WAIT_MS, placedStartTimeoutMs: PLACED_START_MS };

function session(overrides: Partial<StartupProgressSession>): StartupProgressSession {
  return {
    status: 'starting',
    startedAt: STARTED_AT,
    runtimeRegisteredAt: null,
    firstPlacedAt: null,
    lastHeartbeatAt: null,
    ...overrides,
  };
}

describe('computeStartupProgress', () => {
  it('returns null when the capacityAwareStart gate is disabled', () => {
    const registered = session({ runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000) });
    expect(computeStartupProgress(registered, { ...ENABLED, enabled: false })).toBeNull();
  });

  it('reports waiting_for_capacity for a registered session that is not placed', () => {
    const progress = computeStartupProgress(
      session({ runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000) }),
      ENABLED,
    );
    expect(progress).toEqual({
      phase: 'waiting_for_capacity',
      deadline: new Date(STARTED_AT.getTime() + CAPACITY_WAIT_MS),
      reason: 'queue_deadline',
    });
  });

  it('reports waiting_for_capacity while the session is launching', () => {
    const progress = computeStartupProgress(
      session({ status: 'launching', runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000) }),
      ENABLED,
    );
    expect(progress?.phase).toBe('waiting_for_capacity');
  });

  it('reports booting for a placed session with no heartbeat yet', () => {
    const firstPlacedAt = new Date(STARTED_AT.getTime() + 300_000);
    const progress = computeStartupProgress(
      session({ runtimeRegisteredAt: STARTED_AT, firstPlacedAt }),
      ENABLED,
    );
    expect(progress).toEqual({
      phase: 'booting',
      deadline: new Date(firstPlacedAt.getTime() + PLACED_START_MS),
      reason: 'boot_deadline',
    });
  });

  it('caps the boot deadline at the absolute bound', () => {
    const firstPlacedAt = new Date(STARTED_AT.getTime() + CAPACITY_WAIT_MS + PLACED_START_MS - 1_000);
    const progress = computeStartupProgress(
      session({ runtimeRegisteredAt: STARTED_AT, firstPlacedAt }),
      ENABLED,
    );
    expect(progress?.deadline).toEqual(new Date(STARTED_AT.getTime() + CAPACITY_WAIT_MS + PLACED_START_MS));
  });

  it('returns null for a placed session that has already sent a heartbeat', () => {
    const progress = computeStartupProgress(
      session({
        status: 'running',
        runtimeRegisteredAt: STARTED_AT,
        firstPlacedAt: new Date(STARTED_AT.getTime() + 1_000),
        lastHeartbeatAt: new Date(STARTED_AT.getTime() + 2_000),
      }),
      ENABLED,
    );
    expect(progress).toBeNull();
  });

  it.each(['running', 'unhealthy', 'stopped', 'crashed'])('returns null for status %s', (status) => {
    const progress = computeStartupProgress(
      session({ status, runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000) }),
      ENABLED,
    );
    expect(progress).toBeNull();
  });

  it('returns null for legacy sessions without placement facts', () => {
    expect(computeStartupProgress(session({}), ENABLED)).toBeNull();
  });

  describe('missing input is unknown, never booting (M2)', () => {
    // A placed session with no heartbeat is the booting shape. Each undefined input, on that shape
    // or the waiting shape, means the data was not loaded, so the result must be null.
    it('returns null when the placement fact is undefined, not booting', () => {
      const progress = computeStartupProgress(
        session({ firstPlacedAt: undefined, runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000), lastHeartbeatAt: null }),
        ENABLED,
      );
      expect(progress).toBeNull();
    });

    it('returns null when the heartbeat is undefined on a placed session, not booting', () => {
      const progress = computeStartupProgress(
        session({ firstPlacedAt: new Date(STARTED_AT.getTime() + 1_000), lastHeartbeatAt: undefined }),
        ENABLED,
      );
      expect(progress).toBeNull();
    });

    it('returns null when the registration fact is undefined, not waiting_for_capacity', () => {
      const progress = computeStartupProgress(session({ runtimeRegisteredAt: undefined }), ENABLED);
      expect(progress).toBeNull();
    });

    it('returns null when startedAt is undefined', () => {
      const progress = computeStartupProgress(
        session({ startedAt: undefined, firstPlacedAt: new Date(STARTED_AT.getTime() + 1_000), lastHeartbeatAt: null }),
        ENABLED,
      );
      expect(progress).toBeNull();
    });

    it('distinguishes an explicit null placement (not placed) from undefined', () => {
      const registered = new Date(STARTED_AT.getTime() + 1_000);
      expect(computeStartupProgress(session({ runtimeRegisteredAt: registered, firstPlacedAt: null }), ENABLED)?.phase)
        .toBe('waiting_for_capacity');
      expect(computeStartupProgress(session({ runtimeRegisteredAt: registered, firstPlacedAt: undefined }), ENABLED))
        .toBeNull();
    });
  });

  describe('non-starting statuses never report progress (M3)', () => {
    // Facts that would produce progress for a starting session: registered and placed, no heartbeat yet.
    const PROGRESS_SHAPED_FACTS = {
      runtimeRegisteredAt: new Date(STARTED_AT.getTime() + 1_000),
      firstPlacedAt: new Date(STARTED_AT.getTime() + 2_000),
      lastHeartbeatAt: null,
    };
    const NON_STARTING_STATUSES = ['running', 'unhealthy', 'stopped', 'crashed'] as const;

    it.each(NON_STARTING_STATUSES)('returns null for status %s even with progress-shaped facts', (status) => {
      expect(computeStartupProgress(session({ status, ...PROGRESS_SHAPED_FACTS }), ENABLED)).toBeNull();
    });

    it.each(NON_STARTING_STATUSES)('returns null for status %s when the gate is disabled too', (status) => {
      expect(computeStartupProgress(session({ status, ...PROGRESS_SHAPED_FACTS }), { ...ENABLED, enabled: false })).toBeNull();
    });

    it('still reports progress for the same facts on a starting session', () => {
      expect(computeStartupProgress(session({ status: 'starting', ...PROGRESS_SHAPED_FACTS }), ENABLED)?.phase).toBe('booting');
    });
  });
});
