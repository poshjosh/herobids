import { z } from 'zod';
import { lstat, readdir, rm, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { convertZodToJsonSchema } from './registry.js';
import { checkReservedDir, ensureWorkspaceDirs, getWorkspacePaths, resolveWorkspacePath } from './workspace.js';

const logger = createLogger('tools:delete-file');

const descriptionLimits = getFileToolLimits();

const DeleteFileParamsSchema = z.object({
  path: z.string().min(1).describe('Relative path of the file (or folder, with recursive) to delete'),
  recursive: z.boolean().optional().describe(
    `Set to true to delete a folder and everything inside it. This cannot be undone. Without it, a folder path is refused. A folder with more than ${descriptionLimits.maxDeleteFiles} files is refused; delete its subfolders one at a time.`,
  ),
});

interface FolderTally {
  files: number;
  bytes: number;
  /** True when the walk stopped early because the count passed the limit. */
  overLimit: boolean;
}

export const deleteFileTool: AgentTool = {
  name: 'delete_file',
  description: 'Delete a file from the agent workspace. With `recursive: true`, delete a folder and its contents. The sandbox directory is reserved and cannot be deleted.',
  parametersSchema: DeleteFileParamsSchema,
  parameters: convertZodToJsonSchema(DeleteFileParamsSchema),
  category: 'write-filesystem',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: relativePath, recursive = false } = params as z.infer<typeof DeleteFileParamsSchema>;

    const limits = getFileToolLimits();
    if (checkReservedDir(relativePath) !== undefined) return messages.reservedPath();

    const paths = getWorkspacePaths(ctx.agentId);
    await ensureWorkspaceDirs(paths);

    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) return messages.pathInvalid(relativePath);

    const root = resolve(paths.root);
    const target = resolve(resolved.absolutePath);
    const segments = relative(root, target).split(sep).filter((segment) => segment !== '');
    if (!target.startsWith(root + sep) && target !== root) return messages.pathInvalid(relativePath);
    // The workspace root and the top-level platform folders hold installed skills.
    const isProtected = segments.length === 0
      || (segments.length === 1 && limits.platformDirs.includes(segments[0] ?? ''));
    if (isProtected) return messages.reservedDeletePath(relativePath);

    try {
      // lstat: a symlink path is unlinked, never followed.
      const info = await lstat(target);
      if (!info.isDirectory()) {
        await unlink(target);
        logger.debug({ agentId: ctx.agentId, path: relativePath }, 'delete_file success');
        return {
          success: true,
          data: { path: relativePath, deleted: true, filesDeleted: 1, bytesFreed: info.isFile() ? info.size : 0 },
        };
      }

      if (!recursive) return messages.isDirectory(relativePath, { forDelete: true });

      const tally = await tallyFolder(target, limits.maxDeleteFiles);
      if (tally.overLimit) return messages.deleteTooMany(relativePath, limits.maxDeleteFiles);

      await rm(target, { recursive: true });
      logger.info({ agentId: ctx.agentId, path: relativePath, filesDeleted: tally.files, bytesFreed: tally.bytes }, 'delete_file recursive success');
      return {
        success: true,
        data: { path: relativePath, deleted: true, filesDeleted: tally.files, bytesFreed: tally.bytes },
      };
    } catch (error) {
      logger.warn({ agentId: ctx.agentId, path: relativePath, err: error instanceof Error ? error.message : String(error) }, 'delete_file error');
      return messages.fromFsError(error, { action: 'deleting', path: relativePath, isDeletePath: true });
    }
  },
};

/**
 * Count the files under a folder and sum their sizes without following symlinks.
 * Symlinks count as files (they are removed as links). Stops once `maxFiles` is passed.
 */
async function tallyFolder(folder: string, maxFiles: number): Promise<FolderTally> {
  const tally: FolderTally = { files: 0, bytes: 0, overLimit: false };

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (tally.overLimit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      tally.files++;
      if (tally.files > maxFiles) {
        tally.overLimit = true;
        return;
      }
      if (entry.isFile()) tally.bytes += (await lstat(full)).size;
    }
  }

  await walk(folder);
  return tally;
}
