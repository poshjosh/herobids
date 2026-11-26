import type { LlmProviderConfig, LlmProviderError, LlmRequest, LlmResult, LlmToolCall, LlmToolDefinition, LlmMessage, LlmResponse, ReasoningLevel } from '@herobids/llm';
import { isOutputLimitFinishReason, lowerReasoningLevel, stripReasoningContent } from '@herobids/llm';
import { callLlmWithRetry } from './runtime-errors.js';
import type { LlmRetryResult, RuntimeFailureClassification } from './runtime-errors.js';

/** Added to the turn context of a length-recovery retry only. */
export const LENGTH_RECOVERY_HINT =
  'Your last response was cut off at the output limit. Think briefly and make smaller tool calls (split long file content across `append_file` calls).';

/** How a call was cut off at the output limit: tool-call JSON cut short, or no text and no tool call. */
export type LengthRecoveryCause = 'invalid_tool_args' | 'empty_reply';

export interface LengthRecoveryOptions {
  /** Recovery retries per turn. 0 = off: a cut-off call gets the normal retry of the same request. */
  maxRetries: number;
  /** Reasoning level of the normal request; each recovery retry steps one level lower. */
  reasoningLevel: ReasoningLevel;
  /** Request `reasoning` for a level, with the same mapping that built `requestBase.reasoning`. */
  resolveReasoning: (level: ReasoningLevel) => LlmRequest['reasoning'];
  onRecovery?: (info: {
    turnIndex: number;
    cause: LengthRecoveryCause;
    fromLevel: ReasoningLevel;
    toLevel: ReasoningLevel;
    /** 1 for the first recovery retry of the turn. */
    recovery: number;
  }) => void;
}

function isCutOffToolArgsError(error: LlmProviderError): boolean {
  return error.code === 'provider.invalid_tool_args' && isOutputLimitFinishReason(error.finishReason);
}

function detectLengthCutOff(result: LlmResult): LengthRecoveryCause | undefined {
  if (!result.ok) {
    return isCutOffToolArgsError(result.error) ? 'invalid_tool_args' : undefined;
  }
  const { data } = result;
  const empty = data.toolCalls.length === 0 && stripReasoningContent(data.content).trim() === '';
  return empty && isOutputLimitFinishReason(data.finishReason) ? 'empty_reply' : undefined;
}

/**
 * Tool results that must survive stale-result truncation. These return durable
 * instructions / schemas / full documents / a full-text escape-hatch message that the
 * agent re-reads and acts on across a long tool loop; silently slicing them corrupts
 * the agent's behaviour. Every other tool result is transient data that stays truncatable.
 */
export const DURABLE_TOOL_NAMES = new Set<string>([
  'read_skill',
  'load_skill',
  'read_app_docs',
  'get_schema',
  'read_agent_document',
  'get_message',
]);

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
    /** True when a nudge or a length-recovery retry follows this turn, so the run is not over. */
    continues: boolean;
  }) => Promise<void> | void;
  /**
   * Called when a turn has no tool calls, before the loop ends. Returning a nudge keeps the run going:
   * the loop adds the model's reply and then the nudge as a user message, and calls the model again.
   * Never called on the last allowed turn, and a nudge uses up a turn.
   */
  onNoToolCalls?: (info: {
    turnIndex: number;
    assistantResponse: string;
    nudgesUsed: number;
  }) => { nudge: string } | undefined;
  /**
   * Checked once after all tool calls of a turn have run and their results are stored.
   * Returning true ends the run right away, with no further model call.
   */
  shouldStopAfterToolResults?: () => boolean;
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
  /** Called when a stale tool result is truncated, so callers can log/meter it. */
  onToolResultTruncated?: (info: {
    turnIndex: number;
    toolName: string | undefined;
    toolCallId: string;
    originalChars: number;
    retainedChars: number;
    ageTurns: number;
  }) => void;
  onBeforeTurn?: (info: { turnIndex: number; turnsRemaining: number }) =>
    | string
    | {
        message?: string;
        toolChoice?: LlmRequest['toolChoice'];
      }
    | undefined;
  /**
   * Text sent to the model as a final `user` message for this turn's request only. Unlike an
   * `onBeforeTurn` message it is never stored in the message list, so it adds nothing to the
   * history that later turns resend. Return undefined to send nothing for the turn.
   */
  getTurnContext?: (info: { turnIndex: number }) => string | undefined;
  /**
   * Retry a call cut off at the output limit (cut-off tool-call JSON, or an empty reply) with one reasoning level
   * lower and LENGTH_RECOVERY_HINT, instead of resending the same request. Omit to keep the normal retry.
   */
  lengthRecovery?: LengthRecoveryOptions;
  /** After this many retention turns, truncate older tool results to maxStaleChars. Omit to disable. */
  toolResultFullRetentionTurns?: number;
  /** Max chars to keep in a stale tool result (appends '...[cut: kept N of M chars]'). */
  toolResultMaxStaleChars?: number;
  /** Optional re-read hint added to the cut marker of a stale result (for example how to read the file again). */
  describeCutResult?: (info: {
    toolName: string | undefined;
    args: Record<string, unknown>;
    originalContent: string;
  }) => string | undefined;
}

