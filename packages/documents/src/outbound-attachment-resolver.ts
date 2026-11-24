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

/** A requested document that could not be resolved for a human. The send goes ahead without it. */
export interface UnreadableAttachment {
  documentId: string;
  code: AttachmentResolveError['code'];
}

export interface ResolvedForHuman {
  readable: ResolvedAttachment[];
  unreadable: UnreadableAttachment[];
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
   * Reads the requested documents as the source of an agent copy. Writes nothing. Every id must belong to the sender;
   * a missing or foreign id fails the whole call.
   */
  async resolveForAgent(agentId: string, documentIds: string[]): Promise<Result<ResolvedAttachment[], AttachmentResolveError>> {
    const shapeError = checkSetShape(documentIds);
    if (shapeError) return err(shapeError);

    const rows: OutboundDocumentRow[] = [];
    for (const documentId of documentIds) {
      const row = await this.findOwnedDocument(agentId, documentId);
      if (!row.ok) return err(row.error);
      rows.push(row.data);
    }

    const sizeError = checkTotalBytes(rows);
    if (sizeError) return err(sizeError);

    const resolved: ResolvedAttachment[] = [];
    for (const row of rows) {
      const body = await this.readDocument(row);
      if (!body.ok) return err(body.error);
      resolved.push(toResolvedAttachment(row, body.data));
    }
    return ok(resolved);
  }

  /**
   * Reads the requested documents for a human recipient. A document that cannot be found, looked up or read is
   * reported in unreadable, and the others still resolve. The set-level rules still fail the whole call.
   */
  async resolveForHuman(agentId: string, documentIds: string[]): Promise<Result<ResolvedForHuman, AttachmentResolveError>> {
    const shapeError = checkSetShape(documentIds);
    if (shapeError) return err(shapeError);

    const found: OutboundDocumentRow[] = [];
    const unreadable: UnreadableAttachment[] = [];
    for (const documentId of documentIds) {
      const row = await this.findOwnedDocument(agentId, documentId);
      if (row.ok) found.push(row.data);
      else unreadable.push({ documentId, code: row.error.code });
    }

    const sizeError = checkTotalBytes(found);
    if (sizeError) return err(sizeError);

    const readable: ResolvedAttachment[] = [];
    for (const row of found) {
      const body = await this.readDocument(row);
      if (body.ok) readable.push(toResolvedAttachment(row, body.data));
      else unreadable.push({ documentId: row.id, code: body.error.code });
    }
    return ok({ readable, unreadable });
  }

  private async findOwnedDocument(agentId: string, documentId: string): Promise<Result<OutboundDocumentRow, AttachmentResolveError>> {
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
    return ok(row);
  }

  private async readDocument(row: OutboundDocumentRow): Promise<Result<Buffer, AttachmentResolveError>> {
    const readFailed = err<AttachmentResolveError>({
      code: 'outbound_attachment.read_failed',
      message: `Document ${row.id} could not be read.`,
      context: { documentId: row.id },
    });
    try {
      const read = await this.store.read(row.originalStoreKey);
      return read.ok ? ok(read.data) : readFailed;
    } catch {
      return readFailed;
    }
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
          context: { sourceDocumentId: resolved.documentId, recipientAgentId, orphanedDocumentId: documentId, orphanedStoreKeys: writtenKeys },
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

  /**
   * Creates copies for every resolved document, or none. A failed copy rolls back the earlier ones, and an orphaned
   * row from the failed copy is reclaimed here, so no row is left pointing at deleted blobs.
   */
  async copyAllToAgent(resolved: ResolvedAttachment[], recipientAgentId: string): Promise<Result<CopiedDocument[], AttachmentResolveError>> {
    const copies: CopiedDocument[] = [];
    for (const document of resolved) {
      const copy = await this.copyToAgent(document, recipientAgentId);
      if (copy.ok) {
        copies.push(copy.data);
        continue;
      }
      await this.discardCopies(copies);
      const orphanedDocumentId = copy.error.context?.['orphanedDocumentId'];
      const orphanedStoreKeys = copy.error.context?.['orphanedStoreKeys'];
      if (typeof orphanedDocumentId === 'string' && Array.isArray(orphanedStoreKeys)) {
        await this.removeCopyRecord(orphanedDocumentId, orphanedStoreKeys as string[]);
      }
      return copy;
    }
    return ok(copies);
  }

  /** Removes copies from the recipient's store. A copy's blobs go only after its row is gone, so no row points at deleted bytes. */
  async discardCopies(copies: CopiedDocument[]): Promise<void> {
    await Promise.allSettled(copies.map((copy) =>
      this.removeCopyRecord(copy.documentId, [copy.originalStoreKey, ...(copy.extractedTextStoreKey ? [copy.extractedTextStoreKey] : [])]),
    ));
  }

  /** Retries the row delete once. Blobs are removed only after the row is gone; otherwise both stay, which is consistent. */
  private async removeCopyRecord(documentId: string, storeKeys: string[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.repo.hardDelete(documentId);
        await this.discard(storeKeys);
        return true;
      } catch (error) {
        console.warn(`[removeCopyRecord] Attempt ${attempt + 1} to remove document row ${documentId} failed: ${(error as Error).message}`);
      }
    }
    return false;
  }

  private async discard(storeKeys: string[]): Promise<void> {
    // Best-effort: a leftover blob is harmless, and the caller already has a failure to report.
    await Promise.allSettled(storeKeys.map((key) => this.store.delete(key)));
  }
}

/** A failed extraction stays failed on the copy; anything else without extracted text is not needed. */
function toExtractionStatus(status: string): ExtractionStatus {
  return status === 'ready' || status === 'failed' ? status : 'not_needed';
}

function checkSetShape(documentIds: string[]): AttachmentResolveError | null {
  if (documentIds.length > MAX_OUTBOUND_DOCUMENTS) {
    return {
      code: 'outbound_attachment.too_many',
      message: `A message can attach at most ${MAX_OUTBOUND_DOCUMENTS} documents.`,
      context: { count: documentIds.length, maxCount: MAX_OUTBOUND_DOCUMENTS },
    };
  }
  if (new Set(documentIds).size !== documentIds.length) {
    return {
      code: 'outbound_attachment.duplicate',
      message: 'Each document can be attached to a message only once.',
      context: { documentIds },
    };
  }
  return null;
}

function checkTotalBytes(rows: OutboundDocumentRow[]): AttachmentResolveError | null {
  const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  if (totalBytes <= MAX_OUTBOUND_TOTAL_BYTES) return null;
  return {
    code: 'outbound_attachment.too_large',
    message: `Attached documents total ${totalBytes} bytes, above the ${MAX_OUTBOUND_TOTAL_BYTES} byte limit.`,
    context: { totalBytes, maxBytes: MAX_OUTBOUND_TOTAL_BYTES },
  };
}

function toResolvedAttachment(row: OutboundDocumentRow, body: Buffer): ResolvedAttachment {
  return {
    documentId: row.id,
    userId: row.userId,
    filename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    body,
    storeKey: row.originalStoreKey,
    extractedTextStoreKey: row.extractedTextStoreKey,
    extractionStatus: toExtractionStatus(row.extractionStatus),
  };
}
