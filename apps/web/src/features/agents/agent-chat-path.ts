/** Query parameter that tells the agents page which agent's chat to open. */
export const CHAT_AGENT_PARAM = 'agent';

/** Query parameter with an approved connection request, so the chat can follow the agent's resumption. */
export const CHAT_CONNECTED_PARAM = 'connected';

/** The agents page with this agent's chat selected. Every "open this agent" action links here. */
export function agentChatPath(agentId: string): string {
  return `/agents?${CHAT_AGENT_PARAM}=${encodeURIComponent(agentId)}`;
}
