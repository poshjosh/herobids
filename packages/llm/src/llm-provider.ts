/**
 * Shared LLM provider client.
 * Supports OpenAI-compatible API (OpenAI, local proxies) and native Anthropic API.
 * Extracted from packages/strategy so both strategy backtesting and the agent
 * runtime can import it without introducing a circular dependency.
 */

/**
 * Controls for OpenRouter's provider routing and privacy features.
 * These map directly to the `provider` field in OpenRouter's request body.
 * @see https://openrouter.ai/docs/api-reference/overview
 */
export interface OpenRouterProviderControls {
  /** Whether to allow OpenRouter to log prompts/completions. 'deny' enables zero data retention. */
  dataCollection?: 'allow' | 'deny';
  /** Shorthand for Zero Data Retention — when true, equivalent to dataCollection: 'deny'. */
  zdr?: boolean;
  /** Whether to allow fallback to alternative models when the primary is unavailable. */
  allowFallbacks?: boolean;
  /** Restrict routing to only these provider IDs (e.g. ['anthropic', 'openai']). */
  only?: string[];
  /** Preferred order of providers to try. */
  order?: string[];
}

export interface LlmProviderConfig {
  provider: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** Base URL override (for testing or alternative endpoints) */
  baseUrl?: string;
  /**
   * Provider → base URL map sourced from operator config (providers.yaml).
   * Used as the primary fallback when `baseUrl` is not set on this config.
   * When absent, a hardcoded default per provider is used.
   */
  providersBaseUrlMap?: Record<string, string>;
  /** Thinking token budgets (used for Anthropic extended thinking) */
  thinking?: {
    lightBudgetTokens: number;
    deepBudgetTokens: number;
  };
  /** OpenRouter-specific provider routing and privacy controls. Ignored for non-OpenRouter providers. */
  openRouterProviderControls?: OpenRouterProviderControls;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LlmMessage =
  // `volatile` marks a trailing message whose text changes on every request (for example a live clock).
  // Prompt caching must end before it, because a cache entry that includes it can never be read again.
  // Only honoured on the last message of a request, and only for Claude models.
  | { role: 'system' | 'user'; content: string; volatile?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  // `pinned` tool results are exempt from stale-result truncation: they carry durable
  // instructions/state (loaded skills, docs, schemas, full documents) the agent must keep following.
  | { role: 'tool'; content: string; toolCallId: string; toolName?: string; isError?: boolean; addedAtTurn?: number; pinned?: boolean };

export type LlmToolChoice = 'auto' | 'none' | 'required';

/**
 * Reasoning level for LLM extended thinking / reasoning.
 * Will move to domain schema in Phase 2; defined inline for Phase 1.
 */
export type ReasoningLevel = 'none' | 'low' | 'medium' | 'high';

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
  /** Unified reasoning controls (OpenRouter standard). Replaces the old `thinking` field. */
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    max_tokens?: number;
    enabled?: boolean;
  };
  /** @deprecated — use `reasoning` instead. Kept for backward compat during migration. */
  thinking?: 'none' | 'light' | 'deep';
  tools?: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
}

