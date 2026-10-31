/**
 * Capacity-aware startup deadlines (P6). Pure functions over persisted session facts so a
 * restarted worker derives the same deadlines as the one that started the session.
 */

export type StartupDeadlineReason =
  | 'start_timeout'
  | 'queue_deadline'
  | 'boot_deadline'
  | 'observation_failure';

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
