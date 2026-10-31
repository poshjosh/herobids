/**
 * Capacity-aware startup deadlines (P6). Pure functions over persisted session facts so a
 * restarted worker derives the same deadlines as the one that started the session. The API uses
 * the same rules to report startup progress, so this module lives in the shared domain package.
 */

export const STARTUP_DEADLINE_REASONS = [
  'start_timeout',
  'queue_deadline',
  'boot_deadline',
  'observation_failure',
] as const;

export type StartupDeadlineReason = (typeof STARTUP_DEADLINE_REASONS)[number];

/** Narrows an untrusted persisted value to the bounded startup-failure enum. */
export function isStartupDeadlineReason(value: unknown): value is StartupDeadlineReason {
  return typeof value === 'string' && (STARTUP_DEADLINE_REASONS as readonly string[]).includes(value);
}

/** Result of observing the scheduler for one session during this evaluation. */
export type StartupObservationOutcome = 'not_observed' | 'observed' | 'not_found' | 'inspect_failed';

export interface StartupDeadlineFacts {
  startedAt: Date;
  runtimeRegisteredAt: Date | null;
  firstPlacedAt: Date | null;
}

export interface CapacityAwareStartTimings {
  capacityWaitTimeoutMs: number;
  placedStartTimeoutMs: number;
}

export interface StartupDeadline {
  atMs: number;
  reason: StartupDeadlineReason;
}

/**
 * Deadline for a session with the capacity-aware gate enabled and a Nomad observation available.
 *
 * - Not registered: the job was never confirmed. A confirmed absence keeps the legacy start
 *   budget; an unconfirmed state gets the absolute bound and reports degraded observation.
 * - Registered, not placed: queue deadline, measured from the session start.
 * - Placed: boot deadline from the first placement, capped by the absolute bound.
 */
export function computeCapacityStartupDeadline(
  facts: StartupDeadlineFacts,
  timings: CapacityAwareStartTimings,
  legacyStartTimeoutMs: number,
  outcome: StartupObservationOutcome,
): StartupDeadline {
  const startedMs = facts.startedAt.getTime();
  const absoluteBoundMs = startedMs + timings.capacityWaitTimeoutMs + timings.placedStartTimeoutMs;

  if (facts.firstPlacedAt) {
    return {
      atMs: Math.min(facts.firstPlacedAt.getTime() + timings.placedStartTimeoutMs, absoluteBoundMs),
      reason: 'boot_deadline',
    };
  }

  if (facts.runtimeRegisteredAt) {
    // A registered job that the scheduler no longer reports cannot start: fail now.
    if (outcome === 'not_found') {
      return { atMs: startedMs, reason: 'observation_failure' };
    }
    return { atMs: startedMs + timings.capacityWaitTimeoutMs, reason: 'queue_deadline' };
  }

  if (outcome === 'not_found') {
    return { atMs: startedMs + legacyStartTimeoutMs, reason: 'start_timeout' };
  }
  return { atMs: absoluteBoundMs, reason: 'observation_failure' };
}

export type StartupProgressPhase = 'waiting_for_capacity' | 'booting';

export interface StartupProgress {
  phase: StartupProgressPhase;
  deadline: Date;
  reason: Extract<StartupDeadlineReason, 'queue_deadline' | 'boot_deadline'>;
}

export interface StartupProgressSession {
  status: string;
  /** Required fact. `undefined` means the caller did not load it, which is unknown, not absent. */
  startedAt: Date | undefined;
  /** `null` means no heartbeat yet. `undefined` means the column was not loaded (unknown). */
  lastHeartbeatAt: Date | null | undefined;
  /** `null` means not registered. `undefined` means the column was not loaded (unknown). */
  runtimeRegisteredAt: Date | null | undefined;
  /** `null` means not placed. `undefined` means the column was not loaded (unknown). */
  firstPlacedAt: Date | null | undefined;
}

/**
 * Read-side startup subphase for a session that is still starting. Only the capacity-aware gate
 * exposes it; legacy sessions with no startup facts report none. The deadline comes from the same
 * rules the worker enforces, so a shown deadline is the one that will expire the session.
 *
 * Returns null, never a guessed phase, when the gate is off, the session is not starting or
 * launching, the phase cannot be determined, or any required fact was not loaded (undefined).
 */
export function computeStartupProgress(
  session: StartupProgressSession,
  config: { enabled: boolean } & CapacityAwareStartTimings,
): StartupProgress | null {
  if (!config.enabled) return null;
  if (session.status !== 'starting' && session.status !== 'launching') return null;
  if (
    session.startedAt === undefined
    || session.lastHeartbeatAt === undefined
    || session.runtimeRegisteredAt === undefined
    || session.firstPlacedAt === undefined
  ) {
    return null;
  }

  const facts: StartupDeadlineFacts = {
    startedAt: session.startedAt,
    runtimeRegisteredAt: session.runtimeRegisteredAt,
    firstPlacedAt: session.firstPlacedAt,
  };
  const isPlaced = facts.firstPlacedAt !== null;
  const isRegistered = facts.runtimeRegisteredAt !== null;

  let phase: StartupProgressPhase;
  if (isPlaced && session.lastHeartbeatAt === null) {
    phase = 'booting';
  } else if (!isPlaced && isRegistered) {
    phase = 'waiting_for_capacity';
  } else {
    return null;
  }

  // The legacy budget is only read for a confirmed absence, which a registered session never hits here.
  const deadline = computeCapacityStartupDeadline(facts, config, 0, 'not_observed');
  if (deadline.reason !== 'queue_deadline' && deadline.reason !== 'boot_deadline') return null;

  return { phase, deadline: new Date(deadline.atMs), reason: deadline.reason };
}
