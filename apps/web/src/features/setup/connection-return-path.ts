/**
 * Where the connection-request flow lands once the user finishes or declines.
 * Returns the requesting agent's page when the callback supplied its id,
 * otherwise the agents list. An approved request adds `connected=<requestId>` so the
 * agent page can follow the agent's resumption for that request.
 */
export function connectionReturnPath(agentId: string | null, options: { connectedRequestId?: string | null } = {}): string {
  if (!agentId) return '/agents';
  const path = `/agents/${encodeURIComponent(agentId)}`;
  return options.connectedRequestId ? `${path}?connected=${encodeURIComponent(options.connectedRequestId)}` : path;
}
