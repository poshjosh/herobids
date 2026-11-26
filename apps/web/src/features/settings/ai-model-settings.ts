import { ReasoningLevelSchema, type ReasoningLevel } from '@herobids/domain';
import type { AiModelSettings, AiModelSettingsUpdate } from '../../lib/api-client.js';

export interface AiModelSelectionState {
  provider: string;
  lightModel: string;
  heavyModel: string;
  /** '' = no level chosen: each agent uses its style default (D22). */
  scoutReasoning: string;
  judgeReasoning: string;
  adaptScoutReasoning: boolean;
  adaptJudgeReasoning: boolean;
}

export const EMPTY_AI_MODEL_SELECTION: AiModelSelectionState = {
  provider: '',
  lightModel: '',
  heavyModel: '',
  scoutReasoning: '',
  judgeReasoning: '',
  adaptScoutReasoning: true,
  adaptJudgeReasoning: true,
};

export function normalizeAiModelSelection(settings: AiModelSettings | null | undefined): AiModelSelectionState {
  return {
    provider: settings?.provider ?? '',
    lightModel: settings?.lightModel ?? '',
    heavyModel: settings?.heavyModel ?? '',
    scoutReasoning: settings?.scoutReasoning ?? '',
    judgeReasoning: settings?.judgeReasoning ?? '',
    adaptScoutReasoning: settings?.adaptScoutReasoning ?? true,
    adaptJudgeReasoning: settings?.adaptJudgeReasoning ?? true,
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
        && (savedValue.scoutReasoning ?? '') === currentInput.scoutReasoning
        && (savedValue.judgeReasoning ?? '') === currentInput.judgeReasoning
        && savedValue.adaptScoutReasoning === currentInput.adaptScoutReasoning
        && savedValue.adaptJudgeReasoning === currentInput.adaptJudgeReasoning
      : false);
}

function toReasoningLevelOrNull(value: string): ReasoningLevel | null {
  const parsed = ReasoningLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The save payload; a reasoning level the user did not choose is sent as null so agents keep their style default. */
export function toAiModelSettingsUpdate(selection: AiModelSelectionState): AiModelSettingsUpdate {
  return {
    provider: selection.provider,
    lightModel: selection.lightModel,
    heavyModel: selection.heavyModel,
    scoutReasoning: toReasoningLevelOrNull(selection.scoutReasoning),
    judgeReasoning: toReasoningLevelOrNull(selection.judgeReasoning),
    adaptScoutReasoning: selection.adaptScoutReasoning,
    adaptJudgeReasoning: selection.adaptJudgeReasoning,
  };
}

export function createClearedAiModelSettings(): AiModelSettingsUpdate {
  return {
    provider: null,
    lightModel: null,
    heavyModel: null,
    scoutReasoning: null,
    judgeReasoning: null,
    adaptScoutReasoning: null,
    adaptJudgeReasoning: null,
  };
}