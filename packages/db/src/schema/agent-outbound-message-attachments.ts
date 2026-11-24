import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

/**
 * One row per document attached to an outbound agent message.
 * Records each attachment's delivery outcome separately from the message text. No foreign keys:
 * the audit trail must outlive the documents and agents it references.
 */
export const agentOutboundMessageAttachments = pgTable('agent_outbound_message_attachments', {
  id: text('id').primaryKey(),
  /** agent_messages.message_id (the envelope messageId) of the send. No FK: the audit row must outlive it. */
  outboundMessageId: text('outbound_message_id').notNull(),
  /** Sender's agent_documents.id */
  sourceDocumentId: text('source_document_id').notNull(),
  /** Human channel (telegram | email) or agent recipient. Typed in code only; no DB enum/CHECK. */
  recipientKind: text('recipient_kind', { enum: ['telegram', 'email', 'agent'] }).notNull(),
  /** Recipient agent id when recipientKind = 'agent'; null otherwise */
  recipientAgentId: text('recipient_agent_id'),
  /** Recipient's new agent_documents.id when recipientKind = 'agent' */
  copiedDocumentId: text('copied_document_id'),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  /** pending | sent | failed | skipped. Typed in code only; no DB enum/CHECK. */
  deliveryStatus: text('delivery_status', { enum: ['pending', 'sent', 'failed', 'skipped'] }).notNull(),
  /** Channel-returned id (e.g. Telegram message id, SES message id) when sent */
  deliveryRef: text('delivery_ref'),
  /** Failure detail when deliveryStatus = 'failed' */
  deliveryError: text('delivery_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_outbound_message_attachments_message_id').on(t.outboundMessageId),
]);
