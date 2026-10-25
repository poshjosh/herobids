/** Narrow view of the agent repository: just enough to resolve an agent's owner. `AgentRepository` satisfies it. */
export interface AgentOwnerLookup {
  getAgent(agentId: string): Promise<{ userId: string } | null>;
}

/**
 * May `fromAgentId` message `toAgentId`? MVP rule (DEC-40): yes when both agents
 * belong to the same user. An unknown agent on either side is `false`, not an error.
 * A failed lookup rejects, so a caller that awaits this cannot send on a lookup error.
 * Sending to yourself is allowed here; refusing it is the send path's decision.
 */
export async function canPeerSend(
  agents: AgentOwnerLookup,
  fromAgentId: string,
  toAgentId: string,
): Promise<boolean> {
  const from = await agents.getAgent(fromAgentId);
  if (!from) return false;
  if (fromAgentId === toAgentId) return true;
  const to = await agents.getAgent(toAgentId);
  return to !== null && from.userId === to.userId;
}
