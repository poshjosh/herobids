import { KNOWN_LLM_PROVIDERS as KNOWN_PROVIDERS, getLlmProviderModels, validateLlmModelSelection } from '@herobids/domain';

function resolveApiKey(provider: string): string | undefined {
  return process.env[`LLM_API_KEY_${provider.toUpperCase()}`] ?? process.env['LLM_API_KEY'];
}

function isProviderExplicitlyConfigured(provider: string): boolean {
  return !!process.env[`LLM_API_KEY_${provider.toUpperCase()}`];
}

function getConfiguredProviders(): string[] {
  return KNOWN_PROVIDERS.filter(isProviderExplicitlyConfigured);
}

export function getAvailableProviders(operatorProvider: string): string[] {
  const explicit = getConfiguredProviders();
  if (resolveApiKey(operatorProvider) && !explicit.includes(operatorProvider)) {
    return [...explicit, operatorProvider];
  }
  return explicit;
}

export function getProviderModels(provider: string): string[] {
  return getLlmProviderModels(provider);
}

export function validateAiModelSelection(
  selection: { provider: string; lightModel: string; heavyModel: string },
  operatorProvider?: string,
): Array<{ code: 'custom'; path: string[]; message: string }> {
  if (operatorProvider && !new Set(getAvailableProviders(operatorProvider)).has(selection.provider)) {
    return [{ code: 'custom', path: ['provider'], message: 'Selected provider is not available on this platform' }];
  }

  return validateLlmModelSelection(selection);
}

export function normalizeAgentModelPolicy(policy: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!policy) {
    return null;
  }

  const normalized: Record<string, unknown> = { ...policy };
  const provider = typeof normalized.provider === 'string' && normalized.provider.length > 0 ? normalized.provider : null;
  const lightModel = typeof normalized.lightModel === 'string' && normalized.lightModel.length > 0 ? normalized.lightModel : null;
  const heavyModel = typeof normalized.heavyModel === 'string' && normalized.heavyModel.length > 0 ? normalized.heavyModel : null;

  if (!provider) {
    delete normalized.provider;
    delete normalized.lightModel;
    delete normalized.heavyModel;
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  normalized.provider = provider;

  if (lightModel) {
    normalized.lightModel = lightModel;
  } else {
    delete normalized.lightModel;
  }

  if (heavyModel) {
    normalized.heavyModel = heavyModel;
  } else {
    delete normalized.heavyModel;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}