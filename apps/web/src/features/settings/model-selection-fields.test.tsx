import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelSelectionFields, normalizeModelSelection, type ModelSelectionValue } from './ModelSelectionFields.js';

const providers = [
  {
    provider: 'openai',
    models: ['gpt-4o-mini', 'gpt-4o'],
    pricing: {
      label: 'Usage-based',
      source: 'openrouter' as const,
    },
  },
  { provider: 'anthropic', models: ['claude-haiku-3-5', 'claude-sonnet-4-5'] },
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
      economyHelp="Used for lighter, lower-cost reasoning."
      premiumLabel="Premium model"
      premiumHelp="Used when the agent needs stronger reasoning."
      onChange={() => undefined}
    />,
  );
}

describe('ModelSelectionFields', () => {
  it('renders the provider and tier labels', () => {
    const html = renderField({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' });

    expect(html).toContain('Provider');
    expect(html).toContain('Economy model');
    expect(html).toContain('Premium model');
    expect(html).toContain('openai · Usage-based');
    expect(html).toContain('gpt-4o-mini');
    expect(html).toContain('gpt-4o');
  });

  it('keeps an already valid selection unchanged', () => {
    const value = { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' } satisfies ModelSelectionValue;
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
});
