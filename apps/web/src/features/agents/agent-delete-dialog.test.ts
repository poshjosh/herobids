import { describe, expect, it } from 'vitest';
import type { AgentDeletePreview } from '../../lib/api-client.js';
import { resolveAgentDeleteDialogState } from './agent-delete-dialog.js';

const withChildren: AgentDeletePreview = {
  availableScopes: ['subtree', 'agent'],
  defaultScope: 'subtree',
  agentCount: 3,
  botCount: 4,
  nonStoppedAgents: [],
  scopes: {
    subtree: { agentCount: 3, botCount: 4 },
    agent: { agentCount: 1, botCount: 1 },
  },
};

const withoutChildren: AgentDeletePreview = {
  availableScopes: ['agent'],
  defaultScope: 'agent',
  agentCount: 1,
  botCount: 2,
  nonStoppedAgents: [],
  scopes: { agent: { agentCount: 1, botCount: 2 } },
};

describe('resolveAgentDeleteDialogState', () => {
  it('defaults to deleting the agent and all its descendants when it has children', () => {
    const state = resolveAgentDeleteDialogState(withChildren, null);

    expect(state.scope).toBe('subtree');
    expect(state.showScopeOptions).toBe(true);
    expect(state.agentCount).toBe(3);
    expect(state.botCount).toBe(4);
  });

  it('shows the counts for the agent-only option when the user chooses it', () => {
    const state = resolveAgentDeleteDialogState(withChildren, 'agent');

    expect(state.scope).toBe('agent');
    expect(state.agentCount).toBe(1);
    expect(state.botCount).toBe(1);
  });

  it('hides the scope options and deletes only the agent when it has no children', () => {
    const state = resolveAgentDeleteDialogState(withoutChildren, null);

    expect(state.scope).toBe('agent');
    expect(state.showScopeOptions).toBe(false);
    expect(state.agentCount).toBe(1);
    expect(state.botCount).toBe(2);
  });

  it('ignores a selected scope the preview does not offer', () => {
    const state = resolveAgentDeleteDialogState(withoutChildren, 'subtree');

    expect(state.scope).toBe('agent');
  });

  it('allows confirmation when every agent in the subtree is stopped', () => {
    expect(resolveAgentDeleteDialogState(withChildren, null).canConfirm).toBe(true);
  });

  it('blocks confirmation and lists agents that are not stopped', () => {
    const preview: AgentDeletePreview = {
      ...withChildren,
      nonStoppedAgents: [{ id: 'child-1', status: 'active' }],
    };

    const state = resolveAgentDeleteDialogState(preview, 'agent');

    expect(state.canConfirm).toBe(false);
    expect(state.nonStoppedAgents).toEqual([{ id: 'child-1', status: 'active' }]);
  });

  it('blocks the agent-only option too when a descendant is not stopped', () => {
    const preview: AgentDeletePreview = {
      ...withChildren,
      nonStoppedAgents: [{ id: 'child-1', status: 'paused' }],
    };

    expect(resolveAgentDeleteDialogState(preview, 'agent').canConfirm).toBe(false);
  });
});
