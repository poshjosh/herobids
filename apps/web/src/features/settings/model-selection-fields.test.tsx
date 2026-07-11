import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelSelectionFields, normalizeModelSelection, resolveDefaultModelSelection, type ModelSelectionValue } from './ModelSelectionFields.js';

const providers = [
  {
    provider: 'openrouter',
    isMultiProvider: true,
    models: [
      {
        id: 'gpt-4o-mini',
        pricing: {
          label: '$0.15 / $0.6',
          source: 'openrouter' as const,
        },
      },
      {
        id: 'gpt-4o',
        pricing: {
          label: '$2.5 / $10',
          source: 'openrouter' as const,
        },
      },
    ],
  },
  {
    provider: 'anthropic',
    models: [
      { id: 'claude-haiku-3-5' },
      { id: 'claude-sonnet-4-5' },
    ],
  },
];

function renderField(value: ModelSelectionValue): string {
  return renderToStaticMarkup(
    <ModelSelectionFields
      value={value}
      providers={providers}
      loading={false}
      loadingLabel="Loading available models…"
      emptyLabel="No models are available for the selected provider."
      providerLabel="Provider"
      providerPlaceholder="Select a provider"
      economyLabel="Economy model"
      economyHelp="For lighter, lower-cost reasoning."
      premiumLabel="Premium model"
      premiumHelp="For stronger, premium reasoning"
      onChange={() => undefined}
    />,
  );
}

describe('ModelSelectionFields', () => {
  it('renders the provider and tier labels', () => {
    const html = renderField({ provider: 'openrouter', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });

    expect(html).toContain('Provider');
    expect(html).toContain('Economy model');
    expect(html).toContain('Premium model');
    expect(html).toContain('openrouter');
    expect(html).toContain('gpt-4o-mini ($0.15 / $0.6)');
    expect(html).toContain('gpt-4o ($2.5 / $10)');
  });

  it('keeps an already valid selection unchanged', () => {
    const value = { provider: 'openrouter', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } satisfies ModelSelectionValue;
    expect(normalizeModelSelection(value, providers)).toEqual(value);
  });

  it('normalizes invalid models to the first available models for the selected provider', () => {
    expect(
      normalizeModelSelection(
        { provider: 'anthropic', lightModel: 'bad-light', heavyModel: 'bad-heavy' },
        providers,
      ),
    ).toEqual({ provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' });
  });

  it('falls back to the current value when no provider is selected', () => {
    const value = { provider: '', lightModel: 'any-light', heavyModel: 'any-heavy' } satisfies ModelSelectionValue;
    expect(normalizeModelSelection(value, providers)).toEqual(value);
  });

  it('resolves the first multi-provider as the default selection', () => {
    expect(resolveDefaultModelSelection(providers)).toEqual({
      provider: 'openrouter',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });
  });
});
