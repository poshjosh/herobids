import { AGENT_RUNTIME_ACTIVITY_TYPES } from '@herobids/domain';

/** A working tick with no completion event for this long is treated as lost (the worker crashed or restarted). */
export const CONVERSATION_TURN_STALE_MS = 180_000;

export type ConversationTurnState =
  | 'queued'
  | 'working'
  | 'replied'
  | 'no_reply'
  | 'skipped'
  | 'failed'
  | 'stale';

export interface TurnEventRow {
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

/** Recent tick events scanned per request; a tick emits two or three events, so this covers roughly 100 ticks. */
export const CONVERSATION_TURN_EVENT_WINDOW = 300;

/** Tick event types needed to derive turn state. */
export const TURN_EVENT_TYPES = [
  AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED,
  AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED,
  AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH,
  AGENT_RUNTIME_ACTIVITY_TYPES.TICK_COMPLETED,
] as const;

/**
 * Derives where the agent is with one subject (a user message or a connection request).
 * `handledKey` is the payload field listing the subject ids a tick handled.
 * Returns null when the subject is unknown, so callers can omit it.
 */
export function deriveSubjectTurnState(input: {
  subjectId: string | null;
  handledKey: 'userMessageIds' | 'connectionRequestIds';
  events: readonly TurnEventRow[];
  now: Date;
}): ConversationTurnState | null {
  if (!input.subjectId) return null;

  const started = input.events
    .filter((event) => event.type === AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED)
    .find((event) => {
      const ids = event.payload?.[input.handledKey];
      return Array.isArray(ids) && ids.includes(input.subjectId);
    });
  if (!started) return 'queued';

  const tickId = started.payload?.['tickId'];
  const sameTick = (event: TurnEventRow) => event.payload?.['tickId'] === tickId;

  const completed = input.events.find((event) => event.type === AGENT_RUNTIME_ACTIVITY_TYPES.TICK_COMPLETED && sameTick(event));
  if (completed) {
    // A skip event alone is not a skip: billing warnings are emitted as skips but the tick still runs the LLM.
    const skipped = input.events.some((event) => event.type === AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED && sameTick(event));
    const dispatchedLlm = input.events.some((event) => event.type === AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH && sameTick(event));
    if (skipped && !dispatchedLlm) return 'skipped';

    const outcome = completed.payload?.['outcome'];
    if (outcome === 'replied') return 'replied';
    if (outcome === 'failed') return 'failed';
    return 'no_reply';
  }

  const ageMs = input.now.getTime() - started.createdAt.getTime();
  return ageMs > CONVERSATION_TURN_STALE_MS ? 'stale' : 'working';
}
