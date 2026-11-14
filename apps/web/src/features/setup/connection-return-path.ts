import { agentChatPath, CHAT_CONNECTED_PARAM } from '../agents/agent-chat-path.js';

/**
 * Where the connection-request flow lands once the user finishes or declines.
 * Returns the requesting agent's chat when the callback supplied its id,
 * otherwise the agents page. An approved request adds `connected=<requestId>` so the
 * chat can follow the agent's resumption for that request.
 */
export function connectionReturnPath(agentId: string | null, options: { connectedRequestId?: string | null } = {}): string {
  if (!agentId) return '/agents';
  const path = agentChatPath(agentId);
  return options.connectedRequestId
    ? `${path}&${CHAT_CONNECTED_PARAM}=${encodeURIComponent(options.connectedRequestId)}`
    : path;
}
