import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { connections as connectionsApi, setup as setupApi } from '../../lib/api-client.js';
import { Button, Card, SectionLabel } from '../../lib/ui.js';

export interface ExistingConnectionOption {
  id: string;
  label: string;
}

export interface UseExistingConnectionViewProps {
  agentName: string;
  options: ExistingConnectionOption[];
  selectedId: string | null;
  isSubmitting: boolean;
  onSelect: (id: string) => void;
  onConfirm: () => void;
}

export function UseExistingConnectionView({ agentName, options, selectedId, isSubmitting, onSelect, onConfirm }: UseExistingConnectionViewProps) {
  const intl = useIntl();
  return (
    <Card>
      <SectionLabel>{intl.formatMessage({ id: 'setup.useExisting.title' }, { agent: agentName })}</SectionLabel>
      {options.length === 0 ? (
        <p>{intl.formatMessage({ id: 'setup.useExisting.empty' })}</p>
      ) : (
        <ul>
          {options.map((option) => (
            <li key={option.id}>
              <label>
                <input
                  type="radio"
                  name="existing-connection"
                  value={option.id}
                  checked={selectedId === option.id}
                  onChange={() => onSelect(option.id)}
                />
                {' '}
                {option.label}
              </label>
            </li>
          ))}
        </ul>
      )}
      <Button onClick={onConfirm} disabled={selectedId === null || isSubmitting}>
        {intl.formatMessage({ id: 'setup.useExisting.confirm' })}
      </Button>
    </Card>
  );
}

export function UseExistingConnectionPanel({ requestId, provider, agentName, onDone }: {
  requestId: string;
  provider: string;
  agentName: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const connectionsQuery = useQuery({
    queryKey: ['connections', 'use-existing', provider],
    queryFn: () => connectionsApi.list(),
  });
  const options: ExistingConnectionOption[] = (connectionsQuery.data?.connections ?? [])
    .filter((connection) => connection.provider === provider && connection.status === 'active')
    .map((connection) => ({ id: connection.id, label: connection.label }));
  const confirmMutation = useMutation({
    mutationFn: (connectionId: string) => setupApi.useExistingConnection(requestId, connectionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
      onDone();
    },
  });

  return (
    <UseExistingConnectionView
      agentName={agentName}
      options={options}
      selectedId={selectedId}
      isSubmitting={confirmMutation.isPending}
      onSelect={setSelectedId}
      onConfirm={() => {
        if (selectedId) confirmMutation.mutate(selectedId);
      }}
    />
  );
}
