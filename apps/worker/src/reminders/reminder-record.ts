import { z } from 'zod';
import { type Result, ok, err } from '@herobids/domain';

/**
 * Reminder records are stored as JSON values in the Redis hash
 * `agent:reminders:{agentId}` (one field per reminder, keyed by reminder id).
 *
 * Every field beyond the original one-shot shape is optional so that records
 * written by earlier versions still parse unchanged.
 */

/** Allowed shape for a reminder `key`: a stable, agent-chosen identifier. */
export const REMINDER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ReminderRecordSchema = z.object({
  id: z.string().min(1),
  message: z.string().min(1),
  /** ISO 8601 datetime of the next due slot. */
  triggerAt: z.string().datetime(),
  scheduledBy: z.enum(['scout', 'judge']).optional(),
  createdAt: z.string().datetime().optional(),
  key: z.string().regex(REMINDER_KEY_PATTERN).optional(),
  /** Repeat interval in milliseconds; absent for one-shot reminders. */
  repeatEveryMs: z.number().int().positive().optional(),
  /** ISO 8601 datetime of the first slot (the original anchor of the grid). */
  anchorAt: z.string().datetime().optional(),
  lastFiredAt: z.string().datetime().optional(),
  /** Legacy one-shot "already fired" marker. */
  firedAt: z.string().datetime().optional(),
});

export type ReminderRecord = z.infer<typeof ReminderRecordSchema>;

/** Error returned when a stored reminder value cannot be parsed/validated. */
export interface ReminderMalformedError {
  code: 'reminder.malformed';
}

/**
 * Parse a raw JSON string from Redis into a validated {@link ReminderRecord}.
 * Returns `reminder.malformed` for invalid JSON or records that fail schema
 * validation; callers warn-and-skip rather than crash.
 */
export function parseReminderRecord(
  raw: string,
): Result<ReminderRecord, ReminderMalformedError> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err({ code: 'reminder.malformed' });
  }

  const parsed = ReminderRecordSchema.safeParse(json);
  if (!parsed.success) {
    return err({ code: 'reminder.malformed' });
  }

  return ok(parsed.data);
}
