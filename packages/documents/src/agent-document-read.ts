import type { DocumentStore, Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

/** Characters returned per call. Longer documents continue from `nextOffset`. */
export const DOCUMENT_TEXT_PAGE_CHARS = 100_000;

/** Largest stored text blob read into memory. Larger blobs are refused before reading. */
export const DOCUMENT_TEXT_MAX_BYTES = 5 * 1024 * 1024;

const TEXT_MIME_TYPES = new Set(['application/json', 'application/xml']);

/** The document columns the read needs. Matches a row from `AgentDocumentsRepository.getById`. */
export interface AgentDocumentRow {
  id: string;
  agentId: string;
  originalFilename: string;
  mimeType: string;
  originalStoreKey: string;
  extractedTextStoreKey: string | null;
  extractionStatus: string;
}

export interface AgentDocumentLookup {
  getById(id: string): Promise<AgentDocumentRow | null>;
}

export interface AgentDocumentTextPage {
  documentId: string;
  filename: string;
  text: string;
  /** Character offset (code points) where this page starts. */
  offset: number;
  /** Offset to continue from, or null when this page reaches the end. */
  nextOffset: number | null;
  totalChars: number;
}

export interface AgentDocumentReadError {
  code: 'document.not_found' | 'document.no_text' | 'document.too_large' | 'document.read_failed';
  message: string;
  context: Record<string, unknown>;
}

/**
 * The stored blob holding readable text: the extracted text when extraction is ready, otherwise
 * the original file when it is plain text. Null when the document has no readable text (for example
 * a PDF whose extraction failed).
 */
export function selectTextStoreKey(document: AgentDocumentRow): string | null {
  if (document.extractedTextStoreKey && document.extractionStatus === 'ready') return document.extractedTextStoreKey;
  if (document.mimeType.startsWith('text/') || TEXT_MIME_TYPES.has(document.mimeType)) return document.originalStoreKey;
  return null;
}

function fail(code: AgentDocumentReadError['code'], message: string, documentId: string): Result<never, AgentDocumentReadError> {
  return err({ code, message, context: { documentId } });
}

/**
 * Reads one page of a document's text for the agent that owns it.
 *
 * A document that belongs to another agent is reported as not found, so document ids cannot be
 * probed across agents. Paging counts code points, so a surrogate pair is never split.
 */
export async function readAgentDocumentPage(params: {
  lookup: AgentDocumentLookup;
  store: DocumentStore;
  agentId: string;
  documentId: string;
  offset: number;
  pageChars?: number;
  maxBytes?: number;
}): Promise<Result<AgentDocumentTextPage, AgentDocumentReadError>> {
  const pageChars = params.pageChars ?? DOCUMENT_TEXT_PAGE_CHARS;
  const maxBytes = params.maxBytes ?? DOCUMENT_TEXT_MAX_BYTES;

  const document = await params.lookup.getById(params.documentId);
  if (!document || document.agentId !== params.agentId) {
    return fail('document.not_found', 'Document not found.', params.documentId);
  }

  const storeKey = selectTextStoreKey(document);
  if (!storeKey) {
    return fail('document.no_text', `No readable text for ${document.originalFilename} (${document.mimeType}).`, document.id);
  }

  const meta = await params.store.getMetadata(storeKey);
  if (!meta.ok) {
    return fail('document.read_failed', 'Document text could not be read.', document.id);
  }
  if (meta.data.sizeBytes > maxBytes) {
    return fail('document.too_large', `Document text is larger than ${maxBytes} bytes.`, document.id);
  }

  const read = await params.store.read(storeKey);
  if (!read.ok) {
    return fail('document.read_failed', 'Document text could not be read.', document.id);
  }

  const chars = Array.from(read.data.toString('utf8'));
  const start = Math.min(params.offset, chars.length);
  const end = Math.min(start + pageChars, chars.length);
  return ok({
    documentId: document.id,
    filename: document.originalFilename,
    text: chars.slice(start, end).join(''),
    offset: start,
    nextOffset: end < chars.length ? end : null,
    totalChars: chars.length,
  });
}
