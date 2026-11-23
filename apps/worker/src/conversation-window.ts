import type { ConversationMessage } from '@herobids/domain';
import { parseDocumentNoticeText } from '@herobids/documents/agent-document-notice';

/** The class send_message sets on a message. */
export type MessageClass = 'routine' | 'alert' | 'reminder';

/** The class of a stored or published message. A missing or unknown value is routine. */
export function parseMessageClass(value: unknown): MessageClass {
  return value === 'alert' || value === 'reminder' ? value : 'routine';
}

/**
 * The Conversation window: the user's and the agent's messages, chronological, kept apart from the activity timeline
 * so that a shared, short timeline cannot evict the user's original request.
 */
export interface ConversationWindowEntry {
  /** The message id: a full UUID, or the 8-hex short form when the reply came from the send_message tool result. */
  id: string;
  kind: 'USER' | 'AGENT' | 'CHILD_REPORT';
  text: string;
  timestamp: number;
  /** The reporting agent's id and name, on a CHILD_REPORT entry. */
  fromAgentId?: string;
  fromAgentName?: string;
  /** The class the child sent the report with, on a CHILD_REPORT entry. */
  messageClass?: MessageClass;
}

/**
 * The first `maxChars` UTF-16 code units of `text`, without splitting a surrogate pair. `cut` is true when text was dropped.
 */
export function truncateText(text: string, maxChars: number): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false };
  let end = maxChars;
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

const HEAD_TAIL_SEPARATOR = ' … ';
/** Most of a cut message's budget stays at the head; the tail keeps the end, where a question usually is. */
const TAIL_MAX_CHARS = 150;

/**
 * Cuts `text` to about `maxChars` by keeping its beginning and its end, joined by an ellipsis. Both cuts fall on a word
 * boundary when one is near, and never split a surrogate pair. `cut` is true when text was dropped.
 */
export function truncateHeadTail(text: string, maxChars: number): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false };
  const tailLength = Math.min(TAIL_MAX_CHARS, Math.floor(maxChars * 0.3));
  const headLength = maxChars - tailLength - HEAD_TAIL_SEPARATOR.length;

  let headEnd = headLength;
  const lastWordBreak = text.slice(0, headLength).search(/\s\S*$/);
  if (lastWordBreak >= headLength * 0.8) headEnd = lastWordBreak;
  const lastHeadUnit = text.charCodeAt(headEnd - 1);
  if (lastHeadUnit >= 0xd800 && lastHeadUnit <= 0xdbff) headEnd -= 1;

  let tailStart = text.length - tailLength;
  const firstWordBreak = text.slice(tailStart, tailStart + tailLength).search(/\s/);
  if (firstWordBreak !== -1 && firstWordBreak <= tailLength * 0.2) tailStart += firstWordBreak;
  const firstTailUnit = text.charCodeAt(tailStart);
  if (firstTailUnit >= 0xdc00 && firstTailUnit <= 0xdfff) tailStart += 1;

  return { text: `${text.slice(0, headEnd).trimEnd()}${HEAD_TAIL_SEPARATOR}${text.slice(tailStart).trimStart()}`, cut: true };
}

/** Hard cap on the window, as a multiple of `maxMessages`: unanswered messages are only dropped beyond this. */
const UNANSWERED_CAP_MULTIPLIER = 3;

/** A USER entry the agent has not yet answered (newer than the answered marker). AGENT and CHILD_REPORT entries are never awaiting. */
export function isAwaitingEntry(entry: ConversationWindowEntry, answeredUpToTs: number | null): boolean {
  return entry.kind === 'USER' && (answeredUpToTs === null || entry.timestamp > answeredUpToTs);
}

export interface TrimmedConversationWindow {
  entries: ConversationWindowEntry[];
  /** True when at least one entry was dropped. */
  evicted: boolean;
}

/**
 * Keeps the window within `maxMessages`. Answered entries go first, oldest first; awaiting USER entries are kept until
 * the hard cap (`UNANSWERED_CAP_MULTIPLIER * maxMessages`) is exceeded, so a pending question is never lost to a
 * burst of answered chatter.
 */
