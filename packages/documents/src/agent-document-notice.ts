export interface DocumentNoticeParams {
  documentId: string;
  filename: string;
  caption?: string | null;
}

/** Text the agent receives when a user sends a document. The agent reads it with the read_agent_document tool. */
export function buildDocumentNoticeText(params: DocumentNoticeParams): string {
  return [
    `User sent document \`${params.filename}\` (document id \`${params.documentId}\`).`,
    'To read it, call `read_agent_document` with this document id.',
    params.caption ? `Caption: "${params.caption}"` : '',
  ].filter(Boolean).join('\n');
}

export interface ParsedDocumentNotice {
  /** What the user wrote: the text before the notice, or the caption when there is none. Empty when neither exists. */
  userText: string;
  filename: string;
  documentId: string;
}

const DOCUMENT_NOTICE_PATTERN =
  /^(?<body>[\s\S]*?)\n*User sent document `(?<filename>[^`\n]+)` \(document id `(?<documentId>[^`\n]+)`\)\.\nTo read it, call `read_agent_document` with this document id\.(?:\nCaption: "(?<caption>[\s\S]*)")?$/;

/**
 * Splits a message produced by `buildDocumentNoticeText` (optionally after the user's own text) into the user's words
 * and the attachment. Null when the text is not in that shape. The text is the user's message, so a user can type the
 * same shape: the result is for display only and proves nothing about the document.
 */
export function parseDocumentNoticeText(text: string): ParsedDocumentNotice | null {
  const match = DOCUMENT_NOTICE_PATTERN.exec(text);
  const groups = match?.groups;
  if (!groups) return null;
  const body = (groups['body'] ?? '').trim();
  const caption = (groups['caption'] ?? '').trim();
  return {
    userText: body !== '' ? body : caption,
    filename: groups['filename'] ?? '',
    documentId: groups['documentId'] ?? '',
  };
}
