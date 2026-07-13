import { randomUUID } from 'node:crypto';
import { ok, err } from '@herobids/domain';
import type { Result, DomainError } from '@herobids/domain';
import type { DocumentStore } from '@herobids/domain';
import type { DocumentTextExtractor } from '@herobids/domain';
import type { AgentDocumentsRepository, DocumentSource } from '@herobids/db';

// ── Error type ──────────────────────────────────────────────────────────────

export interface AgentDocumentError extends DomainError {
  /** e.g. "agent_document.unsupported_type", "agent_document.too_large", "agent_document.not_found" */
  code: string;
}

// ── Upload params & result ──────────────────────────────────────────────────

export interface UploadDocumentParams {
  agentId: string;
  userId: string;
  source: DocumentSource;
  originalFilename: string;
  mimeType: string;
  body: Buffer;
  sourceRef?: string | null;
  captionOrPrompt?: string | null;
}

export interface UploadDocumentResult {
  id: string;
  originalFilename: string;
  mimeType: string;
  originalStoreKey: string;
  extractedTextStoreKey: string | null;
  extractionStatus: string;
  sizeBytes: number;
  lifecycleState: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

// TODO: Move to operator config (agentDocumentUploads.maxUploadBytes).
const MAX_UPLOAD_BYTES = 10 * 1_048_576; // 10 MiB

/**
 * MIME types accepted for upload. Must be a subset of what we can handle.
 * TODO: Move to operator config (agentDocumentUploads.allowedMimeTypes).
 */
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
]);

/**
 * MIME types whose content is already plain text — no extraction needed.
 * These skip DocumentTextExtractor and get extractionStatus: 'not_needed'.
 */
const PASSTHROUGH_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
]);

// ── Service ─────────────────────────────────────────────────────────────────

export class AgentDocumentService {
  constructor(
    private readonly store: DocumentStore,
    private readonly textExtractor: DocumentTextExtractor,
    private readonly repo: AgentDocumentsRepository,
  ) {}

  /**
   * Validate, store, extract, and persist a new document for an agent.
   */
  async uploadDocument(params: UploadDocumentParams): Promise<Result<UploadDocumentResult, AgentDocumentError>> {
    // ── Validate ──────────────────────────────────────────────────────────

    if (!ALLOWED_UPLOAD_MIME_TYPES.has(params.mimeType)) {
      return err({
        code: 'agent_document.unsupported_type',
        message: `Unsupported file type: ${params.mimeType}. Supported types: text, PDF, Word (.docx).`,
        context: { mimeType: params.mimeType, filename: params.originalFilename },
      });
    }

    if (params.body.byteLength > MAX_UPLOAD_BYTES) {
      return err({
        code: 'agent_document.too_large',
        message: `File size ${params.body.byteLength} exceeds the ${MAX_UPLOAD_BYTES} byte limit.`,
        context: { size: params.body.byteLength, maxSize: MAX_UPLOAD_BYTES },
      });
    }

    // ── Store original ────────────────────────────────────────────────────

    const docId = randomUUID();
    const safeName = sanitizeFilename(params.originalFilename);
    const keyHint = `${docId}/${safeName}`;

    const putResult = await this.store.put({
      keyHint,
      contentType: params.mimeType,
      body: params.body,
    });
    if (!putResult.ok) {
      return err({
        code: 'agent_document.store_failed',
        message: putResult.error.message,
        context: putResult.error.context,
      });
    }
    const originalStoreKey = putResult.data.storeKey;

    // ── Extract text ──────────────────────────────────────────────────────

    let extractedTextStoreKey: string | null = null;
    let extractionStatus: 'not_needed' | 'ready' | 'failed' = 'not_needed';

    const needsExtraction = !PASSTHROUGH_MIME_TYPES.has(params.mimeType)
      && this.textExtractor.supportsMimeType(params.mimeType);

    if (needsExtraction) {
      const extractResult = await this.textExtractor.extract({
        body: params.body,
        mimeType: params.mimeType,
        filename: params.originalFilename,
      });

      if (extractResult.ok) {
        const extractedText = extractResult.data.extractedText;
        const textBuf = Buffer.from(extractedText, 'utf-8');
        const textPutResult = await this.store.put({
          keyHint: `${docId}/extracted.txt`,
          contentType: 'text/plain; charset=utf-8',
          body: textBuf,
        });
        if (textPutResult.ok) {
          extractedTextStoreKey = textPutResult.data.storeKey;
          extractionStatus = 'ready';
        } else {
          extractionStatus = 'failed';
        }
      } else {
        extractionStatus = 'failed';
      }
    }

    // ── Persist metadata ──────────────────────────────────────────────────

    try {
      await this.repo.create({
        id: docId,
        agentId: params.agentId,
        userId: params.userId,
        source: params.source,
        sourceRef: params.sourceRef ?? null,
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        sizeBytes: params.body.byteLength,
        originalStoreKey,
        extractedTextStoreKey,
        extractionStatus,
        lifecycleState: 'staged',
        captionOrPrompt: params.captionOrPrompt ?? null,
      });
    } catch (error) {
      // Best-effort cleanup of stored blobs on metadata write failure.
      await this.store.delete(originalStoreKey);
      if (extractedTextStoreKey) await this.store.delete(extractedTextStoreKey);
      return err({
        code: 'agent_document.persist_failed',
        message: `Failed to persist document metadata: ${(error as Error).message}`,
        context: { agentId: params.agentId },
      });
    }

    return ok({
      id: docId,
      originalFilename: params.originalFilename,
      mimeType: params.mimeType,
      originalStoreKey,
      extractedTextStoreKey,
      extractionStatus,
      sizeBytes: params.body.byteLength,
      lifecycleState: 'staged',
    });
  }

  /**
   * List all documents for an agent (non-deleted).
   */
  async getDocuments(agentId: string) {
    return this.repo.listByAgent(agentId);
  }

  /**
   * Delete a document: remove stored blobs and soft-delete the metadata row.
   */
  async deleteDocument(agentId: string, documentId: string): Promise<Result<void, AgentDocumentError>> {
    const doc = await this.repo.getById(documentId);
    if (!doc) {
      return err({
        code: 'agent_document.not_found',
        message: `Document ${documentId} not found.`,
        context: { documentId, agentId },
      });
    }

    if (doc.agentId !== agentId) {
      return err({
        code: 'agent_document.access_denied',
        message: `Document ${documentId} does not belong to agent ${agentId}.`,
        context: { documentId, agentId, actualAgentId: doc.agentId },
      });
    }

    // Delete stored blobs (best-effort — don't fail the operation if store delete fails).
    await this.store.delete(doc.originalStoreKey);
    if (doc.extractedTextStoreKey) {
      await this.store.delete(doc.extractedTextStoreKey);
    }

    await this.repo.delete(documentId);

    return ok(undefined);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitize a filename so it is safe for use as a filesystem path segment.
 * Replaces path separators and control characters with underscores.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '') // prevent hidden files
    // Defense-in-depth: the prior replace already catches `/` and `\`,
    // but explicit `..` removal guards against edge cases where a path
    // segment could still contain traversal sequences.
    .replace(/\.\./g, '_')
    .trim()
    .slice(0, 255) || 'unnamed';
}
