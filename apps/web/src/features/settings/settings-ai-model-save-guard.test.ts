/**
 * Regression tests for the AI model save button disable predicate in SettingsPage.
 *
 * The button should be disabled when:
 *   - a save is already pending
 *   - provider/lightModel/heavyModel are not all selected
 *   - the selection matches the currently saved settings
 */
import { describe, expect, it } from 'vitest';
import { createClearedAiModelSettings, shouldDisableAiModelSave } from './ai-model-settings.js';
import { resolveDefaultModelSelection } from './ModelSelectionFields.js';

describe('Settings page — AI model Save button disable predicate', () => {
  const availableProviders = [
    {
      provider: 'openrouter',
      isMultiProvider: true,
      models: [
        { id: 'gpt-4o-mini' },
        { id: 'gpt-4o' },
      ],
    },
  ];

  it('is disabled when provider or either model is empty', () => {
    expect(shouldDisableAiModelSave({ provider: '', lightModel: '', heavyModel: '' }, null, false)).toBe(true);
    expect(shouldDisableAiModelSave({ provider: 'openai', lightModel: '', heavyModel: 'gpt-4o' }, null, false)).toBe(true);
    expect(shouldDisableAiModelSave({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: '' }, null, false)).toBe(true);
  });

  it('is disabled while the mutation is pending', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        null,
        true,
      ),
    ).toBe(true);
  });

  it('is disabled when the selection matches the saved settings', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        false,
      ),
    ).toBe(true);
  });

  it('is enabled when the selection differs from the saved settings', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        false,
      ),
    ).toBe(false);
  });

  it('is enabled when no settings are saved yet and all selections are present', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        null,
        false,
      ),
    ).toBe(false);
  });

  it('is enabled for the auto-selected default when no settings are saved yet', () => {
    expect(shouldDisableAiModelSave(resolveDefaultModelSelection(availableProviders)!, null, false)).toBe(false);
  });

  it('builds a cleared payload for the reset action', () => {
    expect(createClearedAiModelSettings()).toEqual({ provider: null, lightModel: null, heavyModel: null });
  });
});
