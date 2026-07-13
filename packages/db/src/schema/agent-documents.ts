import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { users } from './users.js';

/**
 * Agent documents — user-uploaded files attached to agents for context injection.
 * Supports control-plane uploads (web UI/API) and Telegram-sourced files.
 * Original files are stored in object storage; extracted text is stored separately.
 */
export const agentDocuments = pgTable('agent_documents', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  /** Origin of the document: control_plane (web/API upload) or telegram */
  source: text('source').notNull(),
  /** Reference to the source entity (e.g. Telegram message ID). Null for control-plane uploads. */
  sourceRef: text('source_ref'),
  /** Original filename as provided by the user or source */
  originalFilename: text('original_filename').notNull(),
  /** MIME type of the original file */
  mimeType: text('mime_type').notNull(),
  /** Size of the original file in bytes */
  sizeBytes: integer('size_bytes').notNull(),
  /** Object storage key for the original file */
  originalStoreKey: text('original_store_key').notNull(),
  /** Object storage key for the extracted text. Null before extraction or if extraction is not needed. */
  extractedTextStoreKey: text('extracted_text_store_key'),
  /** Extraction status: not_needed (binary/media), ready (text extracted), failed */
  extractionStatus: text('extraction_status').notNull().default('not_needed'),
  /** Document lifecycle state */
  lifecycleState: text('lifecycle_state').notNull().default('staged'),
  /** Session that materialized this document (null when staged or deleted) */
  materializedSessionId: text('materialized_session_id'),
  /** Optional caption or prompt associated with the document */
  captionOrPrompt: text('caption_or_prompt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft-delete timestamp */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  index('idx_agent_documents_agent_id').on(t.agentId),
  index('idx_agent_documents_created_at').on(t.createdAt),
  index('idx_agent_documents_user_id').on(t.userId),
]);
