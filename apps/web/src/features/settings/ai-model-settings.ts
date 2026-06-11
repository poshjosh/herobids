import type { AiModelSettings, AiModelSettingsUpdate } from '../../lib/api-client.js';

export interface AiModelSelectionState {
  provider: string;
  lightModel: string;
  heavyModel: string;
}

export const EMPTY_AI_MODEL_SELECTION: AiModelSelectionState = {
  provider: '',
  lightModel: '',
  heavyModel: '',
};

export function normalizeAiModelSelection(settings: AiModelSettings | null | undefined): AiModelSelectionState {
  return {
    provider: settings?.provider ?? '',
    lightModel: settings?.lightModel ?? '',
    heavyModel: settings?.heavyModel ?? '',
  };
}

export function shouldDisableAiModelSave(
  currentInput: AiModelSelectionState,
  savedValue: AiModelSettings | null,
  isPending: boolean,
): boolean {
  return isPending
    || !currentInput.provider
    || !currentInput.lightModel
    || !currentInput.heavyModel
    || (savedValue
      ? savedValue.provider === currentInput.provider
        && savedValue.lightModel === currentInput.lightModel
        && savedValue.heavyModel === currentInput.heavyModel
      : false);
}

export function createClearedAiModelSettings(): AiModelSettingsUpdate {
  return {
    provider: null,
    lightModel: null,
    heavyModel: null,
  };
}