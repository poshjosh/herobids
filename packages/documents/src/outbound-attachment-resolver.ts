import { randomUUID } from 'node:crypto';
import { ok, err } from '@herobids/domain';
import type { DocumentStore, DomainError, Result } from '@herobids/domain';
import type { ExtractionStatus, InsertAgentDocument } from '@herobids/db';
import { sanitizeFilename } from './agent-document-service.js';

// TODO: Move to operator config alongside the upload limits.
const MAX_OUTBOUND_DOCUMENTS = 3;
const MAX_OUTBOUND_TOTAL_BYTES = 5 * 1_048_576; // 5 MiB, checked on recorded sizes before any blob is read

export interface AttachmentResolveError extends DomainError {
  code:
    | 'outbound_attachment.too_many'
    | 'outbound_attachment.duplicate'
    | 'outbound_attachment.not_found'
    | 'outbound_attachment.too_large'
    | 'outbound_attachment.lookup_failed'
    | 'outbound_attachment.read_failed'
    | 'outbound_attachment.copy_failed';
}

/** The document columns the resolver needs. Matches a row from `AgentDocumentsRepository.getById`. */
export interface OutboundDocumentRow {
  id: string;
  agentId: string;
  userId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  originalStoreKey: string;
  extractedTextStoreKey: string | null;
  extractionStatus: string;
}

export interface OutboundDocumentRepository {
  getById(id: string): Promise<OutboundDocumentRow | null>;
  create(input: InsertAgentDocument): Promise<string>;
  hardDelete(documentId: string): Promise<void>;
}

/** An original document read for sending. Carries the bytes, so it is never persisted as-is. */
export interface ResolvedAttachment {
  documentId: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  body: Buffer;
  storeKey: string;
  extractedTextStoreKey: string | null;
  extractionStatus: ExtractionStatus;
}

export interface CopiedDocument {
  /** Id of the new record in the recipient agent's store. */
  documentId: string;
  sourceDocumentId: string;
  agentId: string;
  originalStoreKey: string;
  extractedTextStoreKey: string | null;
}

export class OutboundAttachmentResolver {
  constructor(
    private readonly store: DocumentStore,
    private readonly repo: OutboundDocumentRepository,
  ) {}

  /**
   * Reads the requested documents for a human recipient or as the source of an agent copy.
   * Writes nothing. Every id must belong to the sender; a missing or foreign id fails the whole call.
   */
  async resolveForAgent(agentId: string, documentIds: string[]): Promise<Result<ResolvedAttachment[], AttachmentResolveError>> {
    if (documentIds.length > MAX_OUTBOUND_DOCUMENTS) {
      return err({
        code: 'outbound_attachment.too_many',
        message: `A message can attach at most ${MAX_OUTBOUND_DOCUMENTS} documents.`,
        context: { count: documentIds.length, maxCount: MAX_OUTBOUND_DOCUMENTS },
      });
    }
    if (new Set(documentIds).size !== documentIds.length) {
      return err({
        code: 'outbound_attachment.duplicate',
        message: 'Each document can be attached to a message only once.',
        context: { documentIds },
      });
    }

    const rows: OutboundDocumentRow[] = [];
    for (const documentId of documentIds) {
      let row: OutboundDocumentRow | null;
      try {
        row = await this.repo.getById(documentId);
      } catch (error) {
        return err({
          code: 'outbound_attachment.lookup_failed',
          message: `Failed to look up document ${documentId}: ${(error as Error).message}`,
          context: { documentId },
        });
      }
      // Foreign documents read as missing, the same rule the read path uses, so ids cannot be probed across agents.
      if (!row || row.agentId !== agentId) {
        return err({
          code: 'outbound_attachment.not_found',
          message: `Document ${documentId} not found.`,
          context: { documentId },
        });
      }
      rows.push(row);
    }

    const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
    if (totalBytes > MAX_OUTBOUND_TOTAL_BYTES) {
      return err({
        code: 'outbound_attachment.too_large',
        message: `Attached documents total ${totalBytes} bytes, above the ${MAX_OUTBOUND_TOTAL_BYTES} byte limit.`,
        context: { totalBytes, maxBytes: MAX_OUTBOUND_TOTAL_BYTES },
      });
    }

    const resolved: ResolvedAttachment[] = [];
    for (const row of rows) {
      const read = await this.store.read(row.originalStoreKey);
      if (!read.ok) {
        return err({
          code: 'outbound_attachment.read_failed',
          message: `Document ${row.id} could not be read.`,
          context: { documentId: row.id },
        });
      }
      resolved.push({
        documentId: row.id,
        userId: row.userId,
        filename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        body: read.data,
        storeKey: row.originalStoreKey,
        extractedTextStoreKey: row.extractedTextStoreKey,
        extractionStatus: toExtractionStatus(row.extractionStatus),
      });
    }
    return ok(resolved);
  }

