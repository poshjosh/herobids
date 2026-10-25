import { useState } from 'react';
import { useIntl } from 'react-intl';
import type { Agent } from '../../lib/api-client.js';
import { EmptyState } from '../../lib/ui.js';
import { AgentSummaryCard, type AgentHierarchyMeta } from './AgentSummaryCard.js';
import { ChildAgentMessageForm } from './ChildAgentMessageForm.js';
import { buildAgentTree, filterAgentTree, isExpandedByDefault, type AgentTreeNode } from './agent-tree.js';

interface AgentHierarchyListProps {
  agents: Agent[];
  searchQuery: string;
}

const TOGGLE_STYLE: React.CSSProperties = {
  flexShrink: 0,
  width: '24px',
  height: '32px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  background: 'none',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  fontSize: '0.875rem',
  padding: 0,
};

export function AgentHierarchyList({ agents, searchQuery }: AgentHierarchyListProps) {
  const intl = useIntl();
  // Explicit expand/collapse choices. Nodes without one follow isExpandedByDefault.
  const [expansionOverrides, setExpansionOverrides] = useState<Record<string, boolean>>({});
  const [openMessageAgentId, setOpenMessageAgentId] = useState<string | null>(null);

  const isSearching = searchQuery.trim() !== '';
  const roots = filterAgentTree(buildAgentTree(agents), searchQuery);

  const allowanceLabelFor = (node: AgentTreeNode): string | null => {
    const limit = node.agent.childAgentLimit ?? 0;
    return limit > 0
      ? intl.formatMessage({ id: 'agents.tree.allowance' }, { used: node.childCount, limit })
      : null;
  };

  const renderNode = (node: AgentTreeNode) => {
    const { id } = node.agent;
    const hasChildren = node.children.length > 0;
    const isChildAgent = node.depth > 0;
    const expanded = hasChildren && (isSearching || (expansionOverrides[id] ?? isExpandedByDefault(node)));

    const hierarchy: AgentHierarchyMeta = {
      depth: isChildAgent || hasChildren ? node.depth : null,
      creatorLabel: node.creatorLabel,
      allowanceLabel: allowanceLabelFor(node),
      onMessage: isChildAgent
        ? () => setOpenMessageAgentId((current) => (current === id ? null : id))
        : undefined,
    };

    return (
      <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
          {hasChildren && (
            <button
              type="button"
              style={TOGGLE_STYLE}
              aria-expanded={expanded}
              aria-label={intl.formatMessage({ id: expanded ? 'agents.tree.collapse' : 'agents.tree.expand' }, { name: node.agent.name })}
              onClick={() => setExpansionOverrides((current) => ({ ...current, [id]: !expanded }))}
            >
              {expanded ? '▾' : '▸'}
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <AgentSummaryCard agent={node.agent} hierarchy={hierarchy} />
            {openMessageAgentId === id && <ChildAgentMessageForm agentId={id} agentName={node.agent.name} />}
          </div>
        </div>
        {expanded && (
          <div style={{ marginLeft: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {node.children.map(renderNode)}
          </div>
        )}
      </div>
    );
  };

  if (roots.length === 0) {
    return <EmptyState title={intl.formatMessage({ id: 'agents.tree.noMatchTitle' })} message={intl.formatMessage({ id: 'agents.tree.noMatchMessage' })} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {roots.map(renderNode)}
    </div>
  );
}
