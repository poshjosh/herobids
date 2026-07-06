import { callLlmProvider, type LlmProviderConfig, type LlmProviderError, type LlmRequest, type LlmResult } from '@herobids/llm';

export type RuntimeFailureSource = 'llm' | 'redis' | 'database' | 'market-data' | 'tool' | 'sandbox' | 'startup' | 'tick-gate';
export type RuntimeFailureMode = 'recoverable' | 'degraded' | 'fatal';

export interface RuntimeFailureClassification {
  source: RuntimeFailureSource;
  mode: RuntimeFailureMode;
  reasonCode: string;
  message: string;
  retryAfterMs?: number;
}

export interface LlmRetryResult {
  result: LlmResult;
  attempts: number;
  delaysMs: number[];
  classification?: RuntimeFailureClassification;
}

function asLlmError(error: unknown): LlmProviderError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Partial<LlmProviderError>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return null;
  }

  return {
    code: candidate.code,
    message: candidate.message,
    retryable: Boolean(candidate.retryable),
    retryAfterMs: typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs : undefined,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

export function classifyRuntimeError(
  source: RuntimeFailureSource,
  error: unknown,
): RuntimeFailureClassification {
  if (source === 'sandbox') {
    return {
      source,
      mode: 'fatal',
      reasonCode: 'sandbox.expired',
      message: errorMessage(error),
    };
  }

  if (source === 'startup') {
    return {
      source,
      mode: 'fatal',
      reasonCode: 'startup.invalid_config',
      message: errorMessage(error),
    };
  }

  const llmError = source === 'llm' ? asLlmError(error) : null;
  if (llmError) {
    if (llmError.code === 'provider.timeout') {
      return { source, mode: 'recoverable', reasonCode: 'llm.timeout', message: llmError.message };
    }
    if (llmError.code === 'provider.http_429') {
      return {
        source,
        mode: 'recoverable',
        reasonCode: 'llm.rate_limit',
        message: llmError.message,
        retryAfterMs: llmError.retryAfterMs,
      };
    }
    if (/^provider\.http_5\d\d$/.test(llmError.code)) {
      return { source, mode: 'recoverable', reasonCode: 'llm.server_error', message: llmError.message };
    }
    if (llmError.code === 'provider.http_401' || llmError.code === 'provider.http_403' || llmError.code === 'provider.no_credentials') {
      return { source, mode: 'fatal', reasonCode: 'llm.credentials', message: llmError.message };
    }
    if (llmError.code === 'provider.invalid_tool_args') {
      // Malformed tool-call JSON from the LLM is a transient content issue, not a
      // systemic failure. Classify as degraded so the agent survives the tick
      // and retries (the model often self-corrects on a fresh sample).
      return { source, mode: 'degraded', reasonCode: 'llm.invalid_tool_args', message: llmError.message, retryAfterMs: 2_000 };
    }
    return {
      source,
      mode: llmError.retryable ? 'recoverable' : 'degraded',
      reasonCode: 'llm.unavailable',
      message: llmError.message,
      retryAfterMs: llmError.retryAfterMs,
    };
  }

  if (source === 'redis') {
    const message = errorMessage(error);
    const reasonCode = /ECONNREFUSED|ECONNRESET|Connection is closed|READONLY/i.test(message)
      ? 'redis.unavailable'
      : 'redis.operation_failed';
    return { source, mode: 'recoverable', reasonCode, message };
  }

  if (source === 'database') {
    return {
      source,
      mode: 'degraded',
      reasonCode: 'database.unavailable',
      message: errorMessage(error),
    };
  }

  if (source === 'market-data') {
    return {
      source,
      mode: 'degraded',
      reasonCode: 'market_data.unavailable',
      message: errorMessage(error),
    };
  }

  if (source === 'tick-gate') {
    return {
      source,
      mode: 'degraded',
      reasonCode: 'tick_gate.degraded',
      message: errorMessage(error),
    };
  }

  return {
    source,
    mode: 'degraded',
    reasonCode: `${source}.failed`,
    message: errorMessage(error),
  };
}

export async function callLlmWithRetry(
  config: LlmProviderConfig,
  request: LlmRequest,
  options?: {
    maxRetries?: number;
    timeoutBackoffMs?: number[];
    serverErrorBackoffMs?: number;
    defaultRateLimitBackoffMs?: number;
    call?: typeof callLlmProvider;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; classification: RuntimeFailureClassification }) => void;
    /** Fires on every non-fatal failed attempt, including the final one after retries are exhausted. */
    onAttemptFailed?: (info: { attempt: number; classification: RuntimeFailureClassification }) => void;
  },
): Promise<LlmRetryResult> {
  const caller = options?.call ?? callLlmProvider;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options?.maxRetries ?? 2;
  const timeoutDelays = options?.timeoutBackoffMs ?? [5_000, 15_000];
  const serverErrorBackoffMs = options?.serverErrorBackoffMs ?? 10_000;
  const defaultRateLimitBackoffMs = options?.defaultRateLimitBackoffMs ?? 60_000;
  const delaysMs: number[] = [];

  for (let attempt = 0; ; attempt++) {
    const result = await caller(config, request);
    if (result.ok) {
      return { result, attempts: attempt + 1, delaysMs };
    }

    const classification = classifyRuntimeError('llm', result.error);
    if (classification.mode === 'fatal') {
      return { result, attempts: attempt + 1, delaysMs, classification };
    }

    options?.onAttemptFailed?.({ attempt: attempt + 1, classification });

    let delayMs: number | null = null;
    if (result.error.code === 'provider.http_429') {
      if (attempt >= 1) {
        return { result, attempts: attempt + 1, delaysMs, classification };
      }
      delayMs = classification.retryAfterMs ?? defaultRateLimitBackoffMs;
    } else if (result.error.code === 'provider.timeout' || result.error.code === 'provider.network_error') {
      if (attempt >= maxRetries) {
        return { result, attempts: attempt + 1, delaysMs, classification };
      }
      delayMs = timeoutDelays[Math.min(attempt, timeoutDelays.length - 1)] ?? timeoutDelays[timeoutDelays.length - 1] ?? 15_000;
    } else if (result.error.code === 'provider.invalid_tool_args') {
      if (attempt >= maxRetries) {
        return { result, attempts: attempt + 1, delaysMs, classification };
      }
      delayMs = 2_000; // short backoff — the LLM may self-correct malformed JSON on a fresh sample
    } else if (/^provider\.http_5\d\d$/.test(result.error.code)) {
      if (attempt >= maxRetries) {
        return { result, attempts: attempt + 1, delaysMs, classification };
      }
      delayMs = serverErrorBackoffMs;
    }

    if (delayMs === null) {
      return { result, attempts: attempt + 1, delaysMs, classification };
    }

    delaysMs.push(delayMs);
    options?.onRetry?.({ attempt: attempt + 1, delayMs, classification });
    await sleep(delayMs);
  }
}