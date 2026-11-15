import { z } from 'zod';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { resolveReadableFile } from './file-access.js';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { countCodePoints, readLinePage } from './file-text.js';
import { convertZodToJsonSchema } from './registry.js';
import { toolUse } from './tool-signature.js';

const logger = createLogger('tools:read-file-lines');

const limits = getFileToolLimits();

const ReadFileLinesParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace to read'),
  startLine: z.coerce.number().int().min(1).optional()
    .describe('First line to return, counting from 1. Default 1. Pass back nextLine from the previous result to continue.'),
  limit: z.coerce.number().int().min(1).optional()
    .describe('Number of lines to return. Default: as many whole lines as fit in maxChars.'),
  maxChars: z.coerce.number().int().min(1).optional()
    .describe(`Character cap for the result. Default ${limits.readDefaultChars}, maximum ${limits.readMaxChars}. About 4 characters cost one token, so large values use a lot of context.`),
});

export const readFileLinesTool: AgentTool = {
  name: 'read_file_lines',
  description: `Read whole lines from a file in the agent workspace, up to ${limits.maxFileBytes} bytes. Returns the lines exactly as in the file (no line numbers, line endings kept), so the text can be passed to edit_file. At most maxChars characters are returned per call (default ${limits.readDefaultChars}, max ${limits.readMaxChars}); use nextLine to continue. Prefer this over read_file for large files, and use ${toolUse('search_files', 'path', 'query')} to find the right line first.`,
  parametersSchema: ReadFileLinesParamsSchema,
  parameters: convertZodToJsonSchema(ReadFileLinesParamsSchema),
  category: 'read-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, startLine = 1, limit, maxChars = limits.readDefaultChars } =
      params as z.infer<typeof ReadFileLinesParamsSchema>;

    if (maxChars > limits.readMaxChars) {
      return messages.limitTooLarge('maxChars', maxChars, limits.readMaxChars);
    }

    const file = await resolveReadableFile(ctx.agentId, relativePath, 'reading');
    if (!file.ok) return file.result;

    try {
      const page = await readLinePage(file.absolutePath, {
        startLine,
        maxChars,
        ...(limit !== undefined ? { limit } : {}),
      });
      logger.debug({ agentId: ctx.agentId, path: relativePath, startLine, endLine: page.endLine }, 'read_file_lines success');

      const hint = buildHint(relativePath, page);
      return {
        success: true,
        data: {
          path: relativePath,
          startLine: page.startLine,
          endLine: page.endLine,
          totalLines: page.totalLines,
          nextLine: page.nextLine,
          // A cut line is also "not the whole text", even though nextLine may be null.
          truncated: page.nextLine !== null || page.lineCut,
          ...(page.lineCut ? { lineCut: true } : {}),
          ...(page.lineStartOffset !== undefined ? { lineStartOffset: page.lineStartOffset } : {}),
          ...(hint !== undefined ? { hint } : {}),
          content: page.content,
        },
      };
    } catch (error) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: error instanceof Error ? error.message : String(error) }, 'read_file_lines error');
      return messages.fromFsError(error, { action: 'reading', path: relativePath });
    }
  },
};

function buildHint(path: string, page: Awaited<ReturnType<typeof readLinePage>>): string | undefined {
  if (page.lineCut && page.lineStartOffset !== undefined && page.endLine !== null) {
    const continueOffset = page.lineStartOffset + countCodePoints(page.content);
    return messages.readLineCutHint(path, page.endLine, continueOffset, page.nextLine);
  }
  if (page.nextLine !== null) return messages.readLinesPagedHint(path, page.nextLine);
  return undefined;
}
