import type { Result } from '../result.js';
import type { ConversationError } from './conversation.js';

/** Who wrote a message, as the agent sees it: the user (including a creator agent's message), the agent itself, or the platform. */
export type ThreadSender = 'user' | 'agent' | 'platform';

export interface ThreadEntry {
  /** The short (8-hex) message ref shown to the model. */
  ref: string;
  sender: ThreadSender;
  createdAt: Date;
  body: string;
}

export interface ThreadPageRequest {
  /** A message ref: return messages older than it. */
  before?: string;
  limit: number;
}

export interface ThreadPageView {
  /** Oldest first. */
  messages: ThreadEntry[];
  hasMore: boolean;
}

/**
 * Read-only view of the agent's own user thread, handed to the tools. Its owner and agent are bound when it is built,
 * so a tool call cannot name another user's or agent's conversation.
 */
export interface ThreadReader {
  listPage(request: ThreadPageRequest): Promise<Result<ThreadPageView, ConversationError>>;
  getMessage(ref: string): Promise<Result<ThreadEntry | null, ConversationError>>;
}
