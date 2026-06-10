import type { AiModelSettings } from '../../lib/api-client.js';

export interface CreateAgentModelSelection {
  provider: string;
  lightModel: string;
  heavyModel: string;
}

export function createAgentUsesInheritedModels(
  selection: CreateAgentModelSelection,
  savedModelSettings: AiModelSettings | null,
): boolean {
  if (!savedModelSettings?.provider || !savedModelSettings.lightModel || !savedModelSettings.heavyModel) {
    return false;
  }

  return selection.provider === savedModelSettings.provider
    && selection.lightModel === savedModelSettings.lightModel
    && selection.heavyModel === savedModelSettings.heavyModel;
}

export function resolveCreateAgentModelPayload(
  selection: CreateAgentModelSelection,
  savedModelSettings: AiModelSettings | null,
): {
  inherits: boolean;
  provider?: string | null;
  lightModel?: string | null;
  heavyModel?: string | null;
} {
  if (createAgentUsesInheritedModels(selection, savedModelSettings)) {
    return { inherits: true };
  }

  return {
    inherits: false,
    provider: selection.provider || null,
    lightModel: selection.lightModel || null,
    heavyModel: selection.heavyModel || null,
  };
}