import { z } from 'zod';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { checkWriteBudget, checkWriteChars, resolveWritableTarget } from './file-write.js';
import { convertZodToJsonSchema } from './registry.js';

const logger = createLogger('tools:append-file');

const descriptionLimits = getFileToolLimits();

const AppendFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path within the workspace (e.g. "notes/log.txt"). The file is created if missing.'),
  content: z.string().describe(`Text to add at the end of the file. At most ${descriptionLimits.writeMaxChars} characters per call.`),
  ensureNewline: z.boolean().optional()
    .describe('Default true. If the file does not end in a newline, add one before the content so it starts on its own line.'),
});

export const appendFileTool: AgentTool = {
  name: 'append_file',
  description: `Add text to the end of a file in the agent workspace, creating the file if it is missing. At most ${descriptionLimits.writeMaxChars} characters per call; call again for more. Appending twice writes twice, so do not repeat a call that succeeded. Files are limited to ${descriptionLimits.maxFileBytes} bytes. The sandbox directory is reserved for code execution and cannot be written here.`,
  parametersSchema: AppendFileParamsSchema,
  parameters: convertZodToJsonSchema(AppendFileParamsSchema),
  category: 'write-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, content, ensureNewline = true } =
      params as z.infer<typeof AppendFileParamsSchema>;

    const tooLong = checkWriteChars(content, 'append_file');
    if (tooLong) return tooLong;

    const target = await resolveWritableTarget(ctx.agentId, relativePath);
    if (!target.ok) return target.result;

    try {
      const existingBytes = target.existing?.sizeBytes ?? 0;
      // An empty append never adds a lone newline.
      const newlineAdded = ensureNewline && content.length > 0 && existingBytes > 0
        && !(await endsWithNewline(target.absolutePath, existingBytes));
      const text = newlineAdded ? `\n${content}` : content;
      const bytesAppended = Buffer.byteLength(text, 'utf8');
      const sizeBytes = existingBytes + bytesAppended;

      const rejected = await checkWriteBudget(target.root, relativePath, sizeBytes, bytesAppended);
      if (rejected) return rejected;

      await mkdir(dirname(target.absolutePath), { recursive: true });
      await appendFile(target.absolutePath, text, 'utf8');
      logger.debug({ agentId: ctx.agentId, path: relativePath, bytes: bytesAppended }, 'append_file success');
      return { success: true, data: { path: relativePath, bytesAppended, newlineAdded, sizeBytes } };
    } catch (error) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: error instanceof Error ? error.message : String(error) }, 'append_file error');
      return messages.fromFsError(error, { action: 'appending', path: relativePath });
    }
  },
};

async function endsWithNewline(absolutePath: string, sizeBytes: number): Promise<boolean> {
  const handle = await open(absolutePath, 'r');
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, sizeBytes - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}