const cutNumberFormat = new Intl.NumberFormat('en-US');

/** `...[cut: kept 1,000 of 10,119 chars]`, with an optional hint after the sizes. */
function formatCutMarker(keptChars: number, originalChars: number, hint: string | undefined): string {
  const sizes = `kept ${cutNumberFormat.format(keptChars)} of ${cutNumberFormat.format(originalChars)} chars`;
  return hint ? `...[cut: ${sizes}. ${hint}]` : `...[cut: ${sizes}]`;
}

export interface StructuredToolLoopSuccess {
  ok: true;
  assistantResponse: string;
  toolCalls: LlmToolCall[];
  turnsUsed: number;
  terminatedByLimit: boolean;
  /** Number of nudges sent. Absent means 0. */
  nudgesUsed?: number;
  /** Why the loop ended. Absent means the model ended it with no tool calls. */
  endedBy?: 'no_tool_calls' | 'terminal_tool' | 'turn_limit';
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
  let nudgesUsed = 0;
  let lastNonEmptyResponse = '';
  const continuationOptionsGiven = options.onNoToolCalls !== undefined || options.shouldStopAfterToolResults !== undefined;
  // Without continuation options the result keeps its old meaning (the final turn's text, even if empty).
  // Reported only when a continuation option is given, so results are unchanged for other callers.
  const continuationFields = (endedBy: NonNullable<StructuredToolLoopSuccess['endedBy']>) =>
    continuationOptionsGiven ? { nudgesUsed, endedBy } : {};
  // Fallback to the last non-empty text only when the continuation features changed how the run ended
  // (a nudge was sent, or a terminal tool ended it, so the last turn is often a bare tool call).
  // Otherwise the final turn's text is returned as is, even if empty.
  const finalText = (text: string, endedBy: NonNullable<StructuredToolLoopSuccess['endedBy']>): string =>
    text === '' && (nudgesUsed > 0 || endedBy === 'terminal_tool') ? lastNonEmptyResponse : text;

  // Tracks tool messages that have already been stale-truncated so each is
  // truncated (and reported via onToolResultTruncated) AT MOST ONCE. Without
  // this guard the post-truncation content (maxStaleChars + the '...[cut: ...]' marker)
  // stays longer than maxStaleChars, so the message would re-enter the block
  // every subsequent turn, re-firing the observability callback and redoing work.
  const truncatedToolMessages = new WeakSet<LlmMessage>();
  // Call args by tool call id, so a cut result can still name the path/URL it came from.
  const toolCallArgsById = new Map<string, Record<string, unknown>>();