export interface LlmResponse {
  /** Provider response identifier when available */
  responseId?: string;
  content: string;
  toolCalls: LlmToolCall[];
  model: string;
  provider: string;
  tokensUsed: number;
  latencyMs: number;
  cached: boolean;
  /** Thinking / reasoning tokens (Anthropic extended thinking or OpenAI reasoning) */
  thinkingTokens?: number;
  /** Input (prompt) tokens, when reported separately by the provider */
  inputTokens?: number;
  /** Output (completion) tokens, when reported separately by the provider */
  outputTokens?: number;
  /** Prompt-cache read tokens (charged at a fraction of the normal input rate) */
  cachedInputTokens?: number;
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

// ── Model detection helpers (heuristic, based on model ID patterns) ──────────

/**
 * Returns true if the model uses effort-based reasoning (Fable 5, Sonnet 5, Opus 4.7+).
 * These models accept `reasoning: { effort: "low"|"medium"|"high" }`.
 */
export function isEffortBasedModel(model: string): boolean {
  const effortPatterns = [
    /claude-fable/,
    /claude-sonnet-5/,
    /claude-opus-4-7/,
    /claude-opus-4-8/,
    /claude-opus-5/,
  ];
  return effortPatterns.some((p) => p.test(model));
}

/**
 * Returns true if the model always thinks and cannot disable reasoning (e.g. Fable 5).
 * For these models, `none` maps to `effort: "minimal"` — the lowest cost, never zero.
 */
export function isAdaptiveThinkingOnlyModel(model: string): boolean {
  const alwaysThinkingPatterns = [/claude-fable/];
  return alwaysThinkingPatterns.some((p) => p.test(model));
}

/**
 * Returns true if the model is a Claude-family model (Anthropic).
 * Detects any model ID containing 'claude'.
 */
export function isClaudeModel(model: string): boolean {
  return /claude/i.test(model);
}

/**
 * Resolve the correct `reasoning` parameter shape for a given reasoning level and model.
 *
 * - Effort-based models (Fable 5, Sonnet 5, Opus 4.7+) use `{ effort: level }`.
 * - Adaptive-thinking-only models (Fable 5) get `{ effort: "minimal" }` when `none` is requested.
 * - Unrecognised Claude models fall back to effort-based (forward-looking API).
 * - Truly unknown (non-Claude) models fall back to `max_tokens`.
 */
export function resolveReasoningParams(
  level: ReasoningLevel,
  model: string,
  thinkingConfig: LlmProviderConfig['thinking'],
): LlmRequest['reasoning'] {
  if (level === 'none') {
    if (isAdaptiveThinkingOnlyModel(model)) {
      return { effort: 'minimal' };
    }
    return { max_tokens: 0 };
  }
  if (isEffortBasedModel(model)) {
    return { effort: level };
  }
  // Unrecognised Claude model — assume effort-based (forward-looking)
  if (isClaudeModel(model)) {
    return { effort: level };
  }
  // Truly unknown (non-Claude) — fall back to max_tokens
  const light = thinkingConfig?.lightBudgetTokens ?? 2048;
  const deep = thinkingConfig?.deepBudgetTokens ?? 10240;
  const tokens =
    level === 'low'
      ? light
      : level === 'medium'
        ? Math.round((light + deep) / 2)
        : deep;
  return { max_tokens: tokens };
}

/**
 * Returns true when the reasoning shape should be sent in the request body.
 * Skips `{ max_tokens: 0 }` with no effort (equivalent to "no reasoning").
 */
function shouldSendReasoning(reasoning: LlmRequest['reasoning']): boolean {
  if (!reasoning) return false;
  if (reasoning.effort) return true;
  if (reasoning.enabled === true) return true;
  if (reasoning.max_tokens !== undefined && reasoning.max_tokens > 0) return true;
  return false;
}

/**
 * Resolve the effective reasoning for a request, with backward compat for the
 * deprecated `thinking` field.
 */
function resolveEffectiveReasoning(
  request: LlmRequest,
  model: string,
  thinkingConfig: LlmProviderConfig['thinking'],
): LlmRequest['reasoning'] {
  if (request.reasoning) return request.reasoning;
  if (!request.thinking) return undefined;
  // Map deprecated thinking values to ReasoningLevel
  const level: ReasoningLevel =
    request.thinking === 'none' ? 'none' : request.thinking === 'light' ? 'low' : 'high';
  return resolveReasoningParams(level, model, thinkingConfig);
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
  if (config.provider === 'anthropic') {
    return callAnthropicProvider(config, request);
  }
  return callOpenAiCompatibleProvider(config, request);
}

async function callOpenAiCompatibleProvider(
  config: LlmProviderConfig,
  request: LlmRequest,
): Promise<LlmResult> {
  const baseUrl = config.baseUrl ?? resolveBaseUrl(config.provider, config.providersBaseUrlMap);
  const apiKey = resolveApiKey(config.provider);

  // Local providers (e.g. Ollama) don't need an API key when a base URL is
  // resolved — either set explicitly on the config or registered in the
  // operator's provider registry (providers.yaml → providersBaseUrlMap).
  if (!apiKey && !config.baseUrl && !config.providersBaseUrlMap?.[config.provider]) {
    return { ok: false, error: { code: 'provider.no_credentials', message: `No API key found for provider "${config.provider}"`, retryable: false } };
  }

  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  const openAiMessages = toOpenAiMessages(request.messages);
  // OpenRouter -> Claude: end the cache before a volatile trailing message, not on it.
  const breakpointBeforeVolatileTail = isClaudeModel(config.model) && markOpenAiBreakpointBeforeVolatileTail(request.messages, openAiMessages);
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: openAiMessages,
    max_tokens: request.maxTokens,
    temperature: request.temperature ?? 0,
  };

