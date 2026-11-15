import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { checkWriteBudget, checkWriteChars, resolveWritableTarget, writeFileAtomic } from './file-write.js';
import { convertZodToJsonSchema } from './registry.js';
import { toolUse } from './tool-signature.js';

const logger = createLogger('tools:edit-file');

const descriptionLimits = getFileToolLimits();

const EditFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path of an existing file within the workspace'),
  oldText: z.string().min(1).describe(`Exact text to replace, including spaces and line endings. At most ${descriptionLimits.writeMaxChars} characters.`),
  newText: z.string().describe(`Replacement text (may be empty to delete oldText). At most ${descriptionLimits.writeMaxChars} characters.`),
  replaceAll: z.boolean().optional()
    .describe('Default false: oldText must match exactly one place. Set true to replace every match.'),
});

export const editFileTool: AgentTool = {
  name: 'edit_file',
  description: `Replace exact text in an existing file in the agent workspace without rewriting the whole file. Copy oldText exactly from ${toolUse('read_file_lines', 'path', 'startLine', 'limit')}. By default oldText must match exactly one place; set replaceAll: true to change every match. Files up to ${descriptionLimits.maxFileBytes} bytes. Returns a short summary, not the file. The sandbox directory is reserved for code execution and cannot be edited here.`,
  parametersSchema: EditFileParamsSchema,
  parameters: convertZodToJsonSchema(EditFileParamsSchema),
  category: 'write-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, oldText, newText, replaceAll = false } =
      params as z.infer<typeof EditFileParamsSchema>;

    const tooLong = checkWriteChars(oldText, 'edit_file') ?? checkWriteChars(newText, 'edit_file');
    if (tooLong) return tooLong;
    if (oldText === newText) return messages.editNoChange();

    const target = await resolveWritableTarget(ctx.agentId, relativePath, { mustExist: true });
    if (!target.ok) return target.result;
    // resolveWritableTarget with mustExist guarantees `existing`.
    const existing = target.existing;
    if (!existing) return messages.notFound(relativePath);

    const { maxFileBytes } = getFileToolLimits();
    if (existing.sizeBytes > maxFileBytes) {
      return messages.tooLarge(relativePath, existing.sizeBytes, maxFileBytes, { forEdit: true });
    }

    try {
      const original = await readFile(target.absolutePath);
      const text = original.toString('utf8');
      // Invalid UTF-8 would be rewritten as U+FFFD and corrupt the file.
      if (!Buffer.from(text, 'utf8').equals(original)) return messages.notText(relativePath);

      const matchCount = countMatches(text, oldText);
      if (matchCount === 0) {
        return messages.editTextNotFound(relativePath, { crlfMismatch: isCrlfMismatch(text, oldText) });
      }
      if (matchCount > 1 && !replaceAll) return messages.editAmbiguousMatch(relativePath, matchCount);

      const edited = replaceAll ? text.split(oldText).join(newText) : replaceFirst(text, oldText, newText);
      const data = Buffer.from(edited, 'utf8');
      const bytesDelta = data.length - original.length;

      const rejected = await checkWriteBudget(target.root, relativePath, data.length, bytesDelta);
      if (rejected) return rejected;

      // Write next to the real file, so an in-workspace symlink is kept and its target edited.
      await writeFileAtomic(await realpath(target.absolutePath), data, existing);
      const replacements = replaceAll ? matchCount : 1;
      logger.debug({ agentId: ctx.agentId, path: relativePath, replacements, bytesDelta }, 'edit_file success');
      return { success: true, data: { path: relativePath, replacements, sizeBytes: data.length, bytesDelta } };
    } catch (error) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: error instanceof Error ? error.message : String(error) }, 'edit_file error');
      return messages.fromFsError(error, { action: 'editing', path: relativePath });
    }
  },
};

/** Non-overlapping occurrences of `needle` in `text`. */
function countMatches(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return count;
    count++;
    from = index + needle.length;
  }
}

/** Plain slicing, so `$` sequences in newText are never treated as replacement patterns. */
function replaceFirst(text: string, oldText: string, newText: string): string {
  const index = text.indexOf(oldText);
  return text.slice(0, index) + newText + text.slice(index + oldText.length);
}

/** The file uses \r\n but oldText has bare \n, and the CRLF form would match. */
function isCrlfMismatch(text: string, oldText: string): boolean {
  return oldText.includes('\n') && !oldText.includes('\r\n') && text.includes(oldText.replace(/\n/g, '\r\n'));
}
