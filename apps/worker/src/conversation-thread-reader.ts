import { ok, shortMessageId, type ConversationMessage, type ConversationService, type ThreadEntry, type ThreadReader, type ThreadSender } from '@herobids/domain';

/**
 * The tools' read-only view of the agent's own user thread. Owner and agent are bound here, once, so a tool call
 * cannot name another user's or another agent's conversation.
 */
export function createThreadReader(deps: { service: ConversationService; ownerUserId: string; agentId: string }): ThreadReader {
  const toEntry = (row: ConversationMessage): ThreadEntry => ({
    ref: shortMessageId(row.id),
    sender: senderOf(row, deps.agentId),
    createdAt: row.createdAt,
    body: row.body,
  });

  return {
    async listPage(request) {
      const page = await deps.service.listThreadPage({
        ownerUserId: deps.ownerUserId,
        agentId: deps.agentId,
        limit: request.limit,
        ...(request.before !== undefined ? { before: request.before } : {}),
      });
      if (!page.ok) return page;
      return ok({ messages: page.data.messages.map(toEntry), hasMore: page.data.hasMore });
    },
    async getMessage(ref) {
      const found = await deps.service.getThreadMessage({ ownerUserId: deps.ownerUserId, agentId: deps.agentId, ref });
      if (!found.ok) return found;
      return ok(found.data ? toEntry(found.data) : null);
    },
  };
}

/** A creator agent's message reads as the user's, as it does in the Conversation window. */
function senderOf(row: ConversationMessage, agentId: string): ThreadSender {
  if (row.senderType === 'platform') return 'platform';
  if (row.senderType === 'agent' && row.senderId === agentId) return 'agent';
  return 'user';
}
