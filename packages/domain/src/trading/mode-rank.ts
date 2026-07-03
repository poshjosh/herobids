/**
 * Shared execution-mode escalation guard.
 *
 * Used by both the agent-message-broker (manage_bot path) and direct tools
 * (adjust_bot_config) to prevent agents from creating or adjusting bots
 * to an execution mode that outranks the agent's own.
 *
 * Zero dependencies — safe to import from any package.
 */

/** Execution mode rank: higher = more real-money exposure. */
export const MODE_RANK: Record<string, number> = { paper: 0, shadow: 1, live: 2 };

/**
 * Check whether an agent is permitted to operate a bot at `requestedMode`.
 *
 * @param requestedMode - The bot execution mode the agent wants to use.
 * @param agentMode - The agent's own execution mode.
 * @param context - Whether this check is for bot creation or config adjustment.
 * @returns `{ allowed: true }` if permitted, or `{ allowed: false, error }` with
 *          a human-readable rejection message.
 */
export function checkModeEscalation(
  requestedMode: string,
  agentMode: string,
  context: 'create' | 'adjust' = 'adjust',
): { allowed: true } | { allowed: false; error: string } {
  const agentRank = MODE_RANK[agentMode] ?? 0;
  const requestedRank = MODE_RANK[requestedMode] ?? 0;
  if (requestedRank > agentRank) {
    const permitted = Object.keys(MODE_RANK)
      .filter((m) => (MODE_RANK[m] ?? 0) <= agentRank)
      .join(', ');
    const verb = context === 'create' ? 'create a bot with' : 'adjust a bot to';
    return {
      allowed: false,
      error: `Cannot ${verb} execution mode "${requestedMode}". Permitted execution modes: ${permitted}.`,
    };
  }
  return { allowed: true };
}
