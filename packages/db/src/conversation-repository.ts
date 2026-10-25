import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  CONVERSATION_DELIVERY_FROM,
  CONVERSATION_ERROR_CODES,
  err,
  ok,
  type ConversationError,
  type ConversationMessage,
  type ConversationStore,
  type ListUserAgentThreadInput,
  type MarkConversationDeliveryInput,
  type FindConversationMessageInput,
  type RequeueUndeliveredMessageInput,
  type RecordUserAgentMessageInput,
  type RecordedConversationMessage,
  type Result,
  userAgentConversationId,
} from '@herobids/domain';
import type { Database } from './index.js';
import type { DatabaseTransaction } from './trading-profile-reconciliation-outbox-repository.js';
import { conversationMessages, conversationParticipants, conversations } from './schema/index.js';

type MessageRow = typeof conversationMessages.$inferSelect;

/** Lists the fields explicitly so a new column does not reach callers by default. */
export function toConversationMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderType: row.senderType,
    senderId: row.senderId,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    messageClass: row.messageClass,
    deliveryStatus: row.deliveryStatus,
    deliveryDetail: row.deliveryDetail,
    providerMessageId: row.providerMessageId,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
  };
}

function refusal(code: string, message: string): Result<never, ConversationError> {
  return err({ code, message });
}

function storeFailed(error: unknown): Result<never, ConversationError> {
  return err({
    code: CONVERSATION_ERROR_CODES.storeFailed,
    message: 'conversation_store_failed',
    context: { cause: error instanceof Error ? error.name : 'NonError' },
  });
}

/** Thrown inside the write transaction so Postgres rolls back everything it wrote, then mapped to a refusal. */
class OwnerMismatchRollback extends Error {}
class MessageIdConflictRollback extends Error {}

/** Postgres adapter for the conversation store port. Only ConversationService calls it. */
export class ConversationRepository implements ConversationStore {
  constructor(private readonly db: Database) {}

