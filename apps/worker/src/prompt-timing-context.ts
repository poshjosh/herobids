export interface PromptTimingContext {
  currentTimeIso: string;
  nominalTickIntervalMs: number;
  expectedNextTickIso: string | null;
}

export function createPromptTimingContext(input: {
  currentTimeMs: number;
  nominalTickIntervalMs: number;
  expectedNextTickAtMs: number | null;
}): PromptTimingContext {
  return {
    currentTimeIso: new Date(input.currentTimeMs).toISOString(),
    nominalTickIntervalMs: input.nominalTickIntervalMs,
    expectedNextTickIso: input.expectedNextTickAtMs !== null
      ? new Date(input.expectedNextTickAtMs).toISOString()
      : null,
  };
}

function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unavailable';
  }

  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }

  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }

  if (ms % 1_000 === 0) {
    return `${ms / 1_000}s`;
  }

  return `${ms}ms`;
}

export function formatPromptTimingContextLines(timing: PromptTimingContext): string[] {
  return [
    `Current time (UTC): ${timing.currentTimeIso}`,
    `Nominal tick interval: ${formatInterval(timing.nominalTickIntervalMs)}`,
    ...(timing.expectedNextTickIso
      ? [`Expected next tick (UTC, tentative): ${timing.expectedNextTickIso}`]
      : []),
  ];
}