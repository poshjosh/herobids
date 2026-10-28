import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- read_agent_document ---

// The text is fetched from the platform API. The agent container has no access to the document store.
const ReadAgentDocumentParamsSchema = z.object({
  documentId: z.string().uuid().describe('Document id from the "User sent document" message'),
  offset: z.number().int().min(0).optional().describe('Character offset to continue from. Use the nextOffset of the previous result. Defaults to 0.'),
});

const readAgentDocumentTool: AgentTool = {
  name: 'read_agent_document',
  description: 'Read the text of a document the user sent in chat, by the document id from the "User sent document" message. Returns up to 100,000 characters per call. If nextOffset is not null, call again with that offset to read the rest. Returns an error for files with no readable text (for example a PDF whose text could not be extracted).',
  parametersSchema: ReadAgentDocumentParamsSchema,
  parameters: convertZodToJsonSchema(ReadAgentDocumentParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { documentId, offset = 0 } = params as z.infer<typeof ReadAgentDocumentParamsSchema>;
    if (!ctx.agentPlatform) {
      return { success: false, error: 'document reading unavailable: platform not configured', errorCode: 'precondition.not_ready', fault: false };
    }

    const result = await ctx.agentPlatform.readAgentDocument(documentId, offset);
    if (!result.ok) {
      return { success: false, error: result.error.message, errorCode: result.error.code, fault: result.error.retryable };
    }
    return { success: true, data: { ok: true, ...result.data } };
  },
};

export const agentDocumentTools: AgentTool[] = [readAgentDocumentTool];