  for (let turnIndex = 0; turnIndex < options.maxTurns; turnIndex++) {
    // Truncate tool results from turns older than retentionTurns.
    // A result at exactly the retention boundary (age === retentionTurns) is
    // still within the full-retention window and should NOT be truncated yet.
    if (options.toolResultFullRetentionTurns !== undefined && options.toolResultMaxStaleChars !== undefined) {
      for (const msg of messages) {
        if (
          msg.role === 'tool' &&
          msg.pinned !== true &&
          msg.addedAtTurn !== undefined &&
          !truncatedToolMessages.has(msg)
        ) {
          const age = turnIndex - msg.addedAtTurn;
          if (age > options.toolResultFullRetentionTurns && msg.content.length > options.toolResultMaxStaleChars) {
            const originalChars = msg.content.length;
            const hint = options.describeCutResult?.({
              toolName: msg.toolName,
              args: toolCallArgsById.get(msg.toolCallId) ?? {},
              originalContent: msg.content,
            });
            msg.content =
              msg.content.slice(0, options.toolResultMaxStaleChars) +
              formatCutMarker(options.toolResultMaxStaleChars, originalChars, hint);
            truncatedToolMessages.add(msg);
            // Notify callers so the previously-silent truncation is observable
            // (bug 002) and context pressure is meterable per tick (lesson #9).
            options.onToolResultTruncated?.({
              turnIndex,
              toolName: msg.toolName,
              toolCallId: msg.toolCallId,
              originalChars,
              // Retained original-content length (= toolResultMaxStaleChars), EXCLUDING the
              // appended '...[cut: ...]' marker — do not treat this as the final stored message length.
              retainedChars: options.toolResultMaxStaleChars,
              ageTurns: age,
            });
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
    const turnContext = options.getTurnContext?.({ turnIndex });
    const lengthRecovery = options.lengthRecovery !== undefined && options.lengthRecovery.maxRetries > 0
      ? options.lengthRecovery
      : undefined;
    // Set once a recovery retry starts: the lowered level for this turn's next request.
    let recoveryLevel: ReasoningLevel | undefined;
    let recoveries = 0;
    // Attempt numbers continue across recovery retries, so each failed attempt of the turn has its own number.
    let attemptOffset = 0;
    let turnResultWithRetry: LlmRetryResult;
    for (;;) {
      // One trailing volatile message: a second user message would split the prompt-cache boundary.
      const requestContext = recoveryLevel !== undefined
        ? [turnContext, LENGTH_RECOVERY_HINT].filter((part) => part !== undefined && part !== '').join('\n\n')
        : turnContext;
      const requestMessages: LlmMessage[] = requestContext
        ? [...messages, { role: 'user', content: requestContext, volatile: true }]
        : messages;
      const offset = attemptOffset;
      turnResultWithRetry = await callLlmWithRetry(
        options.providerConfig,
        {
          ...options.requestBase,
          ...(lengthRecovery && recoveryLevel !== undefined ? { reasoning: lengthRecovery.resolveReasoning(recoveryLevel) } : {}),
          messages: requestMessages,
          tools: activeTools,
          toolChoice: turnToolChoice,
        },
        {
          ...options.retryPolicy,
          onRetry: options.onRetry
            ? ({ attempt, delayMs, classification }) =>
              options.onRetry?.({ turnIndex, attempt: offset + attempt, delayMs, classification })
            : undefined,
          onAttemptFailed: options.onFailedAttempt
            ? ({ attempt, classification }) =>
              options.onFailedAttempt?.({ turnIndex, attempt: offset + attempt, classification })
            : undefined,
          // Resending a cut-off request repeats the cut-off; recovery replaces that retry, also once it is used up.
          ...(lengthRecovery ? { skipRetry: isCutOffToolArgsError } : {}),
        },
      );
      attemptOffset += turnResultWithRetry.attempts;
      if (lengthRecovery === undefined || recoveries >= lengthRecovery.maxRetries) break;
      const cause = detectLengthCutOff(turnResultWithRetry.result);
      if (cause === undefined) break;
      if (cause === 'empty_reply' && turnResultWithRetry.result.ok) {
        // Still a completed call: report it so its usage is recorded.
        await options.onAssistantTurn?.({
          turnIndex,
          result: turnResultWithRetry.result,
          assistantResponse: '',
          toolCalls: [],
          continues: true,
        });
      }
      const fromLevel = recoveryLevel ?? lengthRecovery.reasoningLevel;
      // Stop at `low`: `none` drops the reasoning parameter, and some providers then use their own, higher default.
      recoveryLevel = fromLevel === 'low' || fromLevel === 'none' ? fromLevel : lowerReasoningLevel(fromLevel);
      recoveries++;
      lengthRecovery.onRecovery?.({ turnIndex, cause, fromLevel, toLevel: recoveryLevel, recovery: recoveries });
    }

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
    if (assistantResponse !== '') {
      lastNonEmptyResponse = assistantResponse;
    }

    // A nudge on the last allowed turn would leave no turn to answer it and end the run as a turn-limit overrun.
    // An empty/whitespace reply is never nudged: the nudge path stores the reply as an assistant message,
    // and providers (e.g. Anthropic via toAnthropicMessages) can reject an empty assistant message.
    const nudge =
      toolCalls.length === 0 && assistantResponse.trim() !== '' && turnIndex < options.maxTurns - 1
        ? options.onNoToolCalls?.({ turnIndex, assistantResponse, nudgesUsed })
        : undefined;

    await options.onAssistantTurn?.({
      turnIndex,
      result: turnResultWithRetry.result,
      assistantResponse,
      toolCalls,
      continues: nudge !== undefined,
    });

    if (toolCalls.length === 0) {
      if (nudge) {
        // The reply goes first: providers can reject two user messages in a row.
        messages.push({ role: 'assistant', content: assistantResponse });
        messages.push({ role: 'user', content: nudge.nudge });
        nudgesUsed++;
        continue;
      }
      return {
        ok: true,
        assistantResponse: finalText(assistantResponse, 'no_tool_calls'),
        toolCalls,
        turnsUsed,
        terminatedByLimit: false,
        ...continuationFields('no_tool_calls'),
      };
    }

    messages.push({
      role: 'assistant',
      content: assistantResponse,
      toolCalls,
    });
    for (const toolCall of toolCalls) {
      toolCallArgsById.set(toolCall.id, toolCall.args);
    }

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
        pinned: DURABLE_TOOL_NAMES.has(toolCall.name),
      });
    }

    if (options.shouldStopAfterToolResults?.()) {
      return {
        ok: true,
        assistantResponse: finalText(assistantResponse, 'terminal_tool'),
        toolCalls,
        turnsUsed,
        terminatedByLimit: false,
        ...continuationFields('terminal_tool'),
      };
    }
  }

  return {
    ok: true,
    assistantResponse: finalText(lastAssistantResponse, 'turn_limit'),
    toolCalls: lastToolCalls,
    turnsUsed,
    terminatedByLimit: true,
    ...continuationFields('turn_limit'),
  };
}
