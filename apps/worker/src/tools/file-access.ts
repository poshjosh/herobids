import { stat } from 'node:fs/promises';
import type { ToolResult } from '@herobids/domain';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { ensureWorkspaceDirs, getWorkspacePaths, resolveWorkspacePath } from './workspace.js';

export type ReadableFile =
  | { ok: true; absolutePath: string; sizeBytes: number }
  | { ok: false; result: ToolResult };

/**
 * Shared read-side path checks: workspace path safety, existence, regular file, size cap.
 * Reads of `sandbox/` are allowed (existing behaviour), so no reserved-directory check.
 * `stat` follows symlinks, so a FIFO or device planted by sandboxed code is refused
 * instead of blocking a read forever.
 */
export async function resolveReadableFile(
  agentId: string,
  relativePath: string,
  action: string,
): Promise<ReadableFile> {
  const paths = getWorkspacePaths(agentId);
  await ensureWorkspaceDirs(paths);

  const resolved = await resolveWorkspacePath(paths.root, relativePath);
  if (!resolved.ok) return { ok: false, result: messages.pathInvalid(relativePath) };

  try {
    const fileStat = await stat(resolved.absolutePath);
    if (fileStat.isDirectory()) return { ok: false, result: messages.isDirectory(relativePath) };
    if (!fileStat.isFile()) return { ok: false, result: messages.notAFile(relativePath) };
    const { maxFileBytes } = getFileToolLimits();
    if (fileStat.size > maxFileBytes) {
      return { ok: false, result: messages.tooLarge(relativePath, fileStat.size, maxFileBytes) };
    }
    return { ok: true, absolutePath: resolved.absolutePath, sizeBytes: fileStat.size };
  } catch (error) {
    return { ok: false, result: messages.fromFsError(error, { action, path: relativePath }) };
  }
}
