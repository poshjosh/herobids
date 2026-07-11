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
    expect(shouldDisableAiModelSave({ provider: '', lightModel: '', heavyModel: '', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true }, null, false)).toBe(true);
    expect(shouldDisableAiModelSave({ provider: 'openai', lightModel: '', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true }, null, false)).toBe(true);
    expect(shouldDisableAiModelSave({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: '', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true }, null, false)).toBe(true);
  });

  it('is disabled while the mutation is pending', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        null,
        true,
      ),
    ).toBe(true);
  });

  it('is disabled when the selection matches the saved settings', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        false,
      ),
    ).toBe(true);
  });

  it('is enabled when the selection differs from the saved settings', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        false,
      ),
    ).toBe(false);
  });

  it('is enabled when no settings are saved yet and all selections are present', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
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
      adaptScoutReasoning: true,
      adaptJudgeReasoning: true,
    };
    expect(shouldDisableAiModelSave(selection, null, false)).toBe(false);
  });

  it('builds a cleared payload for the reset action', () => {
    expect(createClearedAiModelSettings()).toEqual({ provider: null, lightModel: null, heavyModel: null, scoutReasoning: null, judgeReasoning: null, adaptScoutReasoning: null, adaptJudgeReasoning: null });
  });

  it('enables save when adaptScoutReasoning changes', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: false, adaptJudgeReasoning: true },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        false,
      ),
    ).toBe(false);
  });

  it('enables save when adaptJudgeReasoning changes', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: false },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        false,
      ),
    ).toBe(false);
  });

  it('is disabled when adaptive flags match saved', () => {
    expect(
      shouldDisableAiModelSave(
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', scoutReasoning: 'none', judgeReasoning: 'medium', adaptScoutReasoning: true, adaptJudgeReasoning: true },
        false,
      ),
    ).toBe(true);
  });
});
