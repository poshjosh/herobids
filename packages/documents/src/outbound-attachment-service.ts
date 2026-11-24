import { ok, err } from '@herobids/domain';
import type { DomainError, OutboundAttachmentPort, OutboundDeliveryStatus, OutboundCopy, OutboundFile, PrepareOutboundForHumanInput, Result, StageOutboundForAgentInput, StagedOutboundCopies } from '@herobids/domain';
import type { NewOutboundAttachmentAudit } from '@herobids/db';
import type { OutboundAttachmentResolver } from './outbound-attachment-resolver.js';
import { buildDocumentNoticeText } from './agent-document-notice.js';

/** The audit rows a send writes. Implemented by OutboundAttachmentAuditRepository. */
export interface OutboundAttachmentAuditStore {
  recordPending(rows: NewOutboundAttachmentAudit[]): Promise<string[]>;
  markDelivery(id: string, status: OutboundDeliveryStatus, detail?: { deliveryRef?: string; deliveryError?: string }): Promise<void>;
}

/**
 * Implements the outbound attachment port: resolves a send's documents, records their audit rows, and copies them for
 * an agent recipient. Each failure is a Result, and the send does not start unless the audit rows exist.
 */
export class OutboundAttachmentService implements OutboundAttachmentPort {
  constructor(
    private readonly resolver: OutboundAttachmentResolver,
    private readonly audit: OutboundAttachmentAuditStore,
  ) {}

  async prepareForHuman(input: PrepareOutboundForHumanInput): Promise<Result<OutboundFile[], DomainError>> {
    const resolved = await this.resolver.resolveForAgent(input.senderAgentId, input.documentIds);
    if (!resolved.ok) return err(resolved.error);

    let auditIds: string[];
    try {
      auditIds = await this.audit.recordPending(resolved.data.map((document) => ({
        outboundMessageId: input.outboundMessageId,
        sourceDocumentId: document.documentId,
        recipientKind: input.recipientKind,
        recipientAgentId: null,
        copiedDocumentId: null,
        filename: document.filename,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
      })));
    } catch (error) {
      return err(auditFailed(error));
    }

    return ok(resolved.data.map((document, index) => ({
      auditId: auditIds[index] ?? '',
      documentId: document.documentId,
      filename: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      body: document.body,
    })));
  }

  async stageForAgent(input: StageOutboundForAgentInput): Promise<Result<StagedOutboundCopies, DomainError>> {
    const resolved = await this.resolver.resolveForAgent(input.senderAgentId, input.documentIds);
    if (!resolved.ok) return err(resolved.error);

    const copied = await this.resolver.copyAllToAgent(resolved.data, input.recipientAgentId);
    if (!copied.ok) return err(copied.error);
    const copies = copied.data;

    let auditIds: string[];
    try {
      auditIds = await this.audit.recordPending(copies.map((copy, index) => ({
        outboundMessageId: input.outboundMessageId,
        sourceDocumentId: copy.sourceDocumentId,
        recipientKind: 'agent',
        recipientAgentId: input.recipientAgentId,
        copiedDocumentId: copy.documentId,
        filename: resolved.data[index]?.filename ?? '',
        mimeType: resolved.data[index]?.mimeType ?? '',
        sizeBytes: resolved.data[index]?.sizeBytes ?? 0,
      })));
    } catch (error) {
      await this.resolver.discardCopies(copies);
      return err(auditFailed(error));
    }

    const staged: OutboundCopy[] = copies.map((copy, index) => ({
      auditId: auditIds[index] ?? '',
      sourceDocumentId: copy.sourceDocumentId,
      copiedDocumentId: copy.documentId,
      filename: resolved.data[index]?.filename ?? '',
    }));
    return ok({
      copies: staged,
      notice: copies.map((copy, index) => buildDocumentNoticeText({ documentId: copy.documentId, filename: resolved.data[index]?.filename ?? '' })).join('\n\n'),
      rollback: async () => {
        await this.resolver.discardCopies(copies);
        await this.settle(auditIds, 'failed', { deliveryError: 'not_delivered' });
      },
    });
  }

  async markDelivery(auditId: string, status: OutboundDeliveryStatus, detail?: { deliveryRef?: string; deliveryError?: string }): Promise<Result<void, DomainError>> {
    try {
      await this.audit.markDelivery(auditId, status, detail);
      return ok(undefined);
    } catch (error) {
      return err(auditFailed(error));
    }
  }

  private async settle(auditIds: string[], status: OutboundDeliveryStatus, detail: { deliveryError: string }): Promise<void> {
    await Promise.allSettled(auditIds.map((id) => this.audit.markDelivery(id, status, detail)));
  }
}

function auditFailed(error: unknown): DomainError {
  return { code: 'outbound_attachment.audit_failed', message: error instanceof Error ? error.message : String(error) };
}
