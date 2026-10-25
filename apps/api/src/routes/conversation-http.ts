import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '@herobids/db';
import { ConversationRepository } from '@herobids/db';
import {
  CONVERSATION_ERROR_CODES,
  ConversationService,
  MessagingConversationsSchema,
  type ConversationError,
  type ConversationLimits,
  type ConversationMessage,
} from '@herobids/domain';

/** The service the routes call, with the limits that configured it (the body schema needs the length cap). */
export interface ConversationRouteDeps {
  service: ConversationService;
  limits: ConversationLimits;
}

export function createConversationRouteDeps(
  db: Database,
  limits: ConversationLimits = MessagingConversationsSchema.parse(undefined),
): ConversationRouteDeps {
  return {
    service: new ConversationService({ store: new ConversationRepository(db), limits, newId: randomUUID, now: () => new Date() }),
    limits,
  };
}

/** The web client mints one UUID per message; the server uses it as the row id (002 D5). */
export const ClientMessageIdSchema = z.string().uuid();

export function buildSendMessageSchema(maxChars: number) {
  return z.object({
    message: z.string().min(1).max(maxChars),
    clientMessageId: ClientMessageIdSchema.optional(),
  });
}

export const ConversationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  before: z.string().min(1).max(512).optional(),
});

const CursorPayloadSchema = z.object({
  t: z.string().datetime(),
  i: z.string().min(1).max(128),
});

export interface ConversationCursor {
  before: Date;
  beforeId: string;
}

/** Opaque keyset cursor: the (createdAt, id) of the oldest row of the page. */
export function encodeConversationCursor(message: Pick<ConversationMessage, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ t: message.createdAt.toISOString(), i: message.id })).toString('base64url');
}

export function decodeConversationCursor(raw: string): ConversationCursor | null {
  try {
    const parsed = CursorPayloadSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (!parsed.success) return null;
    return { before: new Date(parsed.data.t), beforeId: parsed.data.i };
  } catch {
    return null;
  }
}

/**
 * Explicit fields only: delivery detail and provider ids stay server-side. `stuck` marks a `queued` row old
 * enough that its publish is presumed lost, so the web can offer Retry (the same-id retry re-publishes it).
 */
export function toConversationResponse(message: ConversationMessage, stuck: boolean) {
  return {
    id: message.id,
    senderType: message.senderType,
    senderId: message.senderId,
    channel: message.channel,
    subject: message.subject,
    body: message.body,
    messageClass: message.messageClass,
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt.toISOString(),
    stuck,
  };
}

/**
 * A message of an agent-to-agent thread. `senderId` is the sending agent. A refused message carries its reason code
 * (`peer.paused`, `peer.rate_limited`, ...) so the owner can see why it did not reach the recipient.
 */
export function toPeerMessageResponse(message: ConversationMessage) {
  return {
    ...toConversationResponse(message, false),
    refusalReason: message.deliveryStatus === 'refused' ? message.deliveryDetail : null,
  };
}

export interface ConversationHttpError {
  status: number;
  body: { error: string; message?: string };
}

/** Maps a conversation error to the response. Anything unexpected fails closed as a 503. */
export function conversationErrorResponse(error: ConversationError): ConversationHttpError {
  switch (error.code) {
    case CONVERSATION_ERROR_CODES.invalidMessage:
    case CONVERSATION_ERROR_CODES.bodyTooLong:
    case CONVERSATION_ERROR_CODES.invalidCursor:
      return { status: 400, body: { error: 'validation_error', message: error.message } };
    case CONVERSATION_ERROR_CODES.messageIdConflict:
      return { status: 409, body: { error: 'message_id_conflict', message: 'That message id is already used.' } };
    case CONVERSATION_ERROR_CODES.ownerMismatch:
      return { status: 404, body: { error: 'not_found' } };
    default:
      return { status: 503, body: { error: 'conversation_unavailable', message: 'The conversation is temporarily unavailable. Retry shortly.' } };
  }
}
