import { createLogger } from '../logger.js';
import type { Logger } from 'pino';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';
import type {
  PlatformAssessorConfig as DomainPlatformAssessorConfig,
  PlatformAssessmentLlmConfig,
} from '@herobids/domain';
import { callLlmProvider, type LlmProviderConfig, type LlmRequest } from '@herobids/llm';
import { PlatformAssessor, type PlatformAssessorConfig, type PlatformAssessorDeps, type LlmCallUsage } from './platform-assessor.js';
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
 * config). Provider/model availability is validated at construction time.
 *
 * If `platformAssessor.llm` is missing or the provider is disabled, the
 * assessor is still constructed but will return placeholder artifacts
 * (Phase 1 scaffolding). No LLM calls will be made.
 *
 * @param llmConfig - Resolved platform LLM config from operator config.
 * @param providersBaseUrlMap - Provider base URL map from providers.yaml.
 * @param db - Database instance.
 * @param redis - Redis instance.
 * @param evidencePorts - Evidence collection ports.
 * @param getPresets - Function to load presets for a style tier.
 * @param logger - Optional logger instance.
 */
export function createPlatformAssessor(
  llmConfig: PlatformAssessmentLlmConfig | undefined,
  providersBaseUrlMap: Record<string, string> | undefined,
  db: Database,
  redis: Redis,
  evidencePorts: AssessmentEvidencePorts,
  getPresets: (styleTier: string) => Array<{ key: string; entry: PresetEntry }>,
  logger?: Logger,
): AssessorFactoryResult {
  const log = logger ?? createLogger('assessor-factory');

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

  // Build the assessor config
  const assessorConfig: PlatformAssessorConfig = {
    enabled: true,
    maxConcurrentAssessments: 1,
    maxLlmCallsPerCycle: 20,
    cacheFreshnessMs: 21_600_000, // 6 hours
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
