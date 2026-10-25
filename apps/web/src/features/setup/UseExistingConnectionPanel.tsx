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
  options: ExistingConnectionOption[];
  selectedId: string | null;
  isSubmitting: boolean;
  onSelect: (id: string) => void;
  onConfirm: () => void;
}

/** A single existing connection is the only possible choice, so it is pre-selected. */
export function resolveSelectedId(options: ExistingConnectionOption[], selectedId: string | null): string | null {
  if (selectedId !== null) return selectedId;
  const [only] = options;
  return options.length === 1 && only ? only.id : null;
}

export function UseExistingConnectionView({ options, selectedId, isSubmitting, onSelect, onConfirm }: UseExistingConnectionViewProps) {
  const intl = useIntl();
  return (
    <Card>
      <SectionLabel>{intl.formatMessage({ id: 'setup.useExisting.title' })}</SectionLabel>
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
      <Button type="button" variant="primary" onClick={onConfirm} disabled={selectedId === null || isSubmitting}>
        {intl.formatMessage({ id: 'setup.useExisting.confirm' })}
      </Button>
    </Card>
  );
}

export function UseExistingConnectionPanel({ requestId, provider, onDone }: {
  requestId: string;
  provider: string;
  onDone: () => void;
}) {
  const intl = useIntl();
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

  if (options.length === 0) return null;

  const effectiveSelectedId = resolveSelectedId(options, selectedId);

  return (
    <>
      <UseExistingConnectionView
        options={options}
        selectedId={effectiveSelectedId}
        isSubmitting={confirmMutation.isPending}
        onSelect={setSelectedId}
        onConfirm={() => {
          if (effectiveSelectedId) confirmMutation.mutate(effectiveSelectedId);
        }}
      />
      <div role="separator" style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '16px 0', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
        <span style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
        {intl.formatMessage({ id: 'setup.form.orNewConnection' })}
        <span style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
      </div>
    </>
  );
}
