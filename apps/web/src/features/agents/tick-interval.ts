export const MS_PER_MINUTE = 60_000;
export const MIN_TICK_INTERVAL_MINUTES = 1;

export type TickIntervalValidationReason = 'minimum' | 'wholeMinutes';

export type TickIntervalMinutesParseResult =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: TickIntervalValidationReason }
  | { kind: 'valid'; minutes: number; tickIntervalMs: number };

export function parseTickIntervalMinutesInput(value: string): TickIntervalMinutesParseResult {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return { kind: 'empty' };
  }

  const minutes = Number(trimmedValue);
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
    return { kind: 'invalid', reason: 'wholeMinutes' };
  }

  if (minutes < MIN_TICK_INTERVAL_MINUTES) {
    return { kind: 'invalid', reason: 'minimum' };
  }

  return { kind: 'valid', minutes, tickIntervalMs: minutes * MS_PER_MINUTE };
}

export function getTickIntervalValidationMessageId(value: string): string | null {
  const parsed = parseTickIntervalMinutesInput(value);
  if (parsed.kind !== 'invalid') {
    return null;
  }

  return parsed.reason === 'minimum'
    ? 'agents.controls.tickInterval.validation.minimum'
    : 'agents.controls.tickInterval.validation.wholeMinutes';
}

export function formatTickIntervalMinutesForInput(tickIntervalMs: number | null | undefined): string {
  if (tickIntervalMs == null || tickIntervalMs <= 0) {
    return '';
  }

  return String(Math.max(MIN_TICK_INTERVAL_MINUTES, Math.ceil(tickIntervalMs / MS_PER_MINUTE)));
}

export function isWholeMinuteTickInterval(tickIntervalMs: number | null | undefined): boolean {
  if (tickIntervalMs == null) {
    return true;
  }

  return tickIntervalMs % MS_PER_MINUTE === 0;
}