  if (request.tools && request.tools.length > 0 && request.toolChoice !== 'none') {
    requestBody['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    requestBody['tool_choice'] = request.toolChoice === 'required' ? 'required' : 'auto';
  }

  // Unified reasoning parameter (replaces provider-specific thinking controls).
  // Supports both the new `reasoning` field and backward compat via deprecated `thinking`.
  const reasoning = resolveEffectiveReasoning(request, config.model, config.thinking);
  if (reasoning && shouldSendReasoning(reasoning)) {
    requestBody['reasoning'] = reasoning;
  }

  // Enable provider-side prompt caching for OpenRouter → Anthropic models.
  // Top-level cache_control triggers automatic caching: system prompt + conversation
  // history up to the last cacheable block are cached at ~10% of normal input cost
  // on cache hits (5-minute TTL, refreshed on use).
  // Skipped when an explicit breakpoint already ends the cache before a volatile tail (see LlmMessage.volatile).
  if (config.provider === 'openrouter' && !breakpointBeforeVolatileTail) {
    requestBody['cache_control'] = { type: 'ephemeral' };
  }

  // Emit OpenRouter provider routing/privacy controls.
  // Only defined fields are sent; nothing is emitted for non-OpenRouter providers.
  if (config.provider === 'openrouter' && config.openRouterProviderControls) {
    const controls = config.openRouterProviderControls;
    const providerObj: Record<string, unknown> = {};
    if (controls.dataCollection !== undefined) providerObj['data_collection'] = controls.dataCollection;
    if (controls.zdr !== undefined) providerObj['zdr'] = controls.zdr;
    if (controls.allowFallbacks !== undefined) providerObj['allow_fallbacks'] = controls.allowFallbacks;
    if (controls.only !== undefined) providerObj['only'] = controls.only;
    if (controls.order !== undefined) providerObj['order'] = controls.order;
    if (Object.keys(providerObj).length > 0) {
      requestBody['provider'] = providerObj;
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
      id?: string;
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } };
      model?: string;
    };

