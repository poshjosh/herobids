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
 * Currently supports OpenAI-compatible API format.
 */
// Providers known to use an incompatible wire format (non-OpenAI chat/completions API).
const INCOMPATIBLE_PROVIDERS = new Set(['anthropic']);

export async function callLlmProvider(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  if (INCOMPATIBLE_PROVIDERS.has(config.provider) && !config.baseUrl) {
    return { ok: false, error: { code: 'provider.unsupported_format', message: `Provider "${config.provider}" uses an incompatible API format. Supply a baseUrl pointing to an OpenAI-compatible proxy, or use a supported provider.`, retryable: false } };
  }

  const baseUrl = config.baseUrl ?? resolveBaseUrl(config.provider);
  const apiKey = resolveApiKey(config.provider);

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

function resolveBaseUrl(provider: string): string {
  switch (provider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'anthropic': return 'https://api.anthropic.com/v1';
    default: return `https://api.${provider}.com/v1`;
  }
}

function resolveApiKey(provider: string): string | undefined {
  const envKey = `LLM_API_KEY_${provider.toUpperCase()}`;
  return process.env[envKey] ?? process.env['LLM_API_KEY'];
}
