import { z } from 'zod';
import type { AgentTool, DomainError, ThreadEntry, ToolContext, ToolResult } from '@herobids/domain';
import { parseMessageRef } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { truncateText } from '../conversation-window.js';

export const THREAD_DEFAULT_PAGE_SIZE = 5;
export const THREAD_MAX_PAGE_SIZE = 10;
/** Total characters of one get_thread result. The oldest messages are dropped first when a page exceeds it. */
export const THREAD_OUTPUT_BUDGET_CHARS = 6000;
/** Longest body get_thread returns; the rest is available through get_message. */
export const THREAD_BODY_MAX_CHARS = 1500;

const HISTORY_NOTE = 'These messages are history. Do not re-run an old request unless the user asks for it again or it is still pending.';

const GetThreadParamsSchema = z.object({
  before: z.string().trim().min(1).max(64).optional().describe('A message id: return messages older than it'),
  limit: z.number().int().min(1).max(THREAD_MAX_PAGE_SIZE).optional().describe(`Messages to return, 1 to ${THREAD_MAX_PAGE_SIZE} (default ${THREAD_DEFAULT_PAGE_SIZE})`),
}).strict();

const GetMessageParamsSchema = z.object({
  id: z.string().trim().min(1).max(64).describe('The message id: 8 characters, or the full id'),
}).strict();

export interface ThreadMessageView {
  id: string;
  sender: ThreadEntry['sender'];
  time: string;
  body: string;
  truncated?: true;
}

function toView(entry: ThreadEntry): ThreadMessageView {
  return { id: entry.ref, sender: entry.sender, time: entry.createdAt.toISOString(), body: entry.body };
}

/**
 * Caps each body, then drops the oldest messages until the page fits the budget. Returns the kept messages (oldest
 * first) and whether any were dropped.
 */
export function fitThreadPage(entries: ThreadEntry[], budgetChars = THREAD_OUTPUT_BUDGET_CHARS): { messages: ThreadMessageView[]; dropped: boolean } {
  let kept: ThreadMessageView[] = entries.map((entry) => {
    const view = toView(entry);
    return view.body.length > THREAD_BODY_MAX_CHARS
      ? { ...view, body: truncateText(view.body, THREAD_BODY_MAX_CHARS).text, truncated: true }
      : view;
  });
  let dropped = false;
  while (kept.length > 0 && JSON.stringify(kept).length > budgetChars) {
    kept = kept.slice(1);
    dropped = true;
  }
  return { messages: kept, dropped };
}

/** A domain failure as a tool result. An ambiguous id lists its full matches, so the model can name one. */
function domainErrorResult(error: DomainError): ToolResult {
  const matches = error.context?.['matches'];
  const message = Array.isArray(matches)
    ? `That id matches more than one message. Use one of the full ids: ${matches.join(', ')}`
    : error.message;
  return { success: false, error: message, errorCode: error.code, fault: false };
}

function unavailable(): ToolResult {
  return { success: false, error: 'Conversation history is not available in this context', errorCode: 'conversation.unavailable', fault: false };
}

const getThreadTool: AgentTool = {
  name: 'get_thread',
  description: 'Read earlier messages of your conversation with your user, oldest first. Pass before (a message id) to read messages older than it. Long bodies are cut (truncated: true); use get_message for the full text.',
  parametersSchema: GetThreadParamsSchema,
  parameters: convertZodToJsonSchema(GetThreadParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = GetThreadParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid get_thread parameters', errorCode: 'validation.invalid_payload', fault: false };
    }
    const { before, limit } = parsed.data;
    if (before !== undefined && parseMessageRef(before) === null) {
      return { success: false, error: 'before must be a message id: 8 characters or the full id', errorCode: 'validation.invalid_payload', fault: false };
    }
    if (!ctx.threadReader) return unavailable();

    const page = await ctx.threadReader.listPage({ ...(before !== undefined ? { before } : {}), limit: limit ?? THREAD_DEFAULT_PAGE_SIZE });
    if (!page.ok) return domainErrorResult(page.error);

    const fitted = fitThreadPage(page.data.messages);
    return {
      success: true,
      data: {
        messages: fitted.messages,
        hasMore: page.data.hasMore || fitted.dropped,
        nextBefore: fitted.messages[0]?.id ?? null,
        note: HISTORY_NOTE,
      },
    };
  },
};

const getMessageTool: AgentTool = {
  name: 'get_message',
  description: 'Read one message of your conversation with your user by its id (8 characters or the full id). Returns the full text, including a message that get_thread cut short.',
  parametersSchema: GetMessageParamsSchema,
  parameters: convertZodToJsonSchema(GetMessageParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = GetMessageParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid get_message parameters', errorCode: 'validation.invalid_payload', fault: false };
    }
    const ref = parseMessageRef(parsed.data.id);
    if (ref === null) {
      return { success: false, error: 'id must be a message id: 8 characters or the full id', errorCode: 'validation.invalid_payload', fault: false };
    }
    if (!ctx.threadReader) return unavailable();

    const found = await ctx.threadReader.getMessage(ref);
    if (!found.ok) return domainErrorResult(found.error);
    if (!found.data) {
      return { success: false, error: 'No message with that id in your conversation', errorCode: 'conversation.message_not_found', fault: false };
    }
    return { success: true, data: { message: toView(found.data), note: HISTORY_NOTE } };
  },
};

export const conversationReadTools: AgentTool[] = [
  getThreadTool,
  getMessageTool,
];