    const message = data.choices?.[0]?.message;
    const content = stripReasoningContent(typeof message?.content === 'string' ? message.content : '');
    let toolCalls: LlmToolCall[];
    try {
      const finishReason = data.choices?.[0]?.finish_reason;
      toolCalls = normalizeOpenAiToolCalls(
        message?.tool_calls,
        typeof finishReason === 'string' ? finishReason : undefined,
      );
    } catch (error) {
      return invalidToolArgsError(error);
    }
    return {
      ok: true,
      data: {
        responseId: data.id,
        content,
        toolCalls,
        model: data.model ?? config.model,
        provider: config.provider,
        tokensUsed: data.usage?.total_tokens ?? 0,
        latencyMs: Date.now() - startMs,
        cached: (data.usage?.prompt_tokens_details?.cached_tokens ?? 0) > 0,
        thinkingTokens: data.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        // Normalise to non-cached count so the billing contract is unambiguous:
        // inputTokens always means prompt tokens that were NOT served from cache.
        // For the Anthropic path, input_tokens is already non-cached; the OpenAI
        // path reports prompt_tokens as the inclusive total, so we subtract here.
        inputTokens: data.usage?.prompt_tokens != null
          ? data.usage.prompt_tokens - (data.usage.prompt_tokens_details?.cached_tokens ?? 0)
          : undefined,
        outputTokens: data.usage?.completion_tokens,
        cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens,
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

  const baseUrl = config.baseUrl ?? resolveBaseUrl('anthropic', config.providersBaseUrlMap);
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  // Anthropic requires system prompt to be a top-level field, not in messages.
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const chatMessages = request.messages.filter((m) => m.role !== 'system');

  // Resolve reasoning: new `reasoning` field takes precedence, deprecated `thinking` as fallback.
  const reasoning = resolveEffectiveReasoning(request, config.model, config.thinking);
  const isReasoningActive = reasoning != null && shouldSendReasoning(reasoning);

  // For legacy token-budget models, the reasoning max_tokens must be added to the
  // top-level max_tokens so the model has enough total budget. Adaptive effort-based
  // models manage their own budget internally via output_config.effort.
  const reasoningBudgetTokens =
    isReasoningActive && (reasoning?.max_tokens ?? 0) > 0 ? (reasoning!.max_tokens!) : 0;
  const maxTokens =
    reasoningBudgetTokens > 0 ? request.maxTokens + reasoningBudgetTokens : request.maxTokens;
  const temperature = isReasoningActive ? 1 : (request.temperature ?? 0);

  const anthropicMessages = toAnthropicMessages(chatMessages);
  const requestBody: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    ...(systemMessage ? { system: systemMessage.content } : {}),
    messages: anthropicMessages,
    // Automatic caching puts its breakpoint on the last block. When a volatile tail already has an
    // explicit breakpoint before it, that automatic one would only cache a block that never repeats.
    ...(anthropicMessages.some(hasCacheBreakpoint) ? {} : { cache_control: { type: 'ephemeral' } }),
  };

  if (request.tools && request.tools.length > 0 && request.toolChoice !== 'none') {
    requestBody['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    requestBody['tool_choice'] = request.toolChoice === 'required'
      ? { type: 'any' }
      : { type: 'auto' };
  }

  if (isReasoningActive) {
    if ((reasoning!.max_tokens ?? 0) > 0) {
      // Legacy token-budget models (Opus 4.5, Haiku 4.5, earlier Claude 4)
      requestBody['thinking'] = { type: 'enabled', budget_tokens: reasoning!.max_tokens };
    } else if (reasoning!.effort != null) {
      // Adaptive effort-based models (Fable 5, Mythos 5, Sonnet 5, Opus 4.7+, Opus 4.6, Sonnet 4.6).
      // On Anthropic native API, effort lives in a separate top-level output_config field,
      // NOT nested inside thinking. Sending effort inside thinking returns a 400 error.
      // 'minimal' is our internal concept; the lowest Anthropic accepts is 'low'.
      const effortLevel = reasoning!.effort === 'minimal' ? 'low' : reasoning!.effort;
      requestBody['thinking'] = { type: 'adaptive' };
      requestBody['output_config'] = { effort: effortLevel };
    } else {
      // enabled: true without budget or effort — default to adaptive (thinking on, model chooses depth)
      requestBody['thinking'] = { type: 'adaptive' };
    }
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
      id?: string;
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      model?: string;
    };

    const contentBlocks = data.content ?? [];
    const content = stripReasoningContent(
      contentBlocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n'),
    );
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    let toolCalls: LlmToolCall[];
    try {
      toolCalls = normalizeAnthropicToolCalls(contentBlocks);
    } catch (error) {
      return invalidToolArgsError(error);
    }

    return {
      ok: true,
      data: {
        responseId: data.id,
        content,
        toolCalls,
        model: data.model ?? config.model,
        provider: 'anthropic',
        tokensUsed: inputTokens + outputTokens,
        latencyMs: Date.now() - startMs,
        cached: (data.usage?.cache_read_input_tokens ?? 0) > 0,
        thinkingTokens: data.usage?.thinking_tokens ?? 0,
        inputTokens,
        outputTokens,
        cachedInputTokens: data.usage?.cache_read_input_tokens,
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

function resolveBaseUrl(provider: string, providersBaseUrlMap?: Record<string, string>): string {
  // 1. Operator-configured base URL from providers.yaml (takes precedence)
  if (providersBaseUrlMap?.[provider]) {
    return providersBaseUrlMap[provider]!;
  }
  // 2. Hardcoded fallback for known providers
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

export function toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const toolCalls = message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.args),
        },
      }));
      const hasToolCalls = toolCalls && toolCalls.length > 0;
      // Omit `content` when empty and tool calls are present:
      // DeepSeek (and some other providers) reject `content: null` with
      // "invalid message content type: <nil>".
      // Use empty string instead of null for messages without tool calls
      // to avoid the same rejection.
      const contentField = message.content.length > 0
        ? { content: message.content }
        : hasToolCalls
          ? {}
          : { content: '' };
      return {
        role: 'assistant',
        ...contentField,
        ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
      };
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function toAnthropicMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content.length > 0) {
        blocks.push({ type: 'text', text: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.args,
        });
      }

      normalized.push({
        role: 'assistant',
        content: blocks.length === 0 ? message.content : blocks,
      });
      continue;
    }

    if (message.role === 'tool') {
      appendAnthropicUserBlock(normalized, {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        is_error: message.isError ?? false,
      });
      continue;
    }

    if (message.role === 'user' && message.volatile && message === messages.at(-1)) {
      markLastAnthropicBlockCacheable(normalized);
    }
    appendAnthropicUserText(normalized, message.content);
  }

  return normalized;
}

