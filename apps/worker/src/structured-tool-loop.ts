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
  /** Per-turn tool definition getter. When provided, called at each turn to get the latest tools. */
  getTools?: () => LlmToolDefinition[];
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
  /** Fires on every non-fatal failed LLM attempt, including the final one (before and after retries). */
  onFailedAttempt?: (info: {
    turnIndex: number;
    attempt: number;
    classification: RuntimeFailureClassification;
  }) => void;
  onBeforeTurn?: (info: { turnIndex: number; turnsRemaining: number }) =>
    | string
    | {
        message?: string;
        toolChoice?: LlmRequest['toolChoice'];
      }
    | undefined;
  /** After this many retention turns, truncate older tool results to maxStaleChars. Omit to disable. */
  toolResultFullRetentionTurns?: number;
  /** Max chars to keep in a stale tool result (appends '...[truncated]'). */
  toolResultMaxStaleChars?: number;
}

export interface StructuredToolLoopSuccess {
  ok: true;
  assistantResponse: string;
  toolCalls: LlmToolCall[];
  turnsUsed: number;
  terminatedByLimit: boolean;
}

export interface StructuredToolLoopFailure {
  ok: false;
  error: LlmProviderError;
}

export type StructuredToolLoopResult = StructuredToolLoopSuccess | StructuredToolLoopFailure;

export async function runStructuredToolLoop(options: StructuredToolLoopOptions): Promise<StructuredToolLoopResult> {
  const messages = [...options.initialMessages];
  const defaultToolChoice = options.toolChoice ?? (options.tools.length > 0 ? 'auto' : 'none');
  let lastAssistantResponse = '';
  let lastToolCalls: LlmToolCall[] = [];
  let turnsUsed = 0;

  for (let turnIndex = 0; turnIndex < options.maxTurns; turnIndex++) {
    // Truncate tool results from turns older than retentionTurns.
    // A result at exactly the retention boundary (age === retentionTurns) is
    // still within the full-retention window and should NOT be truncated yet.
    if (options.toolResultFullRetentionTurns !== undefined && options.toolResultMaxStaleChars !== undefined) {
      for (const msg of messages) {
        if (msg.role === 'tool' && msg.addedAtTurn !== undefined) {
          const age = turnIndex - msg.addedAtTurn;
          if (age > options.toolResultFullRetentionTurns && msg.content.length > options.toolResultMaxStaleChars) {
            msg.content = msg.content.slice(0, options.toolResultMaxStaleChars) + '...[truncated]';
          }
        }
      }
    }

    let turnToolChoice = defaultToolChoice;
    if (options.onBeforeTurn) {
      const hint = options.onBeforeTurn({ turnIndex, turnsRemaining: options.maxTurns - turnIndex });
      if (typeof hint === 'string') {
        messages.push({ role: 'user', content: hint });
      } else if (hint) {
        if (hint.message) {
          messages.push({ role: 'user', content: hint.message });
        }
        if (hint.toolChoice) {
          turnToolChoice = hint.toolChoice;
        }
      }
    }

    turnsUsed = turnIndex + 1;
    const activeTools = options.getTools ? options.getTools() : options.tools;
    const turnResultWithRetry = await callLlmWithRetry(
      options.providerConfig,
      {
        ...options.requestBase,
        messages,
        tools: activeTools,
        toolChoice: turnToolChoice,
      },
      {
        ...options.retryPolicy,
        onRetry: options.onRetry
          ? ({ attempt, delayMs, classification }) => options.onRetry?.({ turnIndex, attempt, delayMs, classification })
          : undefined,
        onAttemptFailed: options.onFailedAttempt
          ? ({ attempt, classification }) => options.onFailedAttempt?.({ turnIndex, attempt, classification })
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
        turnsUsed,
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
        addedAtTurn: turnIndex,
      });
    }
  }

  return {
    ok: true,
    assistantResponse: lastAssistantResponse,
    toolCalls: lastToolCalls,
    turnsUsed,
    terminatedByLimit: true,
  };
}
