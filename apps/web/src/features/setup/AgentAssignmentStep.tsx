import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { Button, LoadingRows, ErrorState } from '../../lib/ui.js';
import { Modal } from '../../lib/ui.js';

interface Props {
  connectionId: string;
  connectionLabel: string;
  connectionProvider: string;
  onDone: () => void;
}

export function AgentAssignmentStep({ connectionId, connectionLabel, connectionProvider, onDone }: Props) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAssigning, setIsAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const agents = agentsQuery.data ?? [];

  const toggleAgent = (agentId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const handleAssign = async () => {
    if (selectedIds.size === 0) {
      onDone();
      return;
    }
    setIsAssigning(true);
    setError(null);
    try {
      await Promise.all(
        [...selectedIds].map(async (agentId) => {
          // Fetch the agent's current connections to avoid clobbering them.
          // No catch — if we can't read current state we must not write partial state.
          const current = await agentsApi.tradingConnections(agentId);
          const currentIds = (current.connections ?? [])
            .filter((c) => c.grantStatus === 'active')
            .map((c) => c.connectionId);
          const newIds = currentIds.includes(connectionId)
            ? currentIds
            : [...currentIds, connectionId];
          return agentsApi.update(agentId, { connectionIds: newIds });
        }),
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agents'] }),
        qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] }),
      ]);
      onDone();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to assign connection');
      setIsAssigning(false);
    }
  };

  return (
    <Modal
      title={intl.formatMessage(
        { id: 'setup.agentAssignment.connectionCreated' },
        { label: connectionLabel, provider: connectionProvider },
      )}
      onClose={onDone}
    >
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
          {intl.formatMessage({ id: 'setup.agentAssignment.title' })}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {intl.formatMessage({ id: 'setup.agentAssignment.subtitle' })}
        </div>
      </div>

      {error && (
        <div style={{ padding: '8px 12px', background: 'var(--color-surface-error, rgba(239,68,68,0.08))', borderRadius: '6px', fontSize: '13px', color: 'var(--color-text-error, #ef4444)', marginBottom: '12px' }}>
          {error}
        </div>
      )}

      {agentsQuery.isLoading ? (
        <LoadingRows count={3} />
      ) : agentsQuery.isError ? (
        <ErrorState message={(agentsQuery.error as Error).message} onRetry={() => void agentsQuery.refetch()} />
      ) : agents.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5', padding: '8px 0' }}>
          {intl.formatMessage({ id: 'setup.agentAssignment.noAgents' })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
          {agents.map((agent) => (
            <label
              key={agent.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1px solid ${selectedIds.has(agent.id) ? 'var(--color-brand)' : 'var(--color-border)'}`,
                background: selectedIds.has(agent.id) ? 'var(--color-surface-brand-subtle, rgba(99,102,241,0.06))' : 'var(--color-surface-1)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(agent.id)}
                onChange={() => toggleAgent(agent.id)}
                style={{ accentColor: 'var(--color-brand)', width: '16px', height: '16px' }}
              />
              <div>
                <div style={{ fontSize: '13px', fontWeight: '600' }}>{agent.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
                  {agent.status} {agent.executionMode ? `· ${agent.executionMode}` : ''}
                </div>
              </div>
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onDone} disabled={isAssigning}>
          {intl.formatMessage({ id: 'setup.agentAssignment.skip' })}
        </Button>
        {agents.length > 0 && (
          <Button
            variant="primary"
            onClick={() => void handleAssign()}
            disabled={isAssigning || selectedIds.size === 0}
          >
            {isAssigning ? '…' : intl.formatMessage({ id: 'setup.agentAssignment.assign' })}
          </Button>
        )}
      </div>
    </Modal>
  );
}
