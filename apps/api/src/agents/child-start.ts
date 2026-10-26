import type { Result } from '@herobids/domain';
import type { AgentLifecycleError } from '../services/agent-lifecycle-service.js';

/** How a child created by an agent fared at start. Reported beside the created child. */
export interface ChildStartOutcome {
  started: boolean;
  startError: { code: string; message: string } | null;
}

/** Internal causes stay out of the agent's view; the agent is told only that the user must act. */
const INTERNAL_START_MESSAGE = 'The child could not be started. It stays stopped; ask the user to start it.';

/**
 * Runs the same start the user uses for a child just created. A refused start does not undo the create:
 * the child stays stopped and the outcome carries the reason. `requested` false skips the start.
 */
export async function startCreatedChild<T>(
  start: () => Promise<Result<T, AgentLifecycleError>>,
  requested: boolean,
): Promise<ChildStartOutcome> {
  if (!requested) return { started: false, startError: null };

  const result = await start();
  if (result.ok) return { started: true, startError: null };

  const { code, message } = result.error;
  return {
    started: false,
    startError: { code, message: code === 'agent.internal_error' ? INTERNAL_START_MESSAGE : message },
  };
}
