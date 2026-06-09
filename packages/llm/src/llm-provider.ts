/**
 * Shared LLM provider client.
 * Supports OpenAI-compatible API (OpenAI, local proxies) and native Anthropic API.
 * Extracted from packages/strategy so both strategy backtesting and the agent
 * runtime can import it without introducing a circular dependency.
 */

export interface LlmProviderConfig {
  provider: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** Base URL override (for testing or alternative endpoints) */
  baseUrl?: string;
}

export interface LlmRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature?: number;
  thinking?: 'none' | 'light' | 'deep';
}

export interface LlmResponse {
  content: string;
  model: string;
  provider: string;
  tokensUsed: number;
  latencyMs: number;
  cached: boolean;
  thinkingTokens?: number;
}

export interface LlmProviderError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export type LlmResult = { ok: true; data: LlmResponse } | { ok: false; error: LlmProviderError };

export function stripReasoningContent(content: string): string {
  return content
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/```(?:thinking|reasoning)[\s\S]*?```/gi, '')
    .trim();
}

/**
 * Call the LLM provider (HTTP-based).
 * Supports:
 *   - OpenAI-compatible: /chat/completions with Bearer token (openai, local proxies)
 *   - Anthropic native: /messages endpoint with x-api-key header
 */
export async function callLlmProvider(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  if (config.provider === 'anthropic' && !config.baseUrl) {
    return callAnthropicProvider(config, request);
  }
  return callOpenAiCompatibleProvider(config, request);
}

async function callOpenAiCompatibleProvider(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  const baseUrl = config.baseUrl ?? resolveBaseUrl(config.provider);
  const apiKey = resolveApiKey(config.provider);

  // Local providers (e.g. Ollama) don't need an API key when baseUrl is explicitly set.
  if (!apiKey && !config.baseUrl) {
    return { ok: false, error: { code: 'provider.no_credentials', message: `No API key found for provider "${config.provider}"`, retryable: false } };
  }

  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature ?? 0,
  };

  if (config.provider === 'openai') {
    const reasoningEffort = toOpenAiReasoningEffort(request.thinking);
    if (reasoningEffort) {
      requestBody['reasoning_effort'] = reasoningEffort;
    }
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: `provider.http_${response.status}`,
          message: `Provider returned ${response.status}: ${body.slice(0, 200)}`,
          retryable: response.status >= 500 || response.status === 429,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        },
      };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
      model?: string;
    };

    const content = stripReasoningContent(data.choices?.[0]?.message?.content ?? '');
    return {
      ok: true,
      data: {
        content,
        model: data.model ?? config.model,
        provider: config.provider,
        tokensUsed: data.usage?.total_tokens ?? 0,
        latencyMs: Date.now() - startMs,
        cached: false,
        thinkingTokens: data.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const isTimeout = error.name === 'AbortError';
    return {
      ok: false,
      error: {
        code: isTimeout ? 'provider.timeout' : 'provider.network_error',
        message: error.message,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropicProvider(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  // Anthropic native wire format: POST /messages, x-api-key header, max_tokens at top level.
  const apiKey = resolveApiKey('anthropic');
  if (!apiKey) {
    return { ok: false, error: { code: 'provider.no_credentials', message: 'No API key found for provider "anthropic"', retryable: false } };
  }

  const baseUrl = 'https://api.anthropic.com/v1';
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  // Anthropic requires system prompt to be a top-level field, not in messages.
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const chatMessages = request.messages.filter((m) => m.role !== 'system');
  const thinkingBudgetTokens = toAnthropicThinkingBudget(request.thinking);
  const maxTokens = thinkingBudgetTokens > 0
    ? request.maxTokens + thinkingBudgetTokens
    : request.maxTokens;
  const temperature = thinkingBudgetTokens > 0
    ? 1
    : (request.temperature ?? 0);

  const requestBody: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    ...(systemMessage ? { system: systemMessage.content } : {}),
    messages: chatMessages,
  };

  if (thinkingBudgetTokens > 0) {
    requestBody['thinking'] = {
      type: 'enabled',
      budget_tokens: thinkingBudgetTokens,
    };
  }

  try {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: `provider.http_${response.status}`,
          message: `Anthropic returned ${response.status}: ${body.slice(0, 200)}`,
          retryable: response.status >= 500 || response.status === 429,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        },
      };
    }

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number };
      model?: string;
    };

    const content = stripReasoningContent(data.content?.find((b) => b.type === 'text')?.text ?? '');
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;

    return {
      ok: true,
      data: {
        content,
        model: data.model ?? config.model,
        provider: 'anthropic',
        tokensUsed: inputTokens + outputTokens,
        latencyMs: Date.now() - startMs,
        cached: false,
        thinkingTokens: data.usage?.thinking_tokens ?? 0,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const isTimeout = error.name === 'AbortError';
    return {
      ok: false,
      error: {
        code: isTimeout ? 'provider.timeout' : 'provider.network_error',
        message: error.message,
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveBaseUrl(provider: string): string {
  switch (provider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'ollama': return 'http://localhost:11434/v1';
    default: return `https://api.${provider}.com/v1`;
  }
}

function resolveApiKey(provider: string): string | undefined {
  const envKey = `LLM_API_KEY_${provider.toUpperCase()}`;
  return process.env[envKey] ?? process.env['LLM_API_KEY'];
}

function toAnthropicThinkingBudget(thinking: LlmRequest['thinking']): number {
  switch (thinking) {
    case 'light':
      return 2_048;
    case 'deep':
      return 10_240;
    default:
      return 0;
  }
}

function toOpenAiReasoningEffort(thinking: LlmRequest['thinking']): 'low' | 'high' | undefined {
  switch (thinking) {
    case 'light':
      return 'low';
    case 'deep':
      return 'high';
    default:
      return undefined;
  }
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | undefined {
  if (!retryAfterHeader) {
    return undefined;
  }

  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const retryAtMs = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAtMs)) {
    return undefined;
  }

  return Math.max(0, retryAtMs - Date.now());
}
