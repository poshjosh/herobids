import { useEffect } from 'react';
import type { AiAvailableModelEntry, AiAvailableModelProvider } from '../../lib/api-client.js';
import { FieldLabel, inputStyle } from '../../lib/ui.js';

export interface ModelSelectionValue {
  provider: string;
  lightModel: string;
  heavyModel: string;
}

interface ModelSelectionFieldsProps {
  value: ModelSelectionValue;
  providers: AiAvailableModelProvider[];
  loading: boolean;
  loadingLabel: string;
  emptyLabel: string;
  providerLabel: string;
  providerPlaceholder: string;
  economyLabel: string;
  economyHelp: string;
  premiumLabel: string;
  premiumHelp: string;
  onChange: (value: ModelSelectionValue) => void;
}

function getProviderModels(providers: AiAvailableModelProvider[], provider: string): AiAvailableModelEntry[] {
  return providers.find((entry) => entry.provider === provider)?.models ?? [];
}

function getProviderModelIds(models: AiAvailableModelEntry[]): string[] {
  return models.map((model) => model.id);
}

function formatProviderOptionLabel(provider: AiAvailableModelProvider): string {
  return provider.provider;
}

function formatModelOptionLabel(model: AiAvailableModelEntry): string {
  const pricingLabel = model.pricing?.label;
  if (!pricingLabel) {
    return model.id;
  }

  return `${model.id} (${pricingLabel})`;
}

function pickFallbackModel(models: string[], preferredIndex: number): string {
  if (models.length === 0) {
    return '';
  }
  return models[Math.min(preferredIndex, models.length - 1)] ?? models[0] ?? '';
}

export function resolveDefaultModelSelection(
  providers: AiAvailableModelProvider[],
  operatorDefaults?: { provider: string; lightModel: string | null; heavyModel: string | null } | null,
): ModelSelectionValue | null {
  // Try operator-configured defaults first
  if (operatorDefaults?.provider) {
    const operatorProvider = providers.find((p) => p.provider === operatorDefaults.provider && p.models.length > 0);
    if (operatorProvider) {
      const modelIds = getProviderModelIds(getProviderModels(providers, operatorDefaults.provider));
      const lightModel = operatorDefaults.lightModel && modelIds.includes(operatorDefaults.lightModel)
        ? operatorDefaults.lightModel
        : '';
      const heavyModel = operatorDefaults.heavyModel && modelIds.includes(operatorDefaults.heavyModel)
        ? operatorDefaults.heavyModel
        : '';
      return normalizeModelSelection({
        provider: operatorDefaults.provider,
        lightModel,
        heavyModel,
      }, providers);
    }
  }

  // Fall back to the first provider that has models.
  // Single-provider mode: when exactly one provider is available, auto-select it.
  // Multi-provider: pick the first available (preferring isMultiProvider for backward compat).
  const multiProvider = providers.find((provider) => provider.isMultiProvider && provider.models.length > 0);
  const defaultProvider = multiProvider ?? providers.find((provider) => provider.models.length > 0);
  if (!defaultProvider) {
    return null;
  }

  return normalizeModelSelection({
    provider: defaultProvider.provider,
    lightModel: '',
    heavyModel: '',
  }, providers);
}

export function normalizeModelSelection(
  value: ModelSelectionValue,
  providers: AiAvailableModelProvider[],
): ModelSelectionValue {
  const providerModelIds = getProviderModelIds(getProviderModels(providers, value.provider));
  if (!value.provider || providerModelIds.length === 0) {
    return value;
  }

  const nextLightModel = providerModelIds.includes(value.lightModel)
    ? value.lightModel
    : pickFallbackModel(providerModelIds, 0);
  const nextHeavyModel = providerModelIds.includes(value.heavyModel)
    ? value.heavyModel
    : pickFallbackModel(providerModelIds, 1);

  if (nextLightModel === value.lightModel && nextHeavyModel === value.heavyModel) {
    return value;
  }

  return {
    provider: value.provider,
    lightModel: nextLightModel,
    heavyModel: nextHeavyModel,
  };
}

export function ModelSelectionFields({
  value,
  providers,
  loading,
  loadingLabel,
  emptyLabel,
  providerLabel,
  providerPlaceholder,
  economyLabel,
  economyHelp,
  premiumLabel,
  premiumHelp,
  onChange,
}: ModelSelectionFieldsProps) {
  const providerModels = getProviderModels(providers, value.provider);
  const normalizedValue = normalizeModelSelection(value, providers);

  // Single-provider mode: auto-select the only available provider when none is selected.
  useEffect(() => {
    if (providers.length === 1 && !value.provider && providers[0]?.models.length) {
      const autoSelected = providers[0]!;
      onChange(normalizeModelSelection({
        provider: autoSelected.provider,
        lightModel: value.lightModel,
        heavyModel: value.heavyModel,
      }, providers));
    }
  }, [providers, value.provider, value.lightModel, value.heavyModel, onChange]);

  useEffect(() => {
    if (normalizedValue === value) {
      return;
    }

    onChange(normalizedValue);
  }, [normalizedValue, onChange, value]);

  const handleProviderChange = (provider: string) => {
    onChange(normalizeModelSelection({
      provider,
      lightModel: value.lightModel,
      heavyModel: value.heavyModel,
    }, providers));
  };

  const handleModelChange = (field: 'lightModel' | 'heavyModel') => (event: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({
      provider: value.provider,
      lightModel: field === 'lightModel' ? event.target.value : value.lightModel,
      heavyModel: field === 'heavyModel' ? event.target.value : value.heavyModel,
    });
  };

  const providerOptions = providers;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {providerOptions.length > 1 ? (
        <div>
          <FieldLabel>{providerLabel}</FieldLabel>
          <select
            value={value.provider}
            onChange={(event) => handleProviderChange(event.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">{providerPlaceholder}</option>
            {providerOptions.map((provider) => (
              <option key={provider.provider} value={provider.provider}>
                {formatProviderOptionLabel(provider)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {loading ? (
        <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
          {loadingLabel}
        </div>
      ) : providerOptions.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
          {emptyLabel}
        </div>
      ) : providerModels.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
          {emptyLabel}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <FieldLabel>{economyLabel}</FieldLabel>
            <select
              value={value.lightModel}
              onChange={handleModelChange('lightModel')}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {providerModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {formatModelOptionLabel(model)}
                </option>
              ))}
            </select>
            <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {economyHelp}
            </div>
          </div>

          <div>
            <FieldLabel>{premiumLabel}</FieldLabel>
            <select
              value={value.heavyModel}
              onChange={handleModelChange('heavyModel')}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {providerModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {formatModelOptionLabel(model)}
                </option>
              ))}
            </select>
            <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {premiumHelp}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