export function trimConversationWindow(
  entries: ConversationWindowEntry[],
  answeredUpToTs: number | null,
  maxMessages: number,
): TrimmedConversationWindow {
  let kept = entries;
  let evicted = false;

  while (kept.length > maxMessages) {
    const oldestAnswered = kept.findIndex((entry) => !isAwaitingEntry(entry, answeredUpToTs));
    if (oldestAnswered === -1) break;
    kept = kept.filter((_, index) => index !== oldestAnswered);
    evicted = true;
  }

  const hardCap = UNANSWERED_CAP_MULTIPLIER * maxMessages;
  if (kept.length > hardCap) {
    kept = kept.slice(kept.length - hardCap);
    evicted = true;
  }

  return { entries: kept, evicted };
}

/** The names of the agents that sent into a thread. An agent that is missing here (deleted, unknown) has no name. */
export type ThreadSenders = ReadonlyMap<string, { name: string }>;

/** The name a report is shown under when its sender cannot be resolved. */
export const UNKNOWN_AGENT_NAME = 'unknown agent';

/**
 * The window entry for a stored conversation row, as the live capture would have made it. The creator agent's message
 * is a USER entry (message_child_agent is the authority), the agent's own messages are AGENT entries, and platform rows
 * and the agent's failed or refused messages are skipped. Every other agent-sent row is a CHILD_REPORT entry, named from
 * `senders` or as an unknown agent, with the class the row was stored with, so no agent's text is ever presented as the user's.
 */
export function windowEntryFromConversationRow(
  row: Pick<ConversationMessage, 'id' | 'senderType' | 'senderId' | 'body' | 'createdAt' | 'queuedAt' | 'deliveryStatus'> & { messageClass?: ConversationMessage['messageClass'] },
  agentId: string,
  senders: ThreadSenders = new Map(),
  creatorAgentId: string | null = null,
): ConversationWindowEntry | null {
  // Platform rows, and any row that never reached its recipient (failed, or refused by the peer switch), are not history.
  if (row.senderType === 'platform' || row.deliveryStatus === 'failed' || row.deliveryStatus === 'refused') return null;
  if (row.senderType === 'agent' && row.senderId === agentId) {
    return { id: row.id, kind: 'AGENT', text: row.body, timestamp: row.createdAt.getTime() };
  }
  if (row.senderType === 'agent' && (row.senderId === null || row.senderId !== creatorAgentId)) {
    const fromAgentName = row.senderId === null ? undefined : senders.get(row.senderId)?.name;
    return {
      id: row.id,
      kind: 'CHILD_REPORT',
      text: row.body,
      timestamp: row.createdAt.getTime(),
      fromAgentId: row.senderId ?? undefined,
      fromAgentName: fromAgentName ?? UNKNOWN_AGENT_NAME,
      messageClass: parseMessageClass(row.messageClass),
    };
  }
  // A user message is timed by when it became deliverable, the same value its envelope carries to live capture.
  return { id: row.id, kind: 'USER', text: row.body, timestamp: row.queuedAt.getTime() };
}


/** The `queuedAt` a user-message envelope carries (ms), or null when it has none or it is not a date. */
export function userMessageQueuedAt(message: Record<string, unknown>): number | null {
  const value = message['queuedAt'];
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The short ref of the message the send_message tool queued, read from its result; null when the result has none. */
export function sentMessageRefFromToolResult(toolResult: string): string | null {
  try {
    const parsed = JSON.parse(toolResult) as { messageId?: unknown };
    return typeof parsed.messageId === 'string' && /^[0-9a-f]{8}$/.test(parsed.messageId) ? parsed.messageId : null;
  } catch {
    return null;
  }
}

/**
 * Text to keep when the window already holds a message and the stream delivers the same id again. A control-plane
 * upload stores only a short caption row, while its stream envelope carries the document id and the read tool pointer.
 * The notice wins, so the agent keeps the id. Anything else keeps the stored text.
 */
export function preferDocumentNoticeText(storedText: string, liveText: string): string {
  return parseDocumentNoticeText(liveText) && !parseDocumentNoticeText(storedText) ? liveText : storedText;
}

/**
 * The window after a message arrives whose id the window may already hold, or null when the id is new (the caller
 * appends it). For a known id the stored entry stays, with its text upgraded by `preferDocumentNoticeText`. Returns a
 * new array and never mutates `entries`.
 */
export function mergeKnownEntry(entries: ConversationWindowEntry[], entry: ConversationWindowEntry): ConversationWindowEntry[] | null {
  if (!entries.some((existing) => existing.id === entry.id)) return null;
  return entries.map((existing) =>
    existing.id === entry.id ? { ...existing, text: preferDocumentNoticeText(existing.text, entry.text) } : existing,
  );
}
