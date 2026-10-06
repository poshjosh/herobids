import { describe, it, expect } from 'vitest';
import { parseReminderRecord, ReminderRecordSchema } from './reminder-record.js';

function makeRaw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'rem-001',
    message: 'Send the daily summary',
    triggerAt: '2026-10-06T09:00:00.000Z',
    ...overrides,
  });
}

describe('parseReminderRecord', () => {
  it('parses a legacy one-shot record with only the original fields', () => {
    const result = parseReminderRecord(
      JSON.stringify({
        id: 'rem-legacy',
        message: 'Check BTC price',
        triggerAt: '2026-10-06T09:00:00.000Z',
        firedAt: '2026-10-06T09:00:01.000Z',
        scheduledBy: 'judge',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('rem-legacy');
      expect(result.data.repeatEveryMs).toBeUndefined();
    }
  });

  it('parses a repeating record with the new optional fields', () => {
    const result = parseReminderRecord(
      makeRaw({
        key: 'daily_report',
        repeatEveryMs: 86_400_000,
        anchorAt: '2026-10-06T09:00:00.000Z',
        createdAt: '2026-10-05T09:00:00.000Z',
        lastFiredAt: '2026-10-05T09:00:00.000Z',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.key).toBe('daily_report');
      expect(result.data.repeatEveryMs).toBe(86_400_000);
    }
  });

  it('returns reminder.malformed for invalid JSON', () => {
    const result = parseReminderRecord('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('reminder.malformed');
    }
  });

  it('returns reminder.malformed when a required field is missing', () => {
    const result = parseReminderRecord(JSON.stringify({ id: 'x', message: 'y' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('reminder.malformed');
    }
  });

  it('returns reminder.malformed when triggerAt is not an ISO datetime', () => {
    const result = parseReminderRecord(makeRaw({ triggerAt: 'not-a-date' }));
    expect(result.ok).toBe(false);
  });

  it('returns reminder.malformed when key does not match the allowed pattern', () => {
    const result = parseReminderRecord(makeRaw({ key: 'Not A Valid Key' }));
    expect(result.ok).toBe(false);
  });

  it('returns reminder.malformed when repeatEveryMs is not a positive integer', () => {
    const result = parseReminderRecord(makeRaw({ repeatEveryMs: -5 }));
    expect(result.ok).toBe(false);
  });

  it('returns reminder.malformed when repeatEveryMs is zero', () => {
    const result = parseReminderRecord(makeRaw({ repeatEveryMs: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('reminder.malformed');
    }
  });

  it('returns reminder.malformed when repeatEveryMs is a non-integer', () => {
    const result = parseReminderRecord(makeRaw({ repeatEveryMs: 1.5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('reminder.malformed');
    }
  });

  it('rejects an unparseable key via the schema regex', () => {
    expect(ReminderRecordSchema.safeParse({
      id: 'a',
      message: 'b',
      triggerAt: '2026-10-06T09:00:00.000Z',
      key: '-leading-dash',
    }).success).toBe(false);
  });
});
