import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentOutboundMessageAttachments } from './schema/index.js';

export type OutboundRecipientKind = 'telegram' | 'email' | 'agent';
export type OutboundAuditDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface NewOutboundAttachmentAudit {
  outboundMessageId: string;
  sourceDocumentId: string;
  recipientKind: OutboundRecipientKind;
  recipientAgentId: string | null;
  copiedDocumentId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export class OutboundAttachmentAuditRepository {
  constructor(private readonly db: Database) {}

  /** Inserts rows as pending and returns their ids in input order. */
  async recordPending(rows: NewOutboundAttachmentAudit[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const ids = rows.map(() => crypto.randomUUID());
    await this.db.insert(agentOutboundMessageAttachments).values(rows.map((row, index) => ({
      id: ids[index]!,
      outboundMessageId: row.outboundMessageId,
      sourceDocumentId: row.sourceDocumentId,
      recipientKind: row.recipientKind,
      recipientAgentId: row.recipientAgentId,
      copiedDocumentId: row.copiedDocumentId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      deliveryStatus: 'pending' as const,
    })));
    return ids;
  }

  async markDelivery(id: string, status: Exclude<OutboundAuditDeliveryStatus, 'pending'>, detail: { deliveryRef?: string; deliveryError?: string } = {}): Promise<void> {
    await this.db.update(agentOutboundMessageAttachments).set({
      deliveryStatus: status,
      deliveryRef: detail.deliveryRef ?? null,
      deliveryError: detail.deliveryError ?? null,
    }).where(eq(agentOutboundMessageAttachments.id, id));
  }
}