  /**
   * Creates an independent copy of a resolved document in the recipient agent's store. The copy has
   * its own blobs, so deleting the sender's document later does not affect it.
   */
  async copyToAgent(resolved: ResolvedAttachment, recipientAgentId: string): Promise<Result<CopiedDocument, AttachmentResolveError>> {
    const documentId = randomUUID();
    const writtenKeys: string[] = [];
    const fail = async (message: string): Promise<Result<never, AttachmentResolveError>> => {
      await this.discard(writtenKeys);
      return err({
        code: 'outbound_attachment.copy_failed',
        message,
        context: { sourceDocumentId: resolved.documentId, recipientAgentId },
      });
    };

    const original = await this.store.put({
      keyHint: `${documentId}/${sanitizeFilename(resolved.filename)}`,
      contentType: resolved.mimeType,
      body: resolved.body,
    });
    if (!original.ok) return fail(original.error.message);
    writtenKeys.push(original.data.storeKey);

    let extractedTextStoreKey: string | null = null;
    if (resolved.extractedTextStoreKey) {
      const text = await this.store.read(resolved.extractedTextStoreKey);
      if (!text.ok) return fail(text.error.message);
      const copiedText = await this.store.put({
        keyHint: `${documentId}/extracted.txt`,
        contentType: 'text/plain; charset=utf-8',
        body: text.data,
      });
      if (!copiedText.ok) return fail(copiedText.error.message);
      extractedTextStoreKey = copiedText.data.storeKey;
      writtenKeys.push(extractedTextStoreKey);
    }

    try {
      await this.repo.create({
        id: documentId,
        agentId: recipientAgentId,
        userId: resolved.userId,
        source: 'agent',
        sourceRef: null,
        sourceDocumentId: resolved.documentId,
        originalFilename: resolved.filename,
        mimeType: resolved.mimeType,
        sizeBytes: resolved.sizeBytes,
        originalStoreKey: original.data.storeKey,
        extractedTextStoreKey,
        extractionStatus: extractedTextStoreKey ? 'ready' : resolved.extractionStatus,
        lifecycleState: 'staged',
        captionOrPrompt: null,
      });
    } catch (error) {
      const message = `Failed to record copied document: ${(error as Error).message}`;
      // create may have committed before throwing. Drop the row before the blobs go, so it never points at deleted bytes.
      try {
        await this.repo.hardDelete(documentId);
      } catch (cleanupError) {
        // The row may still exist, so its blobs must stay. Leaked blobs are preferable to a listed row with no bytes.
        console.warn(`[copyToAgent] Failed to remove document row ${documentId} after a failed create: ${(cleanupError as Error).message}`);
        return err({
          code: 'outbound_attachment.copy_failed',
          message,
          context: { sourceDocumentId: resolved.documentId, recipientAgentId, orphanedDocumentId: documentId },
        });
      }
      return fail(message);
    }

    return ok({
      documentId,
      sourceDocumentId: resolved.documentId,
      agentId: recipientAgentId,
      originalStoreKey: original.data.storeKey,
      extractedTextStoreKey,
    });
  }

  private async discard(storeKeys: string[]): Promise<void> {
    // Best-effort: a leftover blob is harmless, and the caller already has a failure to report.
    await Promise.all(storeKeys.map((key) => this.store.delete(key)));
  }
}

/** A failed extraction stays failed on the copy; anything else without extracted text is not needed. */
function toExtractionStatus(status: string): ExtractionStatus {
  return status === 'ready' || status === 'failed' ? status : 'not_needed';
}
