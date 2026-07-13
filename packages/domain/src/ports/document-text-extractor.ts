import type { Result, DomainError } from '../result.js';

// ── MIME type constants ──────────────────────────────────────────────────────

export const SUPPORTED_EXTRACTION_MIME_TYPES = [
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
] as const;

export type SupportedExtractionMimeType = (typeof SUPPORTED_EXTRACTION_MIME_TYPES)[number];

// ── Error type ──────────────────────────────────────────────────────────────

export interface DocumentExtractionError extends DomainError {
  /** e.g. "extraction.unsupported_type", "extraction.parse_failed", "extraction.too_large" */
  code: string;
}

// ── Result types ────────────────────────────────────────────────────────────

export interface ExtractionResult {
  /** Extracted plain-text content (UTF-8). */
  extractedText: string;
  /** Whether the extracted text was truncated to fit the cap. */
  truncated: boolean;
  /** Byte-length at which the text was truncated (0 if not truncated). */
  truncatedAtBytes: number;
}

// ── Port interface ──────────────────────────────────────────────────────────

/**
 * Shared text-extraction service for document uploads, Telegram attachments,
 * and web-access document reading.
 *
 * Implementations should be composable — a factory can assemble a dispatcher
 * that delegates to the correct inner extractor based on MIME type.
 */
export interface DocumentTextExtractor {
  /**
   * Extract plain text from a document buffer.
   *
   * @param body      Raw document bytes.
   * @param mimeType  MIME type of the input.
   * @param filename  Original filename (may help disambiguate .doc vs .docx).
   */
  extract(params: {
    body: Buffer;
    mimeType: string;
    filename?: string;
  }): Promise<Result<ExtractionResult, DocumentExtractionError>>;

  /** Returns true when this extractor can handle the given MIME type. */
  supportsMimeType(mimeType: string): boolean;
}
