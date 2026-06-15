import { useState, useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import type { FieldDefinition } from '@herobids/domain';
import { setup as setupApi, providerCatalog as providerCatalogApi, type ProviderSetupResult } from '../../lib/api-client.js';
import { Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { PROVIDER_TEMPLATES } from '../credentials/CredentialsPage.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

const CUSTOM_PROVIDER_OPTION = '__custom__';

interface SecretEntry {
  id: string;
  key: string;
  value: string;
}

export function canAutoApplyProviderTemplate(
  entries: ReadonlyArray<Pick<SecretEntry, 'key' | 'value'>>,
  providerTemplates: Record<string, string[]> = PROVIDER_TEMPLATES,
): boolean {
  if (entries.length === 0) {
    return true;
  }

  const allBlank = entries.every((entry) => entry.key.trim() === '' && entry.value.trim() === '');
  if (allBlank) {
    return true;
  }

  const allValuesBlank = entries.every((entry) => entry.value.trim() === '');
  if (!allValuesBlank) {
    return false;
  }

  const keys = entries.map((entry) => entry.key.trim());
  if (keys.some((key) => key.length === 0)) {
    return false;
  }

  return Object.values(providerTemplates).some(
    (template) => template.length === keys.length && template.every((key, index) => key === keys[index]),
  );
}

function createEntry(): SecretEntry {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, key: '', value: '' };
}

function buildStructuredSecrets(fields: readonly FieldDefinition[], fieldValues: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    fields
      .map((field) => [field.key, (fieldValues[field.key] ?? '').trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
}

interface Props {
  onClose: () => void;
  onSuccess: (result: ProviderSetupResult) => void;
  defaultCapability?: 'trading';
}

export function ProviderSetupForm({ onClose, onSuccess, defaultCapability }: Props) {
  const intl = useIntl();
  const [providerChoice, setProviderChoice] = useState(defaultCapability === 'trading' ? '' : CUSTOM_PROVIDER_OPTION);
  const [customProviderId, setCustomProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [secretEntries, setSecretEntries] = useState<SecretEntry[]>([createEntry()]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const isTradingSetup = defaultCapability === 'trading';

  const catalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
  });

  const providerSuggestions = (catalogQuery.data?.providers ?? []).filter((provider) => {
    if (provider.status === 'deprecated' || !provider.credentials) {
      return false;
    }

    if (!isTradingSetup) {
      return true;
    }

    return provider.connections?.autoCreatesTradingBinding === true;
  });
  // Auto-select the first trading provider once the catalog loads
  useEffect(() => {
    if (isTradingSetup && providerChoice === '' && providerSuggestions.length > 0) {
      setProviderChoice(providerSuggestions[0].id);
    }
  }, [isTradingSetup, providerChoice, providerSuggestions]);

  const selectedProvider = providerSuggestions.find((provider) => provider.id === providerChoice);
  const isCustomProvider = providerChoice === CUSTOM_PROVIDER_OPTION;
  const effectiveProvider = isCustomProvider ? customProviderId.trim() : providerChoice.trim();

  const mutation = useMutation({
    mutationFn: () =>
      setupApi.providerLink({
        provider: effectiveProvider,
        label: label.trim(),
        secrets: isCustomProvider
          ? Object.fromEntries(
              secretEntries
                .map(({ key, value }) => [key.trim(), value.trim()] as const)
                .filter(([key, value]) => key.length > 0 && value.length > 0),
            )
          : buildStructuredSecrets(selectedProvider?.credentials?.fields ?? [], fieldValues),
        capability: defaultCapability,
      }),
    onSuccess,
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  const updateEntry = (index: number, field: keyof SecretEntry, value: string) => {
    setSecretEntries((entries) =>
      entries.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    );
  };

  const addEntry = () => setSecretEntries((entries) => [...entries, createEntry()]);

  const removeEntry = (index: number) =>
    setSecretEntries((entries) => entries.filter((_, i) => i !== index));

  const hasCompleteSecret = isCustomProvider
    ? secretEntries.some((e) => e.key.trim() && e.value.trim())
    : Object.values(fieldValues).some((value) => value.trim().length > 0);

  return (
    <Modal title={intl.formatMessage({ id: isTradingSetup ? 'setup.form.tradingTitle' : 'setup.form.title' })} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'setup.form.provider' })}</FieldLabel>
          <select value={providerChoice} onChange={(e) => setProviderChoice(e.target.value)} style={inputStyle}>
            {!isTradingSetup ? <option value={CUSTOM_PROVIDER_OPTION}>Custom</option> : null}
            {providerSuggestions.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.displayName}</option>
            ))}
          </select>
          {isCustomProvider ? (
            <div style={{ marginTop: '8px' }}>
              <input
                value={customProviderId}
                onChange={(e) => setCustomProviderId(e.target.value)}
                placeholder={intl.formatMessage({ id: isTradingSetup ? 'setup.form.tradingProviderPlaceholder' : 'setup.form.providerPlaceholder' })}
                style={inputStyle}
              />
            </div>
          ) : null}
          {catalogQuery.isLoading ? <div style={{ marginTop: '8px', fontSize: '12px' }}>Loading provider catalog...</div> : null}
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'setup.form.label' })}</FieldLabel>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={intl.formatMessage({ id: isTradingSetup ? 'setup.form.tradingLabelPlaceholder' : 'setup.form.labelPlaceholder' })}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'setup.form.secrets' })}</FieldLabel>
          {isCustomProvider ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {secretEntries.map((entry, index) => (
                  <div
                    key={entry.id}
                    style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr auto', gap: '8px', alignItems: 'center' }}
                  >
                    <input
                      value={entry.key}
                      onChange={(e) => updateEntry(index, 'key', e.target.value)}
                      placeholder={intl.formatMessage({ id: 'setup.form.secretNamePlaceholder' })}
                      style={inputStyle}
                    />
                    <input
                      type="password"
                      value={entry.value}
                      onChange={(e) => updateEntry(index, 'value', e.target.value)}
                      placeholder={intl.formatMessage({ id: 'setup.form.secretValuePlaceholder' })}
                      style={inputStyle}
                      autoComplete="new-password"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeEntry(index)}
                      disabled={secretEntries.length === 1}
                    >
                      {intl.formatMessage({ id: 'common.remove' })}
                    </Button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '8px' }}>
                <Button variant="secondary" size="sm" onClick={addEntry}>
                  {intl.formatMessage({ id: 'setup.form.addSecret' })}
                </Button>
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
                    onChange={(e) => setFieldValues((current) => ({ ...current, [field.key]: e.target.value }))}
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

        {mutation.isError && (
          <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">
            {intl.formatMessage({ id: 'common.cancel' })}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={mutation.isPending || !effectiveProvider || !label.trim() || !hasCompleteSecret}
          >
            {mutation.isPending
              ? intl.formatMessage({ id: 'setup.form.saving' })
              : intl.formatMessage({ id: isTradingSetup ? 'setup.form.tradingSubmit' : 'setup.form.submit' })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
