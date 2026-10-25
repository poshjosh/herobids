import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, type Agent, type AgentDeleteScope } from '../../lib/api-client.js';
import { Modal, Button, LoadingRows, ErrorBanner } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { resolveAgentDeleteDialogState } from './agent-delete-dialog.js';

interface AgentDeleteDialogProps {
  agentId: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function AgentDeleteDialog({ agentId, onClose, onDeleted }: AgentDeleteDialogProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [selectedScope, setSelectedScope] = useState<AgentDeleteScope | null>(null);

  const previewQuery = useQuery({
    queryKey: ['agents', agentId, 'delete-preview'],
    queryFn: () => agentsApi.deletePreview(agentId),
  });

  const deleteMutation = useMutation({
    mutationFn: (scope: AgentDeleteScope) => agentsApi.delete(agentId, scope),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      onDeleted();
    },
  });

  const preview = previewQuery.data;
  const state = preview ? resolveAgentDeleteDialogState(preview, selectedScope) : null;
  const cachedAgents = qc.getQueryData<Agent[]>(['agents']) ?? [];
  const nameForAgent = (id: string) => cachedAgents.find((agent) => agent.id === id)?.name ?? id;

  return (
    <Modal title={intl.formatMessage({ id: 'agents.delete.title' })} onClose={onClose} closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {previewQuery.isLoading && <LoadingRows count={2} />}
        {previewQuery.isError && (
          <ErrorBanner message={localizeApiError(intl, previewQuery.error, 'common.errorTitle')} />
        )}
        {deleteMutation.isError && (
          <ErrorBanner message={localizeApiError(intl, deleteMutation.error, 'common.errorTitle')} />
        )}

        {state && (
          <>
            {state.showScopeOptions && (
              <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(['subtree', 'agent'] as const).map((scope) => (
                  <label key={scope} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="agent-delete-scope"
                      value={scope}
                      checked={state.scope === scope}
                      onChange={() => setSelectedScope(scope)}
                      style={{ marginTop: '3px' }}
                    />
                    <span style={{ fontSize: '0.875rem', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: scope === 'subtree' ? 'agents.delete.scope.subtree' : 'agents.delete.scope.agent' })}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.delete.counts' }, { agentCount: state.agentCount, botCount: state.botCount })}
            </div>

            {state.nonStoppedAgents.length > 0 && (
              <ErrorBanner
                message={intl.formatMessage(
                  { id: 'agents.delete.blocked' },
                  {
                    agents: state.nonStoppedAgents
                      .map((agent) => `${nameForAgent(agent.id)} (${agent.status})`)
                      .join(', '),
                  },
                )}
              />
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={onClose} disabled={deleteMutation.isPending}>
                {intl.formatMessage({ id: 'common.cancel' })}
              </Button>
              <Button
                variant="danger"
                disabled={!state.canConfirm || deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(state.scope)}
              >
                {deleteMutation.isPending
                  ? intl.formatMessage({ id: 'agents.detail.deleting' })
                  : intl.formatMessage({ id: 'common.delete' })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
