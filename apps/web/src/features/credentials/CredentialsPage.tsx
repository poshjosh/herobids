import { useIntl } from 'react-intl';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { FieldDefinition, ProviderDefinition } from '@herobids/domain';
import { credentials as credentialsApi, providerCatalog as providerCatalogApi, ApiError } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';
import { formatShortDate } from '../../lib/formatting.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

const CUSTOM_PROVIDER_OPTION = '__custom__';

export const PROVIDER_TEMPLATES: Record<string, string[]> = {
  hyperliquid: ['apiKey', 'secret', 'walletAddress'],
  jupiter: ['privateKey'],
  bybit: ['apiKey', 'apiSecret'],
  '1inch': ['apiKey'],
};

interface SecretEntry {
  id: string;
  key: string;
  value: string;
}

function createSecretEntry(): SecretEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    key: '',
    value: '',
  };
}

function buildStructuredSecrets(fields: readonly FieldDefinition[], fieldValues: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    fields
      .map((field) => [field.key, (fieldValues[field.key] ?? '').trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
}

function findProviderDisplayName(providers: readonly ProviderDefinition[] | undefined, providerId: string): string {
  return providers?.find((provider) => provider.id === providerId)?.displayName ?? providerId;
}

export function CredentialsPage() {
  const intl = useIntl();
  const [showCreate, setShowCreate] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const catalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => credentialsApi.delete(id),
    onSuccess: () => {
      setDeleteError(null);
      void qc.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (error: ApiError) => {
      if (error.code === 'credential_in_use') {
        setDeleteError(intl.formatMessage({ id: 'credentials.deleteBlocked' }, {
          venueAccounts: (error.params?.blockingVenueAccountIds as string[])?.join(', ') ?? '',
          bots: (error.params?.blockingBotIds as string[])?.join(', ') ?? '',
          connections: (error.params?.blockingConnectionIds as string[])?.join(', ') ?? '',
          agentCredentials: ((error.params?.blockingAgentCredentials as Array<{ id: string; label: string | null }>) ?? [])
            .map((ac) => ac.label ?? ac.id)
            .join(', ') || 'none',
        }));
      } else {
        // Catch-all: surface any unexpected error to the user
        setDeleteError(intl.formatMessage({ id: 'credentials.deleteFailed' }));
      }
    },
  });

  const items = query.data?.credentials ?? [];

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'credentials.title' })}
        subtitle={intl.formatMessage({ id: 'credentials.subtitle' })}
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>{intl.formatMessage({ id: 'credentials.addButton' })}</Button>}
      />

      {deleteError && <ErrorBanner message={deleteError} onDismiss={() => setDeleteError(null)} />}

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'credentials.empty.title' })}
          message={intl.formatMessage({ id: 'credentials.empty.message' })}
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>{intl.formatMessage({ id: 'credentials.addButton' })}</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.map((credential) => (
            <Card key={credential.id} style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div>
                  <div style={{ fontWeight: '500', marginBottom: '2px' }}>{credential.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                    {intl.formatMessage({ id: 'credentials.providerLabel' }, { provider: findProviderDisplayName(catalogQuery.data?.providers, credential.venue) })}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'credentials.idLabel' }, { id: credential.id })}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {intl.formatMessage({ id: 'credentials.addedDate' }, { date: formatShortDate(intl, credential.createdAt) })}
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (confirm(intl.formatMessage({ id: 'credentials.deleteConfirm' }, { label: credential.label }))) {
                        deleteMutation.mutate(credential.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    {intl.formatMessage({ id: 'common.delete' })}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateCredentialModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: ['credentials'] });
            setShowCreate(false);
          }}
        />
      )}
    </PageShell>
  );
}

function CreateCredentialModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const intl = useIntl();
  const [providerChoice, setProviderChoice] = useState(CUSTOM_PROVIDER_OPTION);
  const [customProviderId, setCustomProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [secretEntries, setSecretEntries] = useState<SecretEntry[]>([createSecretEntry()]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const catalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
  });

  const selectableProviders = (catalogQuery.data?.providers ?? []).filter(
    (provider) => provider.status !== 'deprecated' && provider.credentials,
  );
  const selectedProvider = selectableProviders.find((provider) => provider.id === providerChoice);
  const isCustomProvider = providerChoice === CUSTOM_PROVIDER_OPTION;
  const effectiveProvider = isCustomProvider ? customProviderId.trim() : providerChoice.trim();

  const mutation = useMutation({
    mutationFn: () => credentialsApi.create({
      provider: effectiveProvider,
      label: label.trim(),
      secrets: isCustomProvider
        ? Object.fromEntries(
            secretEntries
              .map(({ key, value }) => [key.trim(), value.trim()] as const)
              .filter(([key, value]) => key.length > 0 && value.length > 0),
          )
        : buildStructuredSecrets(selectedProvider?.credentials?.fields ?? [], fieldValues),
    }),
    onSuccess,
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  const updateEntry = (index: number, field: keyof SecretEntry, value: string) => {
    setSecretEntries((entries) => entries.map((entry, currentIndex) => currentIndex === index ? { ...entry, [field]: value } : entry));
  };

  const addEntry = () => {
    setSecretEntries((entries) => [...entries, createSecretEntry()]);
  };

  const removeEntry = (index: number) => {
    setSecretEntries((entries) => entries.filter((_, currentIndex) => currentIndex !== index));
  };

  const hasCompleteSecret = isCustomProvider
    ? secretEntries.some((entry) => entry.key.trim() && entry.value.trim())
    : Object.values(fieldValues).some((value) => value.trim().length > 0);

  return (
    <Modal title={intl.formatMessage({ id: 'credentials.modal.title' })} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'credentials.modal.provider' })}</FieldLabel>
          <select value={providerChoice} onChange={(event) => setProviderChoice(event.target.value)} style={inputStyle}>
            <option value={CUSTOM_PROVIDER_OPTION}>Custom</option>
            {selectableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.displayName}</option>
            ))}
          </select>
          {isCustomProvider ? (
            <div style={{ marginTop: '8px' }}>
              <input
                value={customProviderId}
                onChange={(event) => setCustomProviderId(event.target.value)}
                placeholder={intl.formatMessage({ id: 'credentials.modal.providerPlaceholder' })}
                style={inputStyle}
              />
            </div>
          ) : null}
          {catalogQuery.isLoading ? <div style={{ marginTop: '8px', fontSize: '12px' }}>Loading provider catalog...</div> : null}
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'credentials.modal.label' })}</FieldLabel>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={intl.formatMessage({ id: 'credentials.modal.labelPlaceholder' })}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'credentials.modal.secrets' })}</FieldLabel>
          {isCustomProvider ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {secretEntries.map((entry, index) => (
                  <div key={entry.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr auto', gap: '8px', alignItems: 'center' }}>
                    <input
                      value={entry.key}
                      onChange={(event) => updateEntry(index, 'key', event.target.value)}
                      placeholder={intl.formatMessage({ id: 'credentials.modal.secretNamePlaceholder' })}
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      value={entry.value}
                      onChange={(event) => updateEntry(index, 'value', event.target.value)}
                      placeholder={intl.formatMessage({ id: 'credentials.modal.secretValuePlaceholder' })}
                      style={inputStyle}
                      autoComplete="new-password"
                    />
                    <Button variant="ghost" size="sm" onClick={() => removeEntry(index)} disabled={secretEntries.length === 1}>
                      {intl.formatMessage({ id: 'common.remove' })}
                    </Button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '8px' }}>
                <Button variant="secondary" size="sm" onClick={addEntry}>{intl.formatMessage({ id: 'credentials.modal.addSecret' })}</Button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {(selectedProvider?.credentials?.fields ?? []).map((field) => (
                <div key={field.key}>
                  <FieldLabel>{field.label}</FieldLabel>
                  <input
                    type={field.secret || field.inputKind === 'password' ? 'password' : 'text'}
                    value={fieldValues[field.key] ?? ''}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))}
                    placeholder={field.placeholder ?? field.key}
                    style={inputStyle}
                    autoComplete="new-password"
                  />
                  {field.description ? (
                    <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)' }}>{field.description}</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={mutation.isPending || !effectiveProvider || !label.trim() || !hasCompleteSecret}
          >
            {mutation.isPending ? intl.formatMessage({ id: 'credentials.modal.saving' }) : intl.formatMessage({ id: 'credentials.modal.save' })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}