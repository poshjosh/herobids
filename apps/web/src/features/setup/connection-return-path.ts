/**
 * Where the connection-request flow lands once the user finishes or declines.
 * Returns the requesting agent's page when the callback supplied its id,
 * otherwise the agents list.
 */
export function connectionReturnPath(agentId: string | null): string {
  return agentId ? `/agents/${encodeURIComponent(agentId)}` : '/agents';
}
