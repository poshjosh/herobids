import { resolveReasoningParams, type LlmProviderConfig, type ReasoningLevel } from './llm-provider.js';

export interface OutputBudgetConfig {
  timeoutMsPerOutputToken: number;
  /** Upper bound on a scaled call timeout. */
  maxCallTimeoutMs: number;
  defaultMaxOutputTokens: number;
  maxOutputTokensByModel: Record<string, number>;
}

export interface LlmCallOutputBudget {
  maxTokens: number;
  timeoutMs: number;
  reasoningLevel: ReasoningLevel;
  /** The requested limit, set only when it was lowered to the model's maximum output. */
  clampedFrom?: number;
  /** The requested level, set only when the limit did not leave the output reserve after that level's thinking budget. */
  reasoningLoweredFrom?: ReasoningLevel;
  /** Set when even reasoning level `none` leaves less than the output reserve. */
  reserveUnmet?: true;
}

/** Used when the configured base timeout is not a positive finite number (for example an unparsable LLM_TIMEOUT_MS). */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

const LOWER_REASONING_LEVEL: Record<ReasoningLevel, ReasoningLevel> = {
  high: 'medium',
  medium: 'low',
  low: 'none',
  none: 'none',
};

/** One reasoning level lower (`high` → `medium` → `low` → `none`); `none` stays `none`. */
export function lowerReasoningLevel(level: ReasoningLevel): ReasoningLevel {
  return LOWER_REASONING_LEVEL[level];
}

/** True when the provider stopped because the output-token limit was reached (`length`, or Anthropic's `max_tokens`). */
export function isOutputLimitFinishReason(finishReason: string | undefined): boolean {
  return finishReason === 'length' || finishReason === 'max_tokens';
}

const MODEL_KEY_BOUNDARIES = new Set(['-', ':', '@', '/']);

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/\./g, '-');
}

/**
 * The key occurs in the model ID, starts at its start or after `-`, `:`, `@` or `/`, and ends at its end or at one of
 * those (so `gpt-4` does not match `gpt-4o` and `claude-3-haiku` does not match `xclaude-3-haiku`).
 */
function modelContainsKey(model: string, key: string): boolean {
  for (let index = model.indexOf(key); index !== -1; index = model.indexOf(key, index + 1)) {
    const previous = index === 0 ? undefined : model[index - 1];
    const next = model[index + key.length];
    const startsAtBoundary = previous === undefined || MODEL_KEY_BOUNDARIES.has(previous);
    const endsAtBoundary = next === undefined || MODEL_KEY_BOUNDARIES.has(next);
    if (startsAtBoundary && endsAtBoundary) return true;
  }
  return false;
}

/** Most output tokens the model accepts: the longest matching table key wins, else the default for unknown models. */
export function resolveModelMaxOutputTokens(
  model: string,
  config: Pick<OutputBudgetConfig, 'defaultMaxOutputTokens' | 'maxOutputTokensByModel'>,
): number {
  const normalizedModel = normalizeModelKey(model);
  let matchedKeyLength = 0;
  let maxOutputTokens = config.defaultMaxOutputTokens;
  for (const [key, tokens] of Object.entries(config.maxOutputTokensByModel)) {
    const normalizedKey = normalizeModelKey(key);
    if (normalizedKey.length > matchedKeyLength && modelContainsKey(normalizedModel, normalizedKey)) {
      matchedKeyLength = normalizedKey.length;
      maxOutputTokens = tokens;
    }
  }
  return maxOutputTokens;
}

/**
 * Calls are not streamed, so a larger output limit needs a longer timeout: max(base, limit × rate), with the scaled
 * part capped at `maxTimeoutMs`. A base timeout above the cap is kept, since the operator set it explicitly.
 */
export function scaleTimeoutForOutput(
  baseTimeoutMs: number,
  maxTokens: number,
  timeoutMsPerOutputToken: number,
  maxTimeoutMs: number,
): number {
  const base = Number.isFinite(baseTimeoutMs) && baseTimeoutMs > 0 ? baseTimeoutMs : DEFAULT_LLM_TIMEOUT_MS;
  return Math.max(base, Math.min(maxTokens * timeoutMsPerOutputToken, maxTimeoutMs));
}

/**
 * Output limit, timeout and reasoning level for one judge or scout call.
 * The limit is clamped to the model's maximum output, because the provider rejects a larger one. For a model with a
 * token thinking budget, the level then steps down while that budget plus `outputReserveTokens` exceeds the limit.
 * Effort-based models size their own thinking, so they keep the requested level.
 */
export function resolveLlmCallOutputBudget(params: {
  model: string;
  maxTokens: number;
  reasoningLevel: ReasoningLevel;
  outputReserveTokens: number;
  thinking: LlmProviderConfig['thinking'];
  baseTimeoutMs: number;
  config: OutputBudgetConfig;
}): LlmCallOutputBudget {
  const modelMaxOutputTokens = resolveModelMaxOutputTokens(params.model, params.config);
  const maxTokens = Math.min(params.maxTokens, modelMaxOutputTokens);
  const timeoutMs = scaleTimeoutForOutput(
    params.baseTimeoutMs,
    maxTokens,
    params.config.timeoutMsPerOutputToken,
    params.config.maxCallTimeoutMs,
  );

  let reasoningLevel = params.reasoningLevel;
  let reserveUnmet = false;
  for (;;) {
    const thinkingTokens = resolveReasoningParams(reasoningLevel, params.model, params.thinking)?.max_tokens;
    if (thinkingTokens === undefined || thinkingTokens + params.outputReserveTokens <= maxTokens) break;
    if (reasoningLevel === 'none') {
      reserveUnmet = true;
      break;
    }
    reasoningLevel = lowerReasoningLevel(reasoningLevel);
  }

  return {
    maxTokens,
    timeoutMs,
    reasoningLevel,
    ...(maxTokens !== params.maxTokens ? { clampedFrom: params.maxTokens } : {}),
    ...(reasoningLevel !== params.reasoningLevel ? { reasoningLoweredFrom: params.reasoningLevel } : {}),
    ...(reserveUnmet ? { reserveUnmet: true as const } : {}),
  };
}
