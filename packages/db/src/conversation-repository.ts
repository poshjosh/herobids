import { and, eq, inArray, isNull, lt, lte, or, sql, desc } from 'drizzle-orm';
import {
  CONVERSATION_DELIVERY_FROM,
  CONVERSATION_ERROR_CODES,
  err,
  ok,
  type ConversationError,
  type ConversationMessage,
  type ConversationStore,
  type ListPeerConversationsInput,
  type ListUserAgentThreadInput,
  type MarkConversationDeliveryInput,
  type FindConversationMessageInput,
  type RefuseDroppedPeerConversationMessageInput,
  type RequeueUndeliveredMessageInput,
  type PeerThreadSummary,
  type RecordPeerConversationMessageInput,
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

interface ConversationWrite {
  conversationId: string;
  kind: 'user_agent' | 'agent_agent';
  peerKey: string | null;
  ownerUserId: string;
  participants: Array<{ participantType: 'user' | 'agent'; participantId: string }>;
  message: RecordUserAgentMessageInput['message'];
}

/** Thrown inside the write transaction so Postgres rolls back everything it wrote, then mapped to a refusal. */
class OwnerMismatchRollback extends Error {}
class MessageIdConflictRollback extends Error {}

/** Postgres adapter for the conversation store port. Only ConversationService calls it. */
export class ConversationRepository implements ConversationStore {
  constructor(private readonly db: Database) {}

  async recordUserAgentMessage(input: RecordUserAgentMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>> {
    const { conversationId, ownerUserId, agentId, message } = input;
    return this.recordInConversation({
      conversationId,
      kind: 'user_agent',
      peerKey: null,
      ownerUserId,
      participants: [
        { participantType: 'user', participantId: ownerUserId },
        { participantType: 'agent', participantId: agentId },
      ],
      message,
    });
  }

  async recordPeerMessage(input: RecordPeerConversationMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>> {
    return this.recordInConversation({
      conversationId: input.conversationId,
      kind: 'agent_agent',
      peerKey: input.peerKey,
      ownerUserId: input.ownerUserId,
      participants: input.agentIds.map((participantId) => ({ participantType: 'agent', participantId })),
      message: input.message,
    });
  }

  async listPeerThreads(input: ListPeerConversationsInput): Promise<Result<PeerThreadSummary[], ConversationError>> {
    try {
      // Query 1: the owner's peer conversations that include the agent, newest first. Query 2: the participants of all of them.
      const threads = await this.db
        .select({ id: conversations.id, lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .innerJoin(conversationParticipants, and(
          eq(conversationParticipants.conversationId, conversations.id),
          eq(conversationParticipants.participantType, 'agent'),
          eq(conversationParticipants.participantId, input.agentId),
        ))
        .where(and(eq(conversations.ownerUserId, input.ownerUserId), eq(conversations.kind, 'agent_agent')))
        .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id))
        .limit(input.limit);
      if (threads.length === 0) return ok([]);

      const participants = await this.db
        .select({ conversationId: conversationParticipants.conversationId, participantId: conversationParticipants.participantId })
        .from(conversationParticipants)
        .where(and(
          inArray(conversationParticipants.conversationId, threads.map((thread) => thread.id)),
          eq(conversationParticipants.participantType, 'agent'),
        ));
      const peerByConversation = new Map<string, string>();
      for (const participant of participants) {
        if (participant.participantId !== input.agentId) peerByConversation.set(participant.conversationId, participant.participantId);
      }
      return ok(threads.flatMap((thread) => {
        const peerAgentId = peerByConversation.get(thread.id);
        return peerAgentId === undefined ? [] : [{ conversationId: thread.id, peerAgentId, lastMessageAt: thread.lastMessageAt }];
      }));
    } catch (error) {
      return storeFailed(error);
    }
  }

  private async recordInConversation(target: ConversationWrite): Promise<Result<RecordedConversationMessage, ConversationError>> {
    const { conversationId, ownerUserId, message } = target;
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
            kind: target.kind,
            peerKey: target.peerKey,
            ownerUserId,
            createdAt: message.createdAt,
          }).onConflictDoNothing().returning({ id: conversations.id });
          // Only the writer that created the conversation adds its participants. A losing writer may be a
          // different owner, and must not leave participant rows behind in someone else's thread.
          if (created) {
            await tx.insert(conversationParticipants).values(
              target.participants.map((participant) => ({ conversationId, ...participant })),
            ).onConflictDoNothing();
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
          ...(input.channel !== null ? { channel: input.channel } : {}),
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

  async refuseDroppedPeerMessage(input: RefuseDroppedPeerConversationMessageInput): Promise<Result<ConversationMessage | null, ConversationError>> {
    try {
      // One conditional update, scoped to the sender's own agent-authored row in the owner's peer conversation and to the two
      // states a delivered or in-flight message can be in. Anything else (another owner or sender, a final row) matches nothing.
      const [refused] = await this.db
        .update(conversationMessages)
        .set({ deliveryStatus: 'refused', deliveryDetail: input.detail })
        .where(and(
          eq(conversationMessages.id, input.messageId),
          eq(conversationMessages.conversationId, input.conversationId),
          eq(conversationMessages.senderType, 'agent'),
          eq(conversationMessages.senderId, input.senderId),
          inArray(conversationMessages.deliveryStatus, ['sent', 'queued']),
          sql`exists (select 1 from ${conversations} where ${conversations.id} = ${conversationMessages.conversationId} and ${conversations.ownerUserId} = ${input.ownerUserId} and ${conversations.kind} = 'agent_agent')`,
        ))
        .returning();
      return ok(refused ? toConversationMessage(refused) : null);
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
 * Deletes the user-agent conversations of `agentIds` and every peer conversation that includes one of them;
 * participants and messages follow by cascade. Participants carry no foreign key to agents, so agent deletion
 * must call this in the same transaction.
 */
export async function deleteUserAgentConversations(executor: Database | DatabaseTransaction, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  await executor.delete(conversations).where(inArray(conversations.id, agentIds.map(userAgentConversationId)));
  await executor.delete(conversations).where(and(
    eq(conversations.kind, 'agent_agent'),
    inArray(
      conversations.id,
      executor
        .select({ id: conversationParticipants.conversationId })
        .from(conversationParticipants)
        .where(and(eq(conversationParticipants.participantType, 'agent'), inArray(conversationParticipants.participantId, agentIds))),
    ),
  ));
}
