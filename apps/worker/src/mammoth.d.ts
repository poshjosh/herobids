declare module 'mammoth' {
  interface MammothInput {
    /** Path to a .docx file on disk. */
    path?: string;
    /** Buffer containing .docx file content. */
    buffer?: Buffer;
    /** An already-opened file-like object. */
    file?: unknown;
  }

  interface MammothMessage {
    type: string;
    message: string;
    error?: Error;
  }

  interface MammothResult<T> {
    value: T;
    messages: MammothMessage[];
  }

  /** Convert .docx to HTML. */
  export function convertToHtml(
    input: MammothInput,
    options?: Record<string, unknown>,
  ): Promise<MammothResult<string>>;

  /** Convert .docx to Markdown. */
  export function convertToMarkdown(
    input: MammothInput,
    options?: Record<string, unknown>,
  ): Promise<MammothResult<string>>;

  /** Generic conversion with output format option. */
  export function convert(
    input: MammothInput,
    options?: Record<string, unknown>,
  ): Promise<MammothResult<string>>;

  /** Extract raw text from .docx without formatting. */
  export function extractRawText(input: MammothInput): Promise<MammothResult<string>>;
}
