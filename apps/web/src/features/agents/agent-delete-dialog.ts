import type { AgentDeletePreview, AgentDeleteScope } from '../../lib/api-client.js';

export interface AgentDeleteDialogState {
  scope: AgentDeleteScope;
  /** The subtree and agent-only options are offered only when the agent has children. */
  showScopeOptions: boolean;
  agentCount: number;
  botCount: number;
  /** Subtree agents that are not stopped. Deletion stays blocked until this is empty. */
  nonStoppedAgents: AgentDeletePreview['nonStoppedAgents'];
  canConfirm: boolean;
}

/** Derives what the dialog shows for the chosen scope. Falls back to the preview's default scope. */
export function resolveAgentDeleteDialogState(
  preview: AgentDeletePreview,
  selectedScope: AgentDeleteScope | null,
): AgentDeleteDialogState {
  const scope = selectedScope && preview.availableScopes.includes(selectedScope)
    ? selectedScope
    : preview.defaultScope;
  const counts = preview.scopes[scope] ?? { agentCount: preview.agentCount, botCount: preview.botCount };
  return {
    scope,
    showScopeOptions: preview.availableScopes.length > 1,
    agentCount: counts.agentCount,
    botCount: counts.botCount,
    nonStoppedAgents: preview.nonStoppedAgents,
    canConfirm: preview.nonStoppedAgents.length === 0,
  };
}
