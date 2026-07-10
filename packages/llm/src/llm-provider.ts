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
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; toolName?: string; isError?: boolean; addedAtTurn?: number };

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

  // Local providers (e.g. Ollama) don't need an API key when baseUrl is explicitly set.
  if (!apiKey && !config.baseUrl) {
    return { ok: false, error: { code: 'provider.no_credentials', message: `No API key found for provider "${config.provider}"`, retryable: false } };
  }

  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAiMessages(request.messages),
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
  if (config.provider === 'openrouter') {
    requestBody['cache_control'] = { type: 'ephemeral' };
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
      toolCalls = normalizeOpenAiToolCalls(message?.tool_calls);
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

  const requestBody: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    ...(systemMessage ? { system: systemMessage.content } : {}),
    messages: toAnthropicMessages(chatMessages),
    cache_control: { type: 'ephemeral' },
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

    appendAnthropicUserText(normalized, message.content);
  }

  return normalized;
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

function normalizeOpenAiToolCalls(toolCalls: unknown): LlmToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((toolCall, index) => {
    if (!toolCall || typeof toolCall !== 'object') {
      return [];
    }

    const candidate = toolCall as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };

    if (typeof candidate.function?.name !== 'string') {
      return [];
    }

    return [{
      id: candidate.id ?? `tool_call_${index + 1}`,
      name: candidate.function.name,
      args: parseToolArgs(candidate.function.arguments),
    }];
  });
}

function normalizeAnthropicToolCalls(
  contentBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>,
): LlmToolCall[] {
  return contentBlocks.flatMap((block, index) => {
    if (block.type !== 'tool_use' || typeof block.name !== 'string') {
      return [];
    }

    return [{
      id: block.id ?? `tool_call_${index + 1}`,
      name: block.name,
      args: asToolArgs(block.input),
    }];
  });
}

function parseToolArgs(rawArguments: string | undefined): Record<string, unknown> {
  if (!rawArguments) {
    return {};
  }

  return asToolArgs(JSON.parse(rawArguments));
}

function asToolArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object');
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