  async recordUserAgentMessage(input: RecordUserAgentMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>> {
    const { conversationId, ownerUserId, agentId, message } = input;
    try {
      return await this.db.transaction(async (tx) => {
        const findConversation = async () => {
          const [row] = await tx
            .select({ ownerUserId: conversations.ownerUserId })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);
          return row;
        };

        // The conversation exists after the first message, so the hot path reads and never writes here.
        let conversation = await findConversation();
        if (!conversation) {
          const [created] = await tx.insert(conversations).values({
            id: conversationId,
            kind: 'user_agent',
            ownerUserId,
            createdAt: message.createdAt,
          }).onConflictDoNothing().returning({ id: conversations.id });
          // Only the writer that created the conversation adds its participants. A losing writer may be a
          // different owner, and must not leave participant rows behind in someone else's thread.
          if (created) {
            await tx.insert(conversationParticipants).values([
              { conversationId, participantType: 'user', participantId: ownerUserId },
              { conversationId, participantType: 'agent', participantId: agentId },
            ]).onConflictDoNothing();
          }
          conversation = await findConversation();
          if (!conversation) throw new Error('conversation_missing_after_create');
        }
        // Throw rather than return: a returned refusal would commit whatever this transaction wrote.
        if (conversation.ownerUserId !== ownerUserId) throw new OwnerMismatchRollback();

        const [inserted] = await tx
          .insert(conversationMessages)
          .values({ ...message, conversationId, queuedAt: message.createdAt })
          .onConflictDoNothing({ target: conversationMessages.id })
          .returning();
        if (inserted) {
          await tx
            .update(conversations)
            .set({ lastMessageAt: message.createdAt })
            .where(and(
              eq(conversations.id, conversationId),
              or(isNull(conversations.lastMessageAt), lt(conversations.lastMessageAt, message.createdAt)),
            ));
          return ok({ message: toConversationMessage(inserted), created: true });
        }

        const [existing] = await tx
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.id, message.id))
          .limit(1);
        // A retry repeats the same id in the same thread from the same sender. Anything else must not read the row.
        if (
          !existing
          || existing.conversationId !== conversationId
          || existing.senderType !== message.senderType
          || existing.senderId !== message.senderId
        ) {
          // Throw, not return: a first write may have created the conversation above, and a returned refusal would commit it empty.
          throw new MessageIdConflictRollback();
        }
        return ok({ message: toConversationMessage(existing), created: false });
      });
    } catch (error) {
      if (error instanceof OwnerMismatchRollback) {
        return refusal(CONVERSATION_ERROR_CODES.ownerMismatch, 'conversation_owner_mismatch');
      }
      if (error instanceof MessageIdConflictRollback) {
        return refusal(CONVERSATION_ERROR_CODES.messageIdConflict, 'conversation_message_id_conflict');
      }
      return storeFailed(error);
    }
  }

  async markDelivery(input: MarkConversationDeliveryInput): Promise<Result<ConversationMessage, ConversationError>> {
    try {
      // One conditional update: the state check and the write cannot be separated by a concurrent mark.
      // Omitted fields are left out of SET, so a later mark never nulls a value an earlier one stored.
      const [updated] = await this.db
        .update(conversationMessages)
        .set({
          deliveryStatus: input.status,
          ...(input.detail !== null ? { deliveryDetail: input.detail } : {}),
          ...(input.providerMessageId !== null ? { providerMessageId: input.providerMessageId } : {}),
        })
        .where(and(
          eq(conversationMessages.id, input.messageId),
          eq(conversationMessages.deliveryStatus, CONVERSATION_DELIVERY_FROM),
        ))
        .returning();
      if (updated) return ok(toConversationMessage(updated));

      const [current] = await this.db
        .select({ deliveryStatus: conversationMessages.deliveryStatus })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, input.messageId))
        .limit(1);
      if (!current) return refusal(CONVERSATION_ERROR_CODES.messageNotFound, 'conversation_message_not_found');
      return err({
        code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition,
        message: 'invalid_delivery_transition',
        context: { from: current.deliveryStatus, to: input.status },
      });
    } catch (error) {
      return storeFailed(error);
    }
  }

  async requeueUndeliveredMessage(input: RequeueUndeliveredMessageInput): Promise<Result<ConversationMessage | null, ConversationError>> {
    try {
      // One conditional update claims the retry, and it restamps queued_at, so concurrent retries publish once:
      // the loser re-evaluates the WHERE after the winner commits and no longer sees a failed or stale row.
      // The sender and owner checks keep a guessed id from re-queuing another user's or agent's row.
      const [claimed] = await this.db
        .update(conversationMessages)
        .set({ deliveryStatus: 'queued', deliveryDetail: null, queuedAt: input.now })
        .where(and(
          eq(conversationMessages.id, input.messageId),
          eq(conversationMessages.conversationId, input.conversationId),
          eq(conversationMessages.senderType, input.senderType),
          eq(conversationMessages.senderId, input.senderId),
          or(
            eq(conversationMessages.deliveryStatus, 'failed'),
            and(eq(conversationMessages.deliveryStatus, 'queued'), lte(conversationMessages.queuedAt, input.staleBefore)),
          ),
          sql`exists (select 1 from ${conversations} where ${conversations.id} = ${conversationMessages.conversationId} and ${conversations.ownerUserId} = ${input.ownerUserId})`,
        ))
        .returning();
      return ok(claimed ? toConversationMessage(claimed) : null);
    } catch (error) {
      return storeFailed(error);
    }
  }

  async findMessage(input: FindConversationMessageInput): Promise<Result<ConversationMessage | null, ConversationError>> {
    try {
      const [row] = await this.db
        .select({ message: conversationMessages })
        .from(conversationMessages)
        .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
        .where(and(
          eq(conversationMessages.id, input.messageId),
          eq(conversationMessages.conversationId, input.conversationId),
          eq(conversationMessages.senderType, input.senderType),
          input.senderId === null ? isNull(conversationMessages.senderId) : eq(conversationMessages.senderId, input.senderId),
          eq(conversations.ownerUserId, input.ownerUserId),
        ))
        .limit(1);
      return ok(row ? toConversationMessage(row.message) : null);
    } catch (error) {
      return storeFailed(error);
    }
  }

  async listUserAgentThread(input: ListUserAgentThreadInput): Promise<Result<ConversationMessage[], ConversationError>> {
    try {
      const rows = await this.db
        .select({ message: conversationMessages })
        .from(conversationMessages)
        .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
        .where(and(
          eq(conversationMessages.conversationId, input.conversationId),
          eq(conversations.ownerUserId, input.ownerUserId),
          // Row comparison matches the (created_at desc, id desc) order, so rows sharing a timestamp are not skipped.
          input.before && input.beforeId !== null
            ? sql`(${conversationMessages.createdAt}, ${conversationMessages.id}) < (${input.before.toISOString()}::timestamptz, ${input.beforeId})`
            : undefined,
        ))
        .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.id))
        .limit(input.limit);
      return ok(rows.reverse().map((row) => toConversationMessage(row.message)));
    } catch (error) {
      return storeFailed(error);
    }
  }
}

/**
 * Deletes the user-agent conversations of `agentIds`; participants and messages follow by cascade.
 * Participants carry no foreign key to agents, so agent deletion must call this in the same transaction.
 */
export async function deleteUserAgentConversations(executor: Database | DatabaseTransaction, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  await executor.delete(conversations).where(inArray(conversations.id, agentIds.map(userAgentConversationId)));
}
