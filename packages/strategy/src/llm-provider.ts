/**
 * Internal LLM provider helper — non-exported, single concrete provider.
 * Not a plugin interface. Multi-provider support deferred per Section 21.2.
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
}

export interface LlmResponse {
  content: string;
  model: string;
  provider: string;
  tokensUsed: number;
  latencyMs: number;
  cached: boolean;
}

export interface LlmProviderError {
  code: string;
  message: string;
  retryable: boolean;
}

export type LlmResult = { ok: true; data: LlmResponse } | { ok: false; error: LlmProviderError };

/**
 * Call the LLM provider (HTTP-based).
 * Supports OpenAI-compatible API and native Anthropic API.
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

  if (!apiKey) {
    return { ok: false, error: { code: 'provider.no_credentials', message: `No API key found for provider "${config.provider}"`, retryable: false } };
  }

  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0,
      }),
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
        },
      };
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
      model?: string;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const latencyMs = Date.now() - startMs;

    return {
      ok: true,
      data: {
        content,
        model: data.model ?? config.model,
        provider: config.provider,
        tokensUsed: data.usage?.total_tokens ?? 0,
        latencyMs,
        cached: false,
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
  const apiKey = resolveApiKey('anthropic');
  if (!apiKey) {
    return { ok: false, error: { code: 'provider.no_credentials', message: 'No API key found for provider "anthropic"', retryable: false } };
  }

  const baseUrl = 'https://api.anthropic.com/v1';
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  const systemMessage = request.messages.find((m) => m.role === 'system');
  const chatMessages = request.messages.filter((m) => m.role !== 'system');

  try {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0,
        ...(systemMessage ? { system: systemMessage.content } : {}),
        messages: chatMessages,
      }),
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
        },
      };
    }

    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };

    const content = data.content?.find((b) => b.type === 'text')?.text ?? '';
    const tokensUsed = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

    return {
      ok: true,
      data: {
        content,
        model: data.model ?? config.model,
        provider: 'anthropic',
        tokensUsed,
        latencyMs: Date.now() - startMs,
        cached: false,
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
    case 'anthropic': return 'https://api.anthropic.com/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'ollama': return 'http://localhost:11434/v1';
    default: return `https://api.${provider}.com/v1`;
  }
}

function resolveApiKey(provider: string): string | undefined {
  const envKey = `LLM_API_KEY_${provider.toUpperCase()}`;
  return process.env[envKey] ?? process.env['LLM_API_KEY'];
}