const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const;

function hasCacheBreakpoint(message: Record<string, unknown>): boolean {
  const content = message['content'];
  return Array.isArray(content) && content.some((block) => typeof block === 'object' && block !== null && 'cache_control' in block);
}

/**
 * Ends the cache at the last block built so far, so a volatile message appended after it stays outside the cache.
 * A plain-text message becomes a one-block message to carry the marker. Empty content cannot carry one.
 */
function markLastAnthropicBlockCacheable(messages: Array<Record<string, unknown>>): void {
  const last = messages.at(-1);
  if (!last) return;
  const content = last['content'];
  if (typeof content === 'string') {
    if (content.length > 0) {
      last['content'] = [{ type: 'text', text: content, cache_control: EPHEMERAL_CACHE_CONTROL }];
    }
    return;
  }
  const lastBlock = Array.isArray(content) ? content.at(-1) : undefined;
  if (typeof lastBlock === 'object' && lastBlock !== null) {
    (lastBlock as Record<string, unknown>)['cache_control'] = EPHEMERAL_CACHE_CONTROL;
  }
}

/**
 * OpenAI-format counterpart: puts the cache marker on the message just before a volatile last message.
 * Returns true when the marker was placed, so the caller can drop the top-level (last-block) marker.
 * Returns false (request unchanged) when there is no volatile tail or the previous message has no text to carry it.
 */
function markOpenAiBreakpointBeforeVolatileTail(source: LlmMessage[], formatted: Array<Record<string, unknown>>): boolean {
  const tail = source.at(-1);
  if (!tail || tail.role !== 'user' || !tail.volatile) return false;
  const previous = formatted.at(-2);
  const content = previous?.['content'];
  if (!previous || typeof content !== 'string' || content.length === 0) return false;
  previous['content'] = [{ type: 'text', text: content, cache_control: EPHEMERAL_CACHE_CONTROL }];
  return true;
}

function appendAnthropicUserText(messages: Array<Record<string, unknown>>, text: string): void {
  const lastMessage = messages.at(-1);
  if (lastMessage && lastMessage['role'] === 'user') {
    const content = lastMessage['content'];
    if (typeof content === 'string') {
      lastMessage['content'] = content.length > 0 ? `${content}\n\n${text}` : text;
      return;
    }
    if (Array.isArray(content)) {
      content.push({ type: 'text', text });
      return;
    }
  }

  messages.push({ role: 'user', content: text });
}

function appendAnthropicUserBlock(messages: Array<Record<string, unknown>>, block: Record<string, unknown>): void {
  const lastMessage = messages.at(-1);
  if (lastMessage && lastMessage['role'] === 'user') {
    const content = lastMessage['content'];
    if (Array.isArray(content)) {
      content.push(block);
      return;
    }
    if (typeof content === 'string') {
      lastMessage['content'] = [
        ...(content.length > 0 ? [{ type: 'text', text: content }] : []),
        block,
      ];
      return;
    }
  }

  messages.push({ role: 'user', content: [block] });
}

const MAX_LOGGED_TOOL_CALL_ID_LENGTH = 64;

// The id is model-supplied: collapse whitespace/control chars so it stays on one log line, then cap it.
function sanitizeToolCallIdForLog(id: string): string {
  return id
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, MAX_LOGGED_TOOL_CALL_ID_LENGTH);
}

// Logs position, reason and call id only; never argument content or name text.
function warnDroppedToolCall(index: number, total: number, reason: string, id?: unknown): void {
  const safeId = typeof id === 'string' ? sanitizeToolCallIdForLog(id) : '';
  const idPart = safeId.length > 0 ? ` (id ${safeId})` : '';
  console.warn(`[llm-provider] dropped tool call ${index + 1} of ${total}: ${reason}${idPart}`);
}

function normalizeOpenAiToolCalls(toolCalls: unknown, finishReason?: string): LlmToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((toolCall, index) => {
    if (!toolCall || typeof toolCall !== 'object') {
      warnDroppedToolCall(index, toolCalls.length, 'entry is not an object');
      return [];
    }

    const candidate = toolCall as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };

    if (typeof candidate.function?.name !== 'string') {
      warnDroppedToolCall(index, toolCalls.length, 'no function name', candidate.id);
      return [];
    }

    const id = candidate.id ?? `tool_call_${index + 1}`;
    return [{
      id,
      name: candidate.function.name,
      args: parseToolArgs(candidate.function.arguments, {
        name: candidate.function.name,
        id,
        index,
        total: toolCalls.length,
        finishReason,
      }),
    }];
  });
}

