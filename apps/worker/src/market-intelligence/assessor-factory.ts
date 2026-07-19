import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type {
  PlatformAssessorConfig as DomainPlatformAssessorConfig,
  PlatformAssessmentLlmConfig,
} from '@herobids/domain';
import { callLlmProvider, type LlmProviderConfig, type LlmRequest } from '@herobids/llm';
import { PlatformAssessor, type PlatformAssessorRuntimeConfig, type PlatformAssessorDeps, type LlmCallUsage } from './platform-assessor.js';
import type { LlmRankerConfig } from './llm-ranker.js';
import type { AssessmentEvidencePorts } from './assessment-ports.js';
import type { PresetEntry } from '@herobids/domain';

// ── Factory Result ──────────────────────────────────────────────────────────

export interface AssessorFactoryResult {
  assessor: PlatformAssessor;
  /** The resolved platform LLM ranker config, or null if not configured. */
  llmConfig: LlmRankerConfig | null;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a PlatformAssessor with a platform-owned LLM adapter.
 *
 * The LLM adapter uses the operator-configured platform LLM (never an agent's
 * config). Provider/model availability is validated at construction time:
 * if the LLM config is provided but the configured provider is not found in
 * `providersBaseUrlMap`, construction throws — this is a loud, intentional
 * failure that prevents silent fallback to agent LLM configuration.
 *
 * If the LLM config is entirely absent (operator has not configured platform
 * LLM ranking), the assessor is still constructed but will return
 * placeholder artifacts (Phase 1 scaffolding). No LLM calls will be made.
 *
 * Runtime operational values (`enabled`, `maxConcurrentAssessments`,
 * `cacheFreshnessMs`) are derived from the operator config — no hardcoded
 * defaults. The domain schema (`PlatformAssessorConfigSchema`) is the single
 * source of truth for all defaults.
 *
 * @param operatorConfig - Full resolved operator platform assessor config.
 * @param providersBaseUrlMap - Provider base URL map from providers.yaml.
 * @param db - Database instance.
 * @param redis - Redis instance.
 * @param evidencePorts - Evidence collection ports.
 * @param getPresets - Function to load presets for a style tier.
 * @param logger - Optional logger instance.
 * @throws If llmConfig is provided but its provider is not in the loaded registry.
 */
export function createPlatformAssessor(
  operatorConfig: DomainPlatformAssessorConfig,
  providersBaseUrlMap: Record<string, string> | undefined,
  db: Database,
  redis: Redis,
  evidencePorts: AssessmentEvidencePorts,
  getPresets: (styleTier: string) => Array<{ key: string; entry: PresetEntry }>,
  logger?: Logger,
): AssessorFactoryResult {
  const log = logger ?? createLogger('assessor-factory');

  const llmConfig: PlatformAssessmentLlmConfig | undefined = operatorConfig.llm;

  // ── Provider validation ───────────────────────────────────────────────
  // Missing, disabled, or invalid platform LLM configuration is a loud
  // construction failure — the assessor must never silently fall back to
  // an agent's LLM configuration.

  if (llmConfig) {
    if (!providersBaseUrlMap || Object.keys(providersBaseUrlMap).length === 0) {
      throw new Error(
        'Platform assessor LLM config is set but no provider registry is loaded. ' +
        'Ensure providers.yaml is present and contains the configured provider.',
      );
    }
    if (!(llmConfig.provider in providersBaseUrlMap)) {
      throw new Error(
        `Platform assessor LLM provider "${llmConfig.provider}" not found in loaded provider registry. ` +
        `Available providers: ${Object.keys(providersBaseUrlMap).join(', ') || '(none)'}`,
      );
    }
    log.info(
      { provider: llmConfig.provider, model: llmConfig.model },
      'Platform assessor LLM provider validated',
    );
  }

  // Resolve the LLM ranker config from the domain config
  let rankerConfig: LlmRankerConfig | null = null;

  if (llmConfig) {
    rankerConfig = {
      provider: llmConfig.provider,
      model: llmConfig.model,
      timeoutMs: llmConfig.timeoutMs,
      maxTokens: llmConfig.maxTokens,
      maxInputTokens: llmConfig.maxInputTokens,
      scoreBands: {
        aMin: llmConfig.scoreBands.aMin,
        bMin: llmConfig.scoreBands.bMin,
        cMin: llmConfig.scoreBands.cMin,
        dMin: llmConfig.scoreBands.dMin,
      },
      recommendationPolicy: {
        minConfidence: llmConfig.recommendationPolicy.minConfidence,
        minScoreForRecommendation: llmConfig.recommendationPolicy.minScoreForRecommendation,
        minAllowedScore: llmConfig.recommendationPolicy.minAllowedScore,
      },
    };

    log.info(
      {
        provider: rankerConfig.provider,
        model: rankerConfig.model,
        maxTokens: rankerConfig.maxTokens,
      },
      'Platform assessor LLM configured',
    );
  } else {
    log.warn('No platform assessor LLM config — ranking will use placeholder artifacts');
  }

  // Build platform-owned LLM adapter
  const llmProviderConfig: LlmProviderConfig = {
    provider: llmConfig?.provider ?? 'openrouter',
    model: llmConfig?.model ?? 'anthropic/claude-fable-5',
    maxTokens: llmConfig?.maxTokens ?? 2000,
    timeoutMs: llmConfig?.timeoutMs ?? 30000,
    providersBaseUrlMap,
    baseUrl: llmConfig?.baseUrl,
  };

  async function platformCallLlm(prompt: string): Promise<{ text: string; usage: LlmCallUsage }> {
    const request: LlmRequest = {
      messages: [
        { role: 'user', content: prompt },
      ],
      maxTokens: llmProviderConfig.maxTokens,
      temperature: 0,
    };

    const result = await callLlmProvider(llmProviderConfig, request);

    if (!result.ok) {
      throw new Error(
        `Platform LLM call failed: ${result.error.code} — ${result.error.message}${result.error.retryable ? ' (retryable)' : ''}`,
      );
    }

    return {
      text: result.data.content,
      usage: {
        provider: result.data.provider,
        model: result.data.model,
        inputTokens: result.data.inputTokens ?? result.data.tokensUsed,
        outputTokens: result.data.outputTokens ?? 0,
        reasoningTokens: result.data.thinkingTokens ?? 0,
      },
    };
  }

  // Build the assessor runtime config — all operational values sourced from
  // the operator config (domain schema is the single source of truth).
  const assessorConfig: PlatformAssessorRuntimeConfig = {
    enabled: operatorConfig.enabled,
    maxConcurrentAssessments: operatorConfig.maxConcurrentAssessments,
    cacheFreshnessMs: operatorConfig.cacheFreshnessMs,
    llm: rankerConfig ?? undefined,
  };

  const deps: PlatformAssessorDeps = {
    db,
    redis,
    evidencePorts,
    getPresets,
    callLlm: platformCallLlm,
    logger: log,
  };

  const assessor = new PlatformAssessor(assessorConfig, deps);

  return { assessor, llmConfig: rankerConfig };
}
