import type { Agent } from '../../lib/api-client.js';
import { extractAgentObjective } from './agent-display.js';

/** Top-level agents with at most this many children start expanded. */
export const AUTO_EXPAND_MAX_TOP_LEVEL_CHILDREN = 5;

export type CreatorLabel = { kind: 'agent'; name: string } | { kind: 'deletedAgent' };

export interface AgentTreeNode {
  agent: Agent;
  depth: number;
  /** Direct children in the full list, unaffected by search. */
  childCount: number;
  /** Null for agents the user created directly. */
  creatorLabel: CreatorLabel | null;
  children: AgentTreeNode[];
}

function resolveCreatorLabel(agent: Agent, agentsById: Map<string, Agent>): CreatorLabel | null {
  if (agent.creatorType !== 'agent') return null;
  // An agent-only delete keeps creatorId as history, so a missing creator reads as deleted.
  const creator = agent.creatorId ? agentsById.get(agent.creatorId) : undefined;
  return creator ? { kind: 'agent', name: creator.name } : { kind: 'deletedAgent' };
}

/** Nests agents under their parents. Agents whose parent is absent from the list are roots. */
export function buildAgentTree(agents: Agent[]): AgentTreeNode[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const childAgentsByParentId = new Map<string, Agent[]>();
  const rootAgents: Agent[] = [];

  for (const agent of agents) {
    const parentId = agent.parentAgentId;
    if (parentId && agentsById.has(parentId)) {
      childAgentsByParentId.set(parentId, [...(childAgentsByParentId.get(parentId) ?? []), agent]);
    } else {
      rootAgents.push(agent);
    }
  }

  const buildNode = (agent: Agent, depth: number): AgentTreeNode => {
    const childAgents = childAgentsByParentId.get(agent.id) ?? [];
    return {
      agent,
      depth,
      childCount: childAgents.length,
      creatorLabel: resolveCreatorLabel(agent, agentsById),
      children: childAgents.map((child) => buildNode(child, depth + 1)),
    };
  };

  return rootAgents.map((agent) => buildNode(agent, 0));
}

function matchesSearch(agent: Agent, needle: string): boolean {
  return agent.name.toLowerCase().includes(needle)
    || extractAgentObjective(agent.prompt).toLowerCase().includes(needle);
}

/**
 * Keeps nodes that match the query plus their ancestors, so a matching child is reached through
 * its parents. A matching node keeps its whole subtree.
 */
export function filterAgentTree(nodes: AgentTreeNode[], query: string): AgentTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;

  const visit = (node: AgentTreeNode): AgentTreeNode | null => {
    if (matchesSearch(node.agent, needle)) return node;
    const children = node.children.map(visit).filter((child): child is AgentTreeNode => child !== null);
    return children.length > 0 ? { ...node, children } : null;
  };

  return nodes.map(visit).filter((node): node is AgentTreeNode => node !== null);
}

/** Only top-level agents with a small number of children open by default. */
export function isExpandedByDefault(node: AgentTreeNode): boolean {
  return node.depth === 0 && node.childCount <= AUTO_EXPAND_MAX_TOP_LEVEL_CHILDREN;
}