function normalizeAnthropicToolCalls(
  contentBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>,
): LlmToolCall[] {
  const toolUseTotal = contentBlocks.filter(
    block => block.type === 'tool_use' && typeof block.name === 'string',
  ).length;
  let callIndex = -1;
  return contentBlocks.flatMap((block, index) => {
    if (block.type !== 'tool_use' || typeof block.name !== 'string') {
      return [];
    }
    callIndex += 1;
    const id = block.id ?? `tool_call_${index + 1}`;

    return [{
      id,
      name: block.name,
      args: asToolArgs(block.input, { name: block.name, id, index: callIndex, total: toolUseTotal }),
    }];
  });
}

// Diagnostic limit on the stored error message, not an operator setting.
const MAX_INVALID_TOOL_ARGS_MESSAGE_LENGTH = 600;

interface ToolCallContext {
  name: string;
  id: string;
  index: number;
  total: number;
  finishReason?: string;
}

function describeToolCall(context: ToolCallContext): string {
  return `"${context.name}" (call ${context.id}, call ${context.index + 1} of ${context.total})`;
}

function capMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, ' ');
  return singleLine.length <= MAX_INVALID_TOOL_ARGS_MESSAGE_LENGTH
    ? singleLine
    : `${singleLine.slice(0, MAX_INVALID_TOOL_ARGS_MESSAGE_LENGTH - 3)}...`;
}

// Newer V8 quotes an excerpt of the input ("Unexpected token 'x', "..." is not valid
// JSON", `"undefined" is not valid JSON`, truncated `"..."` forms). Keep at most the
// leading `Unexpected token 'X'` and drop the rest so no argument text reaches the message.
function sanitizeEngineMessage(engineMessage: string): string {
  if (!/is not valid JSON/.test(engineMessage)) {
    return engineMessage.endsWith('.') ? engineMessage : `${engineMessage}.`;
  }
  const leadingToken = /^Unexpected token '.'/su.exec(engineMessage)?.[0];
  return `${leadingToken ? `${leadingToken} ` : ''}(input excerpt omitted).`;
}

function describeJsonFailure(
  engineMessage: string,
  rawArguments: string,
  context: ToolCallContext,
): string {
  const parts = [`Invalid tool arguments for ${describeToolCall(context)}: not valid JSON.`];
  // The position text is V8-specific; fall back to the raw message when absent.
  const positionMatch = /position (\d+)/.exec(engineMessage);
  const position = positionMatch?.[1] !== undefined ? Number(positionMatch[1]) : undefined;
  parts.push(sanitizeEngineMessage(engineMessage));
  parts.push(`The arguments are ${rawArguments.length} characters long.`);
  if (position !== undefined) {
    const current = rawArguments[position];
    const previous = position > 0 ? rawArguments[position - 1] : undefined;
    if (current !== undefined) {
      parts.push(`The character at position ${position} is ${JSON.stringify(current)}.`);
    }
    if (previous !== undefined) {
      parts.push(`The character before it is ${JSON.stringify(previous)}.`);
    }
  }
  const cutOff = context.finishReason === 'length'
    || /unterminated string|unexpected end of json/i.test(engineMessage);
  if (cutOff) {
    parts.push('The output was probably cut off (token limit); the call was too large for one response.');
  }
  if (context.finishReason) {
    parts.push(`The model finished with reason ${JSON.stringify(context.finishReason.slice(0, 40))}.`);
  }
  return capMessage(parts.join(' '));
}

function parseToolArgs(
  rawArguments: string | undefined,
  context: ToolCallContext,
): Record<string, unknown> {
  if (!rawArguments) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (error) {
    const engineMessage = error instanceof Error ? error.message : String(error);
    throw new Error(describeJsonFailure(engineMessage, rawArguments, context));
  }
  return asToolArgs(parsed, context);
}

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function asToolArgs(value: unknown, context: ToolCallContext): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(capMessage(
      `Tool arguments must be a JSON object. Invalid tool arguments for ${describeToolCall(context)}: received ${describeReceived(value)}.`,
    ));
  }
  return value as Record<string, unknown>;
}

function invalidToolArgsError(error: unknown): LlmResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: 'provider.invalid_tool_args',
      message,
      retryable: false,
    },
  };
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
