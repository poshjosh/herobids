export interface RunStatusInput {
  nowMs: number;
  runStartedAtMs: number;
}

/** Elapsed time as `46s`, `2m17s` or `1h5m`. Negative or non-finite input reads as `0s`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

/**
 * One factual line telling the model the current time and how long this run has lasted.
 * Data only: it states no limit and gives no instruction (Agent Mode Purity).
 * Example: `Current time is (UTC) 2026-11-14T20:31:02Z; this run has been in progress for 46s`
 */
export function formatRunStatusHint(input: RunStatusInput): string {
  const nowIso = new Date(input.nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `Current time is (UTC) ${nowIso}; this run has been in progress for ${formatElapsed(input.nowMs - input.runStartedAtMs)}`;
}
