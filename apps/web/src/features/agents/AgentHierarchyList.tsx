import { useState } from 'react';
import { useIntl } from 'react-intl';
import type { Agent } from '../../lib/api-client.js';
import { EmptyState } from '../../lib/ui.js';
import { AgentSummaryCard, type AgentHierarchyMeta } from './AgentSummaryCard.js';
import { buildAgentTree, filterAgentTree, isExpandedByDefault, type AgentTreeNode } from './agent-tree.js';

interface AgentHierarchyListProps {
  agents: Agent[];
  searchQuery: string;
}

// The toggle sits in the gutter left of the card, so top-level cards stay flush with the search box.
const TOGGLE_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: '-28px',
  top: '0',
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

// The connector line sits under the parent's toggle, and children are indented from it.
const CHILDREN_STYLE: React.CSSProperties = {
  marginLeft: '12px',
  paddingLeft: '20px',
  borderLeft: '1px solid var(--color-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

export function AgentHierarchyList({ agents, searchQuery }: AgentHierarchyListProps) {
  const intl = useIntl();
  // Explicit expand/collapse choices. Nodes without one follow isExpandedByDefault.
  const [expansionOverrides, setExpansionOverrides] = useState<Record<string, boolean>>({});

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
      // A nested child's position already shows its creator. Keep the label for search results.
      creatorLabel: isChildAgent && !isSearching ? null : node.creatorLabel,
      allowanceLabel: allowanceLabelFor(node),
      childCountLabel: hasChildren
        ? intl.formatMessage({ id: 'agents.tree.childCount' }, { count: node.childCount })
        : null,
    };

    return (
      <div key={id} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <AgentSummaryCard agent={node.agent} hierarchy={hierarchy} />
        </div>
        {expanded && (
          <div style={CHILDREN_STYLE}>
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
