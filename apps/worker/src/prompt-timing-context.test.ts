import { describe, expect, it } from 'vitest';
import {
  createPromptTimingContext,
  formatPromptTimingContextLines,
} from './prompt-timing-context.js';

describe('prompt timing context', () => {
  it('renders the next scheduled reminder line when a reminder is pending', () => {
    const timing = createPromptTimingContext({
      currentTimeMs: Date.parse('2026-10-06T09:00:00.000Z'),
      nominalTickIntervalMs: 86_400_000,
      expectedNextTickAtMs: Date.parse('2026-10-07T09:00:00.000Z'),
      nextReminderIso: '2026-10-07T09:00:00.000Z',
    });

    const lines = formatPromptTimingContextLines(timing);

    expect(lines).toContain('Next scheduled reminder (UTC): 2026-10-07T09:00:00.000Z');
  });

  it('omits the next scheduled reminder line when none is pending', () => {
    const timing = createPromptTimingContext({
      currentTimeMs: Date.parse('2026-10-06T09:00:00.000Z'),
      nominalTickIntervalMs: 86_400_000,
      expectedNextTickAtMs: Date.parse('2026-10-07T09:00:00.000Z'),
    });

    const lines = formatPromptTimingContextLines(timing);

    expect(lines.some((line) => line.startsWith('Next scheduled reminder'))).toBe(false);
  });
});
