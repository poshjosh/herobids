import { describe, expect, it } from 'vitest';
import type { Agent } from '../../lib/api-client.js';
import { buildAgentTree, filterAgentTree, isExpandedByDefault, type AgentTreeNode } from './agent-tree.js';

function makeAgent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    userId: 'user-1',
    prompt: '',
    skillIds: [],
    status: 'stopped',
    pauseState: null,
    toolPolicy: null,
    modelPolicy: null,
    provider: null,
    lightModel: null,
    heavyModel: null,
    costPreset: null,
    dailySpendBudgetUsd: null,
    dailyLlmTokenBudget: null,
    telegramChatId: null,
    executionMode: null,
    dailyLossLimit: null,
    maxDrawdownPct: null,
    maxBots: null,
    maxSlippageBps: null,
    maxOpenPositions: null,
    maxPositionSizePct: null,
    stopLossPct: null,
    stopLossCooldownMs: null,
    tickIntervalMs: null,
    capital: null,
    style: null,
    runtimePolicyOverrides: null,
    resolvedRuntimePolicy: null,
    openPositionEscalationToJudgePolicy: null,
    technical: null,
    strategyPreset: null,
    strategyPresetName: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    creatorType: 'user',
    creatorId: 'user-1',
    parentAgentId: null,
    depth: 0,
    childAgentLimit: 0,
    ...overrides,
  };
}

function findNode(nodes: AgentTreeNode[], id: string): AgentTreeNode | undefined {
  for (const node of nodes) {
    if (node.agent.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

describe('buildAgentTree', () => {
  it('nests child agents beneath their parent with increasing depth', () => {
    const tree = buildAgentTree([
      makeAgent({ id: 'a', name: 'Alpha', childAgentLimit: 2 }),
      makeAgent({ id: 'a1', name: 'Alpha child', parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }),
      makeAgent({ id: 'a1x', name: 'Alpha grandchild', parentAgentId: 'a1', depth: 2, creatorType: 'agent', creatorId: 'a1' }),
      makeAgent({ id: 'b', name: 'Beta' }),
    ]);

    expect(tree.map((node) => node.agent.id)).toEqual(['a', 'b']);
    expect(tree[0]?.children.map((node) => node.agent.id)).toEqual(['a1']);
    expect(findNode(tree, 'a1x')?.depth).toBe(2);
    expect(tree[0]?.childCount).toBe(1);
  });

  it('labels a child with its creator agent name', () => {
    const tree = buildAgentTree([
      makeAgent({ id: 'a', name: 'Alpha' }),
      makeAgent({ id: 'a1', name: 'Alpha child', parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }),
    ]);

    expect(findNode(tree, 'a1')?.creatorLabel).toEqual({ kind: 'agent', name: 'Alpha' });
  });

  it('labels an agent whose creator was deleted as created by a deleted agent', () => {
    const tree = buildAgentTree([
      makeAgent({ id: 'orphan', name: 'Orphan', parentAgentId: null, depth: 0, creatorType: 'agent', creatorId: 'gone' }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.creatorLabel).toEqual({ kind: 'deletedAgent' });
  });

  it('leaves user-created agents without a creator label', () => {
    const tree = buildAgentTree([makeAgent({ id: 'a', name: 'Alpha' })]);

    expect(tree[0]?.creatorLabel).toBeNull();
  });

  it('treats an agent whose parent is missing from the list as a top-level agent', () => {
    const tree = buildAgentTree([
      makeAgent({ id: 'c', name: 'Detached', parentAgentId: 'missing', depth: 1, creatorType: 'agent', creatorId: 'missing' }),
    ]);

    expect(tree.map((node) => node.agent.id)).toEqual(['c']);
    expect(tree[0]?.creatorLabel).toEqual({ kind: 'deletedAgent' });
  });
});

describe('filterAgentTree', () => {
  const tree = buildAgentTree([
    makeAgent({ id: 'a', name: 'Research desk', childAgentLimit: 3 }),
    makeAgent({ id: 'a1', name: 'Scout', parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }),
    makeAgent({ id: 'a2', name: 'Judge', parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }),
    makeAgent({ id: 'b', name: 'Trader' }),
  ]);

  it('returns the full tree when the query is blank', () => {
    expect(filterAgentTree(tree, '   ')).toBe(tree);
  });

  it('shows a matching child together with its ancestors', () => {
    const filtered = filterAgentTree(tree, 'scout');

    expect(filtered.map((node) => node.agent.id)).toEqual(['a']);
    expect(filtered[0]?.children.map((node) => node.agent.id)).toEqual(['a1']);
  });

  it('keeps the matching node\'s full subtree when the parent itself matches', () => {
    const filtered = filterAgentTree(tree, 'research');

    expect(filtered[0]?.children.map((node) => node.agent.id)).toEqual(['a1', 'a2']);
  });

  it('keeps the childCount of a node even when search hides some of its children', () => {
    const filtered = filterAgentTree(tree, 'scout');

    expect(filtered[0]?.childCount).toBe(2);
  });

  it('matches on the agent prompt as well as the name', () => {
    const withPrompt = buildAgentTree([makeAgent({ id: 'p', name: 'Plain', prompt: 'Watch BTC momentum' })]);

    expect(filterAgentTree(withPrompt, 'btc')).toHaveLength(1);
  });

  it('returns nothing when no agent matches', () => {
    expect(filterAgentTree(tree, 'nonexistent')).toEqual([]);
  });
});

describe('isExpandedByDefault', () => {
  it('expands a top-level agent with at most five children', () => {
    const children = Array.from({ length: 5 }, (_, index) =>
      makeAgent({ id: `c${index}`, name: `Child ${index}`, parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }));
    const tree = buildAgentTree([makeAgent({ id: 'a', name: 'Alpha' }), ...children]);

    expect(isExpandedByDefault(tree[0]!)).toBe(true);
  });

  it('collapses a top-level agent with more than five children', () => {
    const children = Array.from({ length: 6 }, (_, index) =>
      makeAgent({ id: `c${index}`, name: `Child ${index}`, parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }));
    const tree = buildAgentTree([makeAgent({ id: 'a', name: 'Alpha' }), ...children]);

    expect(isExpandedByDefault(tree[0]!)).toBe(false);
  });

  it('collapses nested agents by default', () => {
    const tree = buildAgentTree([
      makeAgent({ id: 'a', name: 'Alpha' }),
      makeAgent({ id: 'a1', name: 'Child', parentAgentId: 'a', depth: 1, creatorType: 'agent', creatorId: 'a' }),
      makeAgent({ id: 'a1x', name: 'Grandchild', parentAgentId: 'a1', depth: 2, creatorType: 'agent', creatorId: 'a1' }),
    ]);

    expect(isExpandedByDefault(findNode(tree, 'a1')!)).toBe(false);
  });
});
