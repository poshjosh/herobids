import { resolveEffectiveLlmSelection, resolveAgentCostProfile, type AgentLlmSelectionInput, type CostPreset } from '@herobids/domain';
import { getProviderModelIds, type ProvidersYaml, type ProviderConfig } from '@herobids/domain';
import type { ResolvedNarrativeLlmConfig } from '@herobids/db';
import type { NarrativeLlmRequest } from '@herobids/domain';
import type { PersistedAiModelConfig } from '@herobids/domain';
import type { OpenRouterProviderControls } from '@herobids/llm';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';

export interface NarrativeLlmResolutionInput {
  /** The agent's modelPolicy JSONB (may contain provider, lightModel, heavyModel, costPreset, dailySpendBudgetUsd) */
  agentModelPolicy: Record<string, unknown> | null;
  /** User AI model defaults (from getUserAiModelConfig) */
  userAiModelConfig: PersistedAiModelConfig | null;
  /** Caller-specified narrative LLM override from the request body */
  narrativeLlmOverride?: NarrativeLlmRequest;
  /** Operator default LLM provider */
  operatorDefaultProvider: string;
  /** Operator default LLM base URL (only applied when resolved provider matches operator default) */
  operatorBaseUrl?: string;
  /** Operator LLM timeout for narrative generation */
  operatorTimeoutMs: number;
  /** Operator LLM max tokens for narrative generation */
  operatorMaxTokens: number;
  /** Provider registry for model validation */
  providersYaml: ProvidersYaml;
  /** Optional catalog deps for dynamic provider model validation (OpenRouter/Ollama).
   * When omitted, dynamic provider models are not validated at request time. */
  catalogDeps?: LlmCatalogDeps;
  /** OpenRouter provider controls for privacy enforcement. */
  openRouterProviderControls?: OpenRouterProviderControls;
}

/**
 * Resolve the narrative LLM configuration at enqueue time.
 * Throws with a user-friendly message on failure (catch and return 400).
 */
export async function resolveNarrativeLlmConfig(input: NarrativeLlmResolutionInput): Promise<ResolvedNarrativeLlmConfig> {
  // 1. Extract agent model policy fields
  const agentProvider = typeof input.agentModelPolicy?.provider === 'string' ? input.agentModelPolicy.provider : undefined;
  const agentLightModel = typeof input.agentModelPolicy?.lightModel === 'string' ? input.agentModelPolicy.lightModel : undefined;
  const agentHeavyModel = typeof input.agentModelPolicy?.heavyModel === 'string' ? input.agentModelPolicy.heavyModel : undefined;
  const agentCostPreset = (typeof input.agentModelPolicy?.costPreset === 'string' ? input.agentModelPolicy.costPreset : undefined) as CostPreset | undefined;
  const agentDailyBudget = typeof input.agentModelPolicy?.dailySpendBudgetUsd === 'number' ? input.agentModelPolicy.dailySpendBudgetUsd : undefined;

  // 2. Build the agent LLM selection input
  const agentConfig: AgentLlmSelectionInput = {
    provider: agentProvider,
    lightModel: agentLightModel,
    heavyModel: agentHeavyModel,
    userModelDefaults: input.userAiModelConfig ? {
      provider: input.userAiModelConfig.provider,
      lightModel: input.userAiModelConfig.lightModel,
      heavyModel: input.userAiModelConfig.heavyModel,
    } : null,
  };

  // 3. Resolve effective LLM selection (provider + light + heavy)
  const selection = resolveEffectiveLlmSelection({ agentConfig });
  if (!selection.provider || !selection.heavyModel || !selection.lightModel) {
    throw new Error(
      'Cannot resolve narrative LLM: incomplete model selection. ' +
      'Set provider, lightModel, and heavyModel in agent config or user AI settings.',
    );
  }

  // 4. Derive effective heavy model via cost profile
  const costProfile = resolveAgentCostProfile({
    provider: selection.provider,
    heavyModel: selection.heavyModel,
    lightModel: selection.lightModel,
    costPreset: agentCostPreset,
    dailyBudgetUsd: agentDailyBudget,
    baseTickIntervalMs: 60_000, // not used for narrative, but required by the function
  });

  // 5. Apply override rules
  let finalProvider: string;
  let finalModel: string;

  if (input.narrativeLlmOverride) {
    if (input.narrativeLlmOverride.provider) {
      // Provider+model override: use both from the override
      finalProvider = input.narrativeLlmOverride.provider;
      finalModel = input.narrativeLlmOverride.model;
    } else {
      // Model-only override: keep resolved provider, replace model
      finalProvider = selection.provider;
      finalModel = input.narrativeLlmOverride.model;
    }
  } else {
    // No override: use resolved provider + effective heavy model
    finalProvider = selection.provider;
    finalModel = costProfile.heavyModel;
  }

  // 6. Validate against providersYaml
  const providerConfig: ProviderConfig | undefined = input.providersYaml.providers[finalProvider];
  if (!providerConfig) {
    throw new Error(`Narrative LLM provider "${finalProvider}" is not available on this platform.`);
  }

  // For static providers, validate the model exists in the catalog.
  // For dynamic providers, use the catalog-aware validation path (DB-backed for
  // OpenRouter, network-discovered for Ollama) when catalog deps are available.
  // When catalog deps are absent, defer dynamic model validation to the worker's
  // actual LLM call — matching the existing validateLlmModelSelection pattern.
  if (providerConfig.catalogMode === 'static') {
    const modelIds = getProviderModelIds(providerConfig);
    if (!modelIds.includes(finalModel)) {
      throw new Error(`Narrative LLM model "${finalModel}" is not available for provider "${finalProvider}".`);
    }
  } else if (input.catalogDeps) {
    const { getProviderModels } = await import('../llm-model-catalog.js');
    const modelIds = await getProviderModels(finalProvider, input.catalogDeps);
    if (modelIds.length > 0 && !modelIds.includes(finalModel)) {
      throw new Error(`Narrative LLM model "${finalModel}" is not available for provider "${finalProvider}".`);
    }
  }

  // 7. Derive baseUrl
  const baseUrl = finalProvider === input.operatorDefaultProvider
    ? input.operatorBaseUrl
    : undefined;

  return {
    provider: finalProvider,
    model: finalModel,
    baseUrl,
    timeoutMs: input.operatorTimeoutMs,
    maxTokens: input.operatorMaxTokens,
    openRouterProviderControls: input.openRouterProviderControls,
  };
}
