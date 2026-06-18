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
  | { role: 'tool'; content: string; toolCallId: string; toolName?: string; isError?: boolean };

export type LlmToolChoice = 'auto' | 'none' | 'required';

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
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
  if (config.provider === 'anthropic') {
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
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
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
        cached: false,
        thinkingTokens: data.usage?.output_tokens_details?.reasoning_tokens ?? 0,
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
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

  const baseUrl = config.baseUrl ?? resolveBaseUrl('anthropic');
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  // Anthropic requires system prompt to be a top-level field, not in messages.
  const systemMessage = request.messages.find((m) => m.role === 'system');
  const chatMessages = request.messages.filter((m) => m.role !== 'system');
  const thinkingBudgetTokens = config.thinking
    ? toAnthropicThinkingBudget(request.thinking, config.thinking)
    : 0;
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
    messages: toAnthropicMessages(chatMessages),
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
      id?: string;
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number };
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
        cached: false,
        thinkingTokens: data.usage?.thinking_tokens ?? 0,
        inputTokens,
        outputTokens,
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

function toAnthropicThinkingBudget(
  thinking: LlmRequest['thinking'],
  budgetConfig: { lightBudgetTokens: number; deepBudgetTokens: number },
): number {
  switch (thinking) {
    case 'light':
      return budgetConfig.lightBudgetTokens;
    case 'deep':
      return budgetConfig.deepBudgetTokens;
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
