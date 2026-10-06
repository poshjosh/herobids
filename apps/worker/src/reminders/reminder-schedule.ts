/**
 * Pure schedule math for repeating reminders.
 *
 * When the coordinator fires a due repeating reminder, it advances the reminder
 * to its next slot on the original grid (anchored at the first occurrence).
 * Occurrences that are already past are reported as `missedOccurrences` but are
 * not fired separately — a single wake catches up for all of them.
 */

export interface AdvanceRepeatingReminderInput {
  /** The due slot's timestamp in ms. Precondition: `triggerAtMs <= nowMs`. */
  triggerAtMs: number;
  /** Repeat interval in ms; must be positive. */
  repeatEveryMs: number;
  /** Current time in ms. */
  nowMs: number;
}

export interface AdvanceRepeatingReminderResult {
  /** Next slot on the original grid; always strictly greater than `nowMs`. */
  nextTriggerAtMs: number;
  /**
   * Number of grid slots after the due one that are also already past,
   * `floor((nowMs - triggerAtMs) / repeatEveryMs)`, clamped to a floor of 0.
   * An on-time fire (`nowMs === triggerAtMs`) yields 0. Times before the due
   * slot violate the documented precondition and are also clamped to 0.
   */
  missedOccurrences: number;
}

export function advanceRepeatingReminder(
  input: AdvanceRepeatingReminderInput,
): AdvanceRepeatingReminderResult {
  const { triggerAtMs, repeatEveryMs, nowMs } = input;

  // Clamp to 0 so an early/zero/negative elapsed time (precondition violation)
  // cannot produce negative misses or a `nextTriggerAtMs <= nowMs`.
  const missedOccurrences = Math.max(
    0,
    Math.floor((nowMs - triggerAtMs) / repeatEveryMs),
  );
  const nextTriggerAtMs = triggerAtMs + (missedOccurrences + 1) * repeatEveryMs;

  return { nextTriggerAtMs, missedOccurrences };
}
