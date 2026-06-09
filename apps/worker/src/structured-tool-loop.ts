import type { LlmProviderConfig, LlmProviderError, LlmRequest, LlmToolCall, LlmToolDefinition, LlmMessage, LlmResponse } from '@herobids/llm';
import { stripReasoningContent } from '@herobids/llm';
import { callLlmWithRetry } from './runtime-errors.js';
import type { RuntimeFailureClassification } from './runtime-errors.js';

export interface StructuredToolLoopOptions {
  providerConfig: LlmProviderConfig;
  requestBase: Omit<LlmRequest, 'messages' | 'tools' | 'toolChoice'>;
  initialMessages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTurns: number;
  toolChoice?: 'auto' | 'none' | 'required';
  retryPolicy?: {
    maxRetries?: number;
    timeoutBackoffMs?: number[];
    serverErrorBackoffMs?: number;
    defaultRateLimitBackoffMs?: number;
  };
  executeTool: (call: LlmToolCall) => Promise<string | null>;
  onAssistantTurn?: (info: {
    turnIndex: number;
    result: { ok: true; data: LlmResponse };
    assistantResponse: string;
    toolCalls: LlmToolCall[];
  }) => Promise<void> | void;
  onToolResult?: (info: {
    turnIndex: number;
    toolCall: LlmToolCall;
    toolResult: string | null;
  }) => Promise<void> | void;
  onRetry?: (info: {
    turnIndex: number;
    attempt: number;
    delayMs: number;
    classification: RuntimeFailureClassification;
  }) => void;
}

export interface StructuredToolLoopSuccess {
  ok: true;
  assistantResponse: string;
  toolCalls: LlmToolCall[];
  terminatedByLimit: boolean;
}

export interface StructuredToolLoopFailure {
  ok: false;
  error: LlmProviderError;
}

export type StructuredToolLoopResult = StructuredToolLoopSuccess | StructuredToolLoopFailure;

export async function runStructuredToolLoop(options: StructuredToolLoopOptions): Promise<StructuredToolLoopResult> {
  const messages = [...options.initialMessages];
  const toolChoice = options.toolChoice ?? (options.tools.length > 0 ? 'auto' : 'none');
  let lastAssistantResponse = '';
  let lastToolCalls: LlmToolCall[] = [];

  for (let turnIndex = 0; turnIndex < options.maxTurns; turnIndex++) {
    const turnResultWithRetry = await callLlmWithRetry(
      options.providerConfig,
      {
        ...options.requestBase,
        messages,
        tools: options.tools,
        toolChoice,
      },
      {
        ...options.retryPolicy,
        onRetry: options.onRetry
          ? ({ attempt, delayMs, classification }) => options.onRetry?.({ turnIndex, attempt, delayMs, classification })
          : undefined,
      },
    );

    if (!turnResultWithRetry.result.ok) {
      return {
        ok: false,
        error: turnResultWithRetry.result.error,
      };
    }

    const assistantResponse = stripReasoningContent(turnResultWithRetry.result.data.content);
    const toolCalls = turnResultWithRetry.result.data.toolCalls;
    lastAssistantResponse = assistantResponse;
    lastToolCalls = toolCalls;

    await options.onAssistantTurn?.({
      turnIndex,
      result: turnResultWithRetry.result,
      assistantResponse,
      toolCalls,
    });

    if (toolCalls.length === 0) {
      return {
        ok: true,
        assistantResponse,
        toolCalls,
        terminatedByLimit: false,
      };
    }

    messages.push({
      role: 'assistant',
      content: assistantResponse,
      toolCalls,
    });

    for (const toolCall of toolCalls) {
      const toolResult = await options.executeTool(toolCall);
      await options.onToolResult?.({
        turnIndex,
        toolCall,
        toolResult,
      });
      messages.push({
        role: 'tool',
        content: toolResult ?? '',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: toolResult === null,
      });
    }
  }

  return {
    ok: true,
      assistantResponse: lastAssistantResponse,
      toolCalls: lastToolCalls,
    terminatedByLimit: true,
  };
}
