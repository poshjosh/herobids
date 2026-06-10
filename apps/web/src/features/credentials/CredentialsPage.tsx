import { useIntl } from 'react-intl';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { credentials as credentialsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';
import { formatShortDate } from '../../lib/formatting.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

const PROVIDER_SUGGESTIONS = ['hyperliquid', 'bybit', 'jupiter', '1inch', 'telegram', 'zapier', 'custom'];

/** Well-known secret key names per provider — used to pre-populate key fields when a template matches. */
export const PROVIDER_TEMPLATES: Record<string, string[]> = {
  hyperliquid: ['apiKey', 'secret', 'walletAddress'],
  jupiter: ['privateKey'],
  bybit: ['apiKey', 'apiSecret'],
  '1inch': ['privateKey', 'apiKey'],
  telegram: ['botToken'],
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

export function CredentialsPage() {
  const intl = useIntl();
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => credentialsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });

  const items = query.data?.credentials ?? [];

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'credentials.title' })}
        subtitle={intl.formatMessage({ id: 'credentials.subtitle' })}
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>{intl.formatMessage({ id: 'credentials.addButton' })}</Button>}
      />

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
              {(() => {
                const provider = credential.venue;

                return (
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div>
                  <div style={{ fontWeight: '500', marginBottom: '2px' }}>{credential.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                    {intl.formatMessage({ id: 'credentials.providerLabel' }, { provider })}
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
                );
              })()}
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
  const [provider, setProvider] = useState('');
  const [label, setLabel] = useState('');
  const [secretEntries, setSecretEntries] = useState<SecretEntry[]>([createSecretEntry()]);

  const applyProviderTemplate = (value: string) => {
    setProvider(value);
    const template = PROVIDER_TEMPLATES[value.trim().toLowerCase()];
    // Only auto-populate/reset when no values have been entered yet — preserve user input.
    const hasValues = secretEntries.some((e) => e.value.trim() !== '');
    if (hasValues) return;
    if (template) {
      setSecretEntries(template.map((key) => ({ id: `tpl-${key}`, key, value: '' })));
    } else {
      // Unknown provider: reset to a single blank row (clear stale template keys).
      setSecretEntries([createSecretEntry()]);
    }
  };

  const mutation = useMutation({
    mutationFn: () => credentialsApi.create({
      provider: provider.trim(),
      label: label.trim(),
      secrets: Object.fromEntries(
        secretEntries
          .map(({ key, value }) => [key.trim(), value.trim()] as const)
          .filter(([key, value]) => key.length > 0 && value.length > 0),
      ),
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

  const hasCompleteSecret = secretEntries.some((entry) => entry.key.trim() && entry.value.trim());

  return (
    <Modal title={intl.formatMessage({ id: 'credentials.modal.title' })} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'credentials.modal.provider' })}</FieldLabel>
          <input
            list="provider-suggestions"
            value={provider}
            onChange={(event) => applyProviderTemplate(event.target.value)}
            placeholder={intl.formatMessage({ id: 'credentials.modal.providerPlaceholder' })}
            style={inputStyle}
          />
          <datalist id="provider-suggestions">
            {PROVIDER_SUGGESTIONS.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
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
        </div>

        {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={mutation.isPending || !provider.trim() || !label.trim() || !hasCompleteSecret}
          >
            {mutation.isPending ? intl.formatMessage({ id: 'credentials.modal.saving' }) : intl.formatMessage({ id: 'credentials.modal.save' })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}