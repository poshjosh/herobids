import { sanitizeFilename } from './agent-document-service.js';

export interface DocumentNoticeParams {
  documentId: string;
  filename: string;
  extracted: boolean;
  caption?: string | null;
}

/** Text the agent receives when a user sends a document, pointing at the workspace copies. */
export function buildDocumentNoticeText(params: DocumentNoticeParams): string {
  const safeName = sanitizeFilename(params.filename);
  return [
    `User sent document \`${params.filename}\`.`,
    `Original saved at \`docs/original/${params.documentId}-${safeName}\`.`,
    params.extracted ? `Extracted text saved at \`docs/extracted/${params.documentId}.txt\`.` : '',
    params.caption ? `Caption: "${params.caption}"` : '',
  ].filter(Boolean).join('\n');
}
