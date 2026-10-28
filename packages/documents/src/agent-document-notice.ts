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
