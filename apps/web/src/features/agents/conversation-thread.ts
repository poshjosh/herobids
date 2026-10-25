import type { AgentConversationMessage } from '../../lib/api-client.js';

/** A message the user sent from this page that the thread has not confirmed yet. */
export interface PendingSend {
  /** The client message id; the server uses it as the row id, so a retry is idempotent. */
  id: string;
  body: string;
  createdAt: string;
  status: 'sending' | 'failed';
}

/** Union by id (later lists win), oldest first, ties broken by id: the order the server pages in. */
export function mergeMessages(...lists: AgentConversationMessage[][]): AgentConversationMessage[] {
  const byId = new Map<string, AgentConversationMessage>();
  for (const list of lists) {
    for (const message of list) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => (
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.createdAt < b.createdAt ? -1 : 1)
  ));
}

function toLocalMessage(pending: PendingSend): AgentConversationMessage {
  return {
    id: pending.id,
    senderType: 'user',
    senderId: null,
    channel: 'web',
    subject: null,
    body: pending.body,
    messageClass: null,
    deliveryStatus: pending.status === 'sending' ? 'queued' : 'failed',
    createdAt: pending.createdAt,
  };
}

/**
 * The thread as shown: confirmed rows in order, with a retry in flight (or failed again) overriding a stored
 * `queued` or `failed` status in place, then unconfirmed local sends at the end in the order they were sent.
 * Any other stored status (sent, refused, not applicable) is the server's final word and is never overridden:
 * a failed local attempt whose message the server already delivered must not read as not sent.
 */
export function buildThread(history: AgentConversationMessage[], pending: PendingSend[]): AgentConversationMessage[] {
  const pendingById = new Map(pending.map((entry) => [entry.id, entry]));
  const known = new Set(history.map((message) => message.id));
  const confirmed = history.map((message) => {
    const entry = pendingById.get(message.id);
    const overridable = message.deliveryStatus === 'queued' || message.deliveryStatus === 'failed';
    // The local attempt decides the display, so a stuck flag from the stored row no longer applies.
    return entry && overridable ? { ...message, deliveryStatus: toLocalMessage(entry).deliveryStatus, stuck: false } : message;
  });
  return [...confirmed, ...pending.filter((entry) => !known.has(entry.id)).map(toLocalMessage)];
}
