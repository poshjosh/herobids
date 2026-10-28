/** Mirrors the server allow-list and size cap for documents sent with a chat message. */
export const CONVERSATION_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const CONVERSATION_ATTACHMENT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const CONVERSATION_ATTACHMENT_ACCEPT = CONVERSATION_ATTACHMENT_TYPES.join(',');

export type AttachmentProblem = 'unsupported' | 'too_large';

export function attachmentProblem(file: Pick<File, 'type' | 'size'>): AttachmentProblem | null {
  if (!(CONVERSATION_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return 'unsupported';
  if (file.size > CONVERSATION_ATTACHMENT_MAX_BYTES) return 'too_large';
  return null;
}
