import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Agent artifacts — metadata rows for non-authoritative audit artifacts produced during agent analysis.
 * Large artifact bodies are stored in object storage; this table holds metadata + location references.
 */
export const agentArtifacts = pgTable('agent_artifacts', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** Runtime session that produced this artifact */
  sessionId: text('session_id').notNull(),
  /** Artifact type: tool_trace, web_fetch, code_exec_summary, prompt_summary */
  artifactType: text('artifact_type').notNull(),
  /** MIME-style content descriptor */
  contentType: text('content_type').notNull(),
  /** Human-readable summary */
  summary: text('summary').notNull(),
  /** Reference to stored large-body content (bucket, key, etc.) */
  location: jsonb('location').$type<{ bucket?: string; key?: string; url?: string } | null>(),
  /** Optional extra metadata */
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  /** Retention class for cleanup policy: ephemeral, standard, permanent */
  retentionClass: text('retention_class').notNull().default('standard'),
  /** Expiry timestamp (null = no auto-expiry) */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_artifacts_agent_id').on(t.agentId),
  index('idx_agent_artifacts_session_id').on(t.sessionId),
  index('idx_agent_artifacts_artifact_type').on(t.artifactType),
  index('idx_agent_artifacts_created_at').on(t.createdAt),
]);
