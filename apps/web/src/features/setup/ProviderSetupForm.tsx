import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { setup as setupApi, type ProviderSetupResult } from '../../lib/api-client.js';
import { Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { PROVIDER_TEMPLATES } from '../credentials/CredentialsPage.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

const PROVIDER_SUGGESTIONS = ['hyperliquid', 'bybit', 'jupiter', '1inch'];

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

interface Props {
  onClose: () => void;
  onSuccess: (result: ProviderSetupResult) => void;
  defaultCapability?: 'trading';
}

export function ProviderSetupForm({ onClose, onSuccess, defaultCapability = 'trading' }: Props) {
  const intl = useIntl();
  const [provider, setProvider] = useState('');
  const [label, setLabel] = useState('');
  const [secretEntries, setSecretEntries] = useState<SecretEntry[]>([createEntry()]);

  const applyTemplate = (value: string) => {
    setProvider(value);
    const template = PROVIDER_TEMPLATES[value.trim().toLowerCase()];
    if (!canAutoApplyProviderTemplate(secretEntries)) return;
    if (template) {
      setSecretEntries(template.map((key) => ({ id: `tpl-${key}`, key, value: '' })));
    } else {
      setSecretEntries([createEntry()]);
    }
  };

  const mutation = useMutation({
    mutationFn: () =>
      setupApi.providerLink({
        provider: provider.trim(),
        label: label.trim(),
        secrets: Object.fromEntries(
          secretEntries
            .map(({ key, value }) => [key.trim(), value.trim()] as const)
            .filter(([key, value]) => key.length > 0 && value.length > 0),
        ),
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

  const hasCompleteSecret = secretEntries.some((e) => e.key.trim() && e.value.trim());

  return (
    <Modal title={intl.formatMessage({ id: 'setup.form.title' })} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'setup.form.provider' })}</FieldLabel>
          <input
            list="setup-provider-suggestions"
            value={provider}
            onChange={(e) => applyTemplate(e.target.value)}
            placeholder={intl.formatMessage({ id: 'setup.form.providerPlaceholder' })}
            style={inputStyle}
          />
          <datalist id="setup-provider-suggestions">
            {PROVIDER_SUGGESTIONS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'setup.form.label' })}</FieldLabel>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={intl.formatMessage({ id: 'setup.form.labelPlaceholder' })}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <FieldLabel>{intl.formatMessage({ id: 'setup.form.secrets' })}</FieldLabel>
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
            disabled={mutation.isPending || !provider.trim() || !label.trim() || !hasCompleteSecret}
          >
            {mutation.isPending
              ? intl.formatMessage({ id: 'setup.form.saving' })
              : intl.formatMessage({ id: 'setup.form.submit' })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
