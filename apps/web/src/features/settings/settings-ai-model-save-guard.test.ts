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
import type { AiModelSelectionState } from './ai-model-settings.js';

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
    expect(shouldDisableAiModelSave({ provider: '', lightModel: '', heavyModel: '', scoutReasoning: 'none', judgeReasoning: 'medium' }, null, false)).toBe(true);
    expect(shouldDisableAiModelSave({ provider: 'openai', lightModel: '', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium' }, null, false)).toBe(true);
    expect(shouldDisableAiModelSave({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: '', scoutReasoning: 'none', judgeReasoning: 'medium' }, null, false)).toBe(true);
  });

  it('is disabled while the mutation is pending', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium' },
        null,
        true,
      ),
    ).toBe(true);
  });

  it('is disabled when the selection matches the saved settings', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium' },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium' },
        false,
      ),
    ).toBe(true);
  });

  it('is enabled when the selection differs from the saved settings', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5', scoutReasoning: 'none', judgeReasoning: 'medium' },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium' },
        false,
      ),
    ).toBe(false);
  });

  it('is enabled when no settings are saved yet and all selections are present', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium' },
        null,
        false,
      ),
    ).toBe(false);
  });

  it('is enabled for the auto-selected default when no settings are saved yet', () => {
    const defaultSelection = resolveDefaultModelSelection(availableProviders)!;
    const selection: AiModelSelectionState = {
      ...defaultSelection,
      scoutReasoning: 'none',
      judgeReasoning: 'medium',
    };
    expect(shouldDisableAiModelSave(selection, null, false)).toBe(false);
  });

  it('builds a cleared payload for the reset action', () => {
    expect(createClearedAiModelSettings()).toEqual({ provider: null, lightModel: null, heavyModel: null, scoutReasoning: null, judgeReasoning: null });
  });
});
