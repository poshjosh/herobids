import { ok, err } from '@herobids/domain';
import type {
  DocumentTextExtractor,
  DocumentExtractionError,
  ExtractionResult,
  Result,
} from '@herobids/domain';

// ── Truncation cap (1 MiB) ─────────────────────────────────────────────────

// TODO: Move to operator config (agentDocumentUploads.extractedTextMaxBytes).
const EXTRACTED_TEXT_MAX_BYTES = 1_048_576; // 1 MiB

function applyTruncation(text: string): ExtractionResult {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= EXTRACTED_TEXT_MAX_BYTES) {
    return { extractedText: text, truncated: false, truncatedAtBytes: 0 };
  }
  // Truncate at the byte boundary. The subarray + toString('utf-8') handles
  // partial multi-byte sequences correctly — Node.js discards the incomplete
  // trailing bytes, so no additional cleanup is needed.
  const truncated = buf.subarray(0, EXTRACTED_TEXT_MAX_BYTES).toString('utf-8');
  return { extractedText: truncated, truncated: true, truncatedAtBytes: EXTRACTED_TEXT_MAX_BYTES };
}

// ── Plain-text extractor ────────────────────────────────────────────────────

export class PlainTextExtractor implements DocumentTextExtractor {
  readonly supportedMimeTypes = new Set([
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'text/csv',
    'text/html',
    'text/xml',
    'application/json',
    'application/xml',
  ]);

  supportsMimeType(mimeType: string): boolean {
    return this.supportedMimeTypes.has(mimeType) || mimeType.startsWith('text/');
  }

  async extract(params: {
    body: Buffer;
    mimeType: string;
    filename?: string;
  }): Promise<Result<ExtractionResult, DocumentExtractionError>> {
    try {
      const text = params.body.toString('utf-8');
      return ok(applyTruncation(text));
    } catch (error) {
      return err({
        code: 'extraction.parse_failed',
        message: `Failed to decode plain text: ${(error as Error).message}`,
        context: { mimeType: params.mimeType, filename: params.filename },
      });
    }
  }
}

// ── PDF extractor ───────────────────────────────────────────────────────────

/** Minimal interface for the pdf-parse v2 API that we use. */
interface PdfParseV2 {
  new (opts: { data: Buffer }): PdfParseV2Instance;
}

interface PdfParseV2Instance {
  getText(params?: Record<string, unknown>): Promise<{ text: string }>;
  destroy(): Promise<void>;
}

export class PdfTextExtractor implements DocumentTextExtractor {
  private PDFParseClass: PdfParseV2 | null = null;
  private initPromise: Promise<void> | null = null;

  supportsMimeType(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }

  async extract(params: {
    body: Buffer;
    mimeType: string;
    filename?: string;
  }): Promise<Result<ExtractionResult, DocumentExtractionError>> {
    let parser: PdfParseV2Instance | null = null;
    try {
      if (!this.PDFParseClass) {
        if (!this.initPromise) {
          this.initPromise = import('pdf-parse').then((mod) => {
            // pdf-parse v2 exports a named class PDFParse
            this.PDFParseClass = (mod.PDFParse as PdfParseV2 | undefined) ?? (mod as unknown as PdfParseV2);
          });
        }
        await this.initPromise;
      }

      parser = new this.PDFParseClass!({ data: params.body });
      const result = await parser.getText();
      const text = result.text ?? '';
      await parser.destroy();
      return ok(applyTruncation(text));
    } catch (error) {
      if (parser) {
        try { await parser.destroy(); } catch { /* ignore */ }
      }
      return err({
        code: 'extraction.parse_failed',
        message: `Failed to extract PDF text: ${(error as Error).message}`,
        context: { mimeType: params.mimeType, filename: params.filename },
      });
    }
  }
}

// ── Word (.docx) extractor ──────────────────────────────────────────────────

export class WordTextExtractor implements DocumentTextExtractor {
  private mammothExtract: ((buf: Buffer) => Promise<{ value: string }>) | null = null;
  private initPromise: Promise<void> | null = null;

  supportsMimeType(mimeType: string): boolean {
    // Only .docx (OOXML). Legacy .doc (OLE2) is not supported — mammoth cannot
    // parse it, and callers should not be routed here for that MIME type.
    return mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async extract(params: {
    body: Buffer;
    mimeType: string;
    filename?: string;
  }): Promise<Result<ExtractionResult, DocumentExtractionError>> {
    try {
      if (!this.mammothExtract) {
        if (!this.initPromise) {
          this.initPromise = import('mammoth').then((mod) => {
            this.mammothExtract = (buf: Buffer) => mod.extractRawText({ buffer: buf });
          });
        }
        await this.initPromise;
      }

      const result = await this.mammothExtract!(params.body);
      return ok(applyTruncation(result.value));
    } catch (error) {
      return err({
        code: 'extraction.parse_failed',
        message: `Failed to extract Word text: ${(error as Error).message}`,
        context: { mimeType: params.mimeType, filename: params.filename },
      });
    }
  }
}

// ── Composite factory ───────────────────────────────────────────────────────

/**
 * Creates a {@link DocumentTextExtractor} that dispatches to the correct
 * inner extractor based on MIME type.
 */
export function createDocumentTextExtractor(): DocumentTextExtractor {
  // Order matters: most-specific extractors first, catch-all (PlainText) last.
  // PlainTextExtractor matches any text/*, so it must be checked after Pdf and Word.
  const extractors: DocumentTextExtractor[] = [
    new WordTextExtractor(),
    new PdfTextExtractor(),
    new PlainTextExtractor(),
  ];

  return {
    supportsMimeType(mimeType: string): boolean {
      return extractors.some((e) => e.supportsMimeType(mimeType));
    },

    async extract(params: {
      body: Buffer;
      mimeType: string;
      filename?: string;
    }): Promise<Result<ExtractionResult, DocumentExtractionError>> {
      for (const extractor of extractors) {
        if (extractor.supportsMimeType(params.mimeType)) {
          return extractor.extract(params);
        }
      }
      return err({
        code: 'extraction.unsupported_type',
        message: `Unsupported MIME type for text extraction: ${params.mimeType}`,
        context: { mimeType: params.mimeType, filename: params.filename },
      });
    },
  };
}
