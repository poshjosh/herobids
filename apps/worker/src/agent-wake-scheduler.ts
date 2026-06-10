export interface WakeRescheduleDecisionInput {
  running: boolean;
  tickInFlight: boolean;
  nextTickDueAt: number;
  now: number;
  effectiveTickIntervalMs: number;
  wakeMinIntervalMs: number;
}

export function getWakeRescheduleDelay(input: WakeRescheduleDecisionInput): number | null {
  if (!input.running || input.tickInFlight) {
    return null;
  }

  const remainingDelayMs = input.nextTickDueAt > 0
    ? Math.max(0, input.nextTickDueAt - input.now)
    : input.effectiveTickIntervalMs;
  const nextDelayMs = Math.min(remainingDelayMs, input.wakeMinIntervalMs);

  return nextDelayMs < remainingDelayMs ? nextDelayMs : null;
}

export interface NextTickDelayDecisionInput {
  requestedDelayMs: number;
  wakePending: boolean;
  tickInFlight: boolean;
  now: number;
  lastWakeTickAt: number;
  wakeMinIntervalMs: number;
}

export interface NextTickDelayDecision {
  actualDelayMs: number;
  nextTickDueAt: number;
  wakePending: boolean;
  lastWakeTickAt: number;
  wakeTriggered: boolean;
}

export function resolveNextTickDelay(input: NextTickDelayDecisionInput): NextTickDelayDecision {
  let actualDelayMs = input.requestedDelayMs;
  let nextWakePending = input.wakePending;
  let nextLastWakeTickAt = input.lastWakeTickAt;
  let wakeTriggered = false;

  if (input.wakePending && !input.tickInFlight) {
    const timeSinceLastWake = input.now - input.lastWakeTickAt;
    if (timeSinceLastWake >= input.wakeMinIntervalMs) {
      actualDelayMs = Math.min(actualDelayMs, input.wakeMinIntervalMs);
      nextLastWakeTickAt = input.now;
      wakeTriggered = true;
      nextWakePending = false;
    } else {
      // Cooldown hasn't elapsed — schedule the remaining cooldown so the wake
      // fires as soon as allowed, rather than falling back to the full interval.
      const remainingCooldownMs = input.wakeMinIntervalMs - timeSinceLastWake;
      if (remainingCooldownMs <= input.requestedDelayMs) {
        // The remaining cooldown is the binding constraint — use it.
        actualDelayMs = remainingCooldownMs;
        nextWakePending = false;
        wakeTriggered = true;
      } else {
        // The normal tick fires sooner and will process new state — consume
        // the wake to avoid a redundant extra tick after this one.
        nextWakePending = false;
      }
    }
  }

  return {
    actualDelayMs,
    nextTickDueAt: input.now + actualDelayMs,
    wakePending: nextWakePending,
    lastWakeTickAt: nextLastWakeTickAt,
    wakeTriggered,
  };
}