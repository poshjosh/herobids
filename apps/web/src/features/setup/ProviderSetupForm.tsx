import { useState, useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import type { FieldDefinition } from '@herobids/domain';
import { setup as setupApi, providerCatalog as providerCatalogApi, connections as connectionsApi, type ProviderSetupResult } from '../../lib/api-client.js';
import { Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { PROVIDER_TEMPLATES } from './provider-templates.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

function providerCapabilityGroup(categories: string[]): 'trading' | 'email' | 'other' {
  if (categories.includes('trading') || categories.includes('swap')) return 'trading';
  if (categories.includes('messaging')) return 'email';
  return 'other';
}

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
  /** Passed to the API; does not filter providers. */
  defaultCapability?: 'trading' | 'email' | 'other';
  /** When set and present in the catalog, preselects this provider ahead of the capability default. */
  initialProviderId?: string;
  /** When true, render as a standalone page card instead of inside a Modal. */
  standalone?: boolean;
  /** When true, render just the form content without any wrapper (Modal or page card). For inline embedding (e.g. chat). */
  inline?: boolean;
  /** Optional relative path to return to after an OAuth-only provider finishes auth. */
  oauthReturnTo?: string;
  /** Called immediately before redirecting the browser into an OAuth-only provider flow. */
  onBeforeOAuthRedirect?: () => void;
}

export function ProviderSetupForm({ onClose, onSuccess, defaultCapability, initialProviderId, standalone, inline, oauthReturnTo, onBeforeOAuthRedirect }: Props) {
  const intl = useIntl();
  const [providerChoice, setProviderChoice] = useState('');  // '' = not yet initialised; see defaultProviderChoice below
  const [label, setLabel] = useState('');
  const [secretEntries, setSecretEntries] = useState<SecretEntry[]>([createEntry()]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [credentialMode, setCredentialMode] = useState<'manual' | 'generated'>('manual');

  const catalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
  });

  // All active providers with manual credential entry fields
  const credentialProviders = (catalogQuery.data?.providers ?? []).filter(
    (provider) => provider.status !== 'deprecated' && Boolean(provider.credentials),
  );

  // OAuth-only providers (no credential entry — user connects via OAuth redirect)
  const oauthProviders = (catalogQuery.data?.providers ?? []).filter(
    (provider) => provider.status === 'supported' && provider.connections?.allowsCredential === false,
  );

  const allProviders = [...credentialProviders, ...oauthProviders];

  const tradingProviders = allProviders.filter((p) => providerCapabilityGroup(p.categories) === 'trading');
  const emailProviders = allProviders.filter((p) => providerCapabilityGroup(p.categories) === 'email');
  const otherProviders = allProviders.filter((p) => providerCapabilityGroup(p.categories) === 'other');

  // Default provider selection:
  //  - Trading setups (Create AI Agent) default to the first trading provider once the catalog loads.
  //  - Email/other setups default to the first provider in that group.
  //  - General setups (Mission Control) default to the custom provider entry form.
  //  - An explicit initialProviderId (when present in the catalog) wins over the capability default.
  // Derived synchronously so the very first render (including server-side/static rendering,
  // before any effect can run) already reflects the default — never overrides an explicit
  // user selection once providerChoice has been set.
  const capabilityGroup =
    defaultCapability === 'trading' ? tradingProviders
    : defaultCapability === 'email' ? emailProviders
    : defaultCapability === 'other' ? otherProviders
    : [];
  // When a capability is specified but its group is empty, fall back to the
  // custom entry once the catalog has loaded (mirroring the trading branch's
  // empty-group fallback). While the catalog is still loading we leave the
  // choice empty so the effect does not commit prematurely.
  const capabilityDefault = capabilityGroup[0]?.id
    ?? (!catalogQuery.isLoading ? CUSTOM_PROVIDER_OPTION : '');
  const initialProvider = initialProviderId && allProviders.some((p) => p.id === initialProviderId)
    ? initialProviderId
    : '';
  const defaultProviderChoice = initialProvider || (defaultCapability ? capabilityDefault : CUSTOM_PROVIDER_OPTION);
  const effectiveProviderChoice = providerChoice === '' ? defaultProviderChoice : providerChoice;

  // Commit the derived default into state once known, so the <select> becomes a normal
  // controlled input for subsequent explicit user changes.
  useEffect(() => {
    if (providerChoice === '' && defaultProviderChoice !== '') {
      setProviderChoice(defaultProviderChoice);
    }
  }, [providerChoice, defaultProviderChoice]);

  const selectedProvider = allProviders.find((provider) => provider.id === effectiveProviderChoice);
  const isOAuthProvider = oauthProviders.some((p) => p.id === effectiveProviderChoice);
  const canGenerateWallet = selectedProvider?.walletGeneration?.available === true;
  const isCustomProvider = effectiveProviderChoice === CUSTOM_PROVIDER_OPTION;
  // For custom providers use the name (lowercased) as the provider ID
  const effectiveProvider = isCustomProvider ? label.toLowerCase().trim() : effectiveProviderChoice.trim();

  useEffect(() => {
    if (!canGenerateWallet && credentialMode === 'generated') {
      setCredentialMode('manual');
    }
  }, [canGenerateWallet, credentialMode]);

  // Derive the API capability from the selected provider's categories.
  // For custom providers we don't know the categories, so omit capability.
  const apiCapability: 'trading' | undefined =
    !isCustomProvider && providerCapabilityGroup(selectedProvider?.categories ?? []) === 'trading'
      ? 'trading'
      : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      setupApi.providerLink({
        provider: effectiveProvider,
        label: label.trim(),
        credentialMode,
        ...(credentialMode === 'manual' ? { secrets: isCustomProvider
          ? Object.fromEntries(
              secretEntries
                .map(({ key, value }) => [key.trim(), value.trim()] as const)
                .filter(([key, value]) => key.length > 0 && value.length > 0),
            )
          : buildStructuredSecrets(selectedProvider?.credentials?.fields ?? [], fieldValues) } : {}),
        capability: apiCapability,
      }),
    onSuccess,
  });

  const oauthMutation = useMutation({
    mutationFn: (providerId: string) => connectionsApi.beginOAuth(providerId, oauthReturnTo ? { returnTo: oauthReturnTo } : undefined),
    onSuccess: ({ authorizeUrl }) => {
      window.location.href = authorizeUrl;
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isOAuthProvider) {
      if (effectiveProvider) {
        oauthMutation.mutate(effectiveProvider);
      }
      return;
    }
    mutation.mutate();
  };

  const handleOAuthConnect = () => {
    if (effectiveProvider) {
      onBeforeOAuthRedirect?.();
      oauthMutation.mutate(effectiveProvider);
    }
  };

  const updateEntry = (index: number, field: keyof SecretEntry, value: string) => {
    setSecretEntries((entries) =>
      entries.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    );
  };

  const addEntry = () => setSecretEntries((entries) => [...entries, createEntry()]);

  const removeEntry = (index: number) =>
    setSecretEntries((entries) => entries.filter((_, i) => i !== index));

  const hasCompleteSecret = credentialMode === 'generated' || (isCustomProvider
    ? secretEntries.some((e) => e.key.trim() && e.value.trim())
    : Object.values(fieldValues).some((value) => value.trim().length > 0));

  const title = intl.formatMessage({ id: 'setup.form.title' });

  const formContent = (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: '16px' }}>
        <FieldLabel>{intl.formatMessage({ id: 'setup.form.provider' })}</FieldLabel>
        <select value={effectiveProviderChoice} onChange={(e) => setProviderChoice(e.target.value)} style={inputStyle}>
          {tradingProviders.length > 0 && (
            <optgroup label={intl.formatMessage({ id: 'setup.form.group.trading' })}>
              {tradingProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.displayName}</option>
              ))}
            </optgroup>
          )}
          {emailProviders.length > 0 && (
            <optgroup label={intl.formatMessage({ id: 'setup.form.group.email' })}>
              {emailProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.displayName}</option>
              ))}
            </optgroup>
          )}
          {otherProviders.length > 0 && (
            <optgroup label={intl.formatMessage({ id: 'setup.form.group.other' })}>
              {otherProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.displayName}</option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM_PROVIDER_OPTION}>{intl.formatMessage({ id: 'setup.form.group.custom' })}</option>
        </select>
        {catalogQuery.isLoading ? <div style={{ marginTop: '8px', fontSize: '0.75rem' }}>Loading provider catalog...</div> : null}
      </div>

      {!isOAuthProvider && (
        <>
          {canGenerateWallet && (
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Wallet</FieldLabel>
          <div style={{ display: 'inline-flex', gap: '4px', padding: '3px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCredentialMode('manual')}
              style={credentialMode === 'manual'
                ? { background: 'var(--color-surface-1)', color: 'var(--color-text-primary)', border: '1px solid var(--color-brand)' }
                : { border: '1px solid transparent' }}
            >
              Use existing wallet
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFieldValues({});
                setCredentialMode('generated');
              }}
              style={credentialMode === 'generated'
                ? { background: 'var(--color-surface-1)', color: 'var(--color-text-primary)', border: '1px solid var(--color-brand)' }
                : { border: '1px solid transparent' }}
            >
              Create wallet
            </Button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: '16px' }}>
        <FieldLabel>{intl.formatMessage({ id: 'setup.form.name' })}</FieldLabel>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={intl.formatMessage({ id: 'setup.form.namePlaceholder' })}
          style={inputStyle}
        />
      </div>

      {credentialMode === 'manual' && <div style={{ marginBottom: '12px' }}>
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
                  <div style={{ marginTop: '4px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{field.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>}
        </>
      )}

      {isOAuthProvider && (
        <div style={{ marginBottom: '16px', padding: '16px', background: 'var(--color-surface-2)', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.875rem', marginBottom: '12px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'setup.form.oauthDescription' }, { provider: selectedProvider?.displayName ?? effectiveProvider })}
          </div>
          <Button variant="primary" type="button" onClick={handleOAuthConnect} disabled={oauthMutation.isPending || !effectiveProvider}>
            {intl.formatMessage({ id: 'setup.form.oauthConnect' }, { provider: selectedProvider?.displayName ?? effectiveProvider })}
          </Button>
        </div>
      )}

      {(mutation.isError || oauthMutation.isError) && (
        <ErrorBanner
          message={localizeApiError(
            intl,
            mutation.isError ? mutation.error : oauthMutation.error,
            'common.errorTitle',
          )}
        />
      )}

      {!isOAuthProvider && (
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        {!standalone && (
          <Button variant="ghost" onClick={onClose} type="button">
            {intl.formatMessage({ id: 'common.cancel' })}
          </Button>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={mutation.isPending || !effectiveProvider || !label.trim() || !hasCompleteSecret}
        >
          {mutation.isPending
            ? intl.formatMessage({ id: 'setup.form.saving' })
            : intl.formatMessage({ id: 'setup.form.submit' })}
        </Button>
      </div>
      )}
      {isOAuthProvider && (
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        {!standalone && (
          <Button variant="ghost" onClick={onClose} type="button">
            {intl.formatMessage({ id: 'common.cancel' })}
          </Button>
        )}
      </div>
      )}
    </form>
  );

  if (inline) {
    return <>{formContent}</>;
  }

  if (standalone) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 24px' }}>
        <div style={{
          maxWidth: '480px',
          width: '100%',
          background: 'var(--color-surface-1)',
          borderRadius: '12px',
          padding: '32px',
          boxShadow: '0 2px 16px rgba(0, 0, 0, 0.08)',
        }}>
          <h1 style={{ fontSize: '1.375rem', fontWeight: '600', margin: '0 0 8px 0' }}>{intl.formatMessage({ id: 'setup.form.title' })}</h1>
          <p style={{ color: 'var(--color-text-secondary)', margin: '0 0 24px 0', fontSize: '0.875rem' }}>
            {intl.formatMessage({ id: 'setup.form.standaloneSubtitle' })}
          </p>
          {formContent}
        </div>
      </div>
    );
  }

  return (
    <Modal title={title} onClose={onClose} placement="top">
      {formContent}
    </Modal>
  );
}
