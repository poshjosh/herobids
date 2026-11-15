import { randomUUID } from 'node:crypto';
import { chmod, chown, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolResult } from '@herobids/domain';
import { createLogger } from '../logger.js';
import { getFileToolLimits } from './file-limits.js';
import * as messages from './file-messages.js';
import { countCodePoints } from './file-text.js';
import { assertWithinQuota } from './workspace-quota.js';
import { checkReservedDir, ensureWorkspaceDirs, getWorkspacePaths, resolveWorkspacePath } from './workspace.js';

const logger = createLogger('tools:file-write');

export interface ExistingFile {
  sizeBytes: number;
  mode: number;
  uid: number;
  gid: number;
}

export type WritableTarget =
  | { ok: true; root: string; absolutePath: string; existing: ExistingFile | undefined }
  | { ok: false; result: ToolResult };

/**
 * Shared write-side path checks: reserved directory, workspace path safety, and what is
 * already at the path. A directory or a non-regular file (FIFO, device) is refused, so a
 * write can never block on a pipe planted by sandboxed code.
 */
export async function resolveWritableTarget(
  agentId: string,
  relativePath: string,
  options: { mustExist?: boolean } = {},
): Promise<WritableTarget> {
  if (checkReservedDir(relativePath) !== undefined) return { ok: false, result: messages.reservedPath() };

  const paths = getWorkspacePaths(agentId);
  await ensureWorkspaceDirs(paths);

  const resolved = await resolveWorkspacePath(paths.root, relativePath);
  if (!resolved.ok) return { ok: false, result: messages.pathInvalid(relativePath) };

  try {
    const fileStat = await stat(resolved.absolutePath);
    if (fileStat.isDirectory()) return { ok: false, result: messages.isDirectory(relativePath) };
    if (!fileStat.isFile()) return { ok: false, result: messages.notAFile(relativePath, 'written') };
    return {
      ok: true,
      root: paths.root,
      absolutePath: resolved.absolutePath,
      existing: { sizeBytes: fileStat.size, mode: fileStat.mode, uid: fileStat.uid, gid: fileStat.gid },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, result: messages.fromFsError(error, { action: 'writing', path: relativePath }) };
    }
    if (options.mustExist) return { ok: false, result: messages.notFound(relativePath) };
    return { ok: true, root: paths.root, absolutePath: resolved.absolutePath, existing: undefined };
  }
}

/** Per-call text cap (`writeMaxChars`, in characters). Returns an error result when over. */
export function checkWriteChars(
  content: string,
  tool: 'write_file' | 'append_file' | 'edit_file',
): ToolResult | undefined {
  const { writeMaxChars } = getFileToolLimits();
  // UTF-16 length is an upper bound of the code point count, so short strings skip the count.
  if (content.length <= writeMaxChars) return undefined;
  const chars = countCodePoints(content);
  return chars > writeMaxChars ? messages.contentTooLong(chars, writeMaxChars, tool) : undefined;
}

/**
 * Size and soft quota checks before a write. `resultingBytes` is the size the file will
 * have; `growthBytes` is the net growth of the workspace (only growth is checked, so
 * shrinking or same-size writes always pass).
 */
export async function checkWriteBudget(
  root: string,
  relativePath: string,
  resultingBytes: number,
  growthBytes: number,
): Promise<ToolResult | undefined> {
  const { maxFileBytes } = getFileToolLimits();
  if (resultingBytes > maxFileBytes) return messages.writeTooLarge(relativePath, resultingBytes, maxFileBytes);
  if (growthBytes <= 0) return undefined;
  const quota = await assertWithinQuota(root, growthBytes);
  return quota.ok ? undefined : messages.quotaExceeded(quota.error);
}

/**
 * Replace a file atomically: write a temp file in the same directory (`wx`), then rename.
 * The temp file is removed on any error. Rename swaps the inode, so the mode is copied
 * and the owner is restored on a best-effort basis: the runtime is root, and without this
 * a file made by sandboxed code (user `agent`) would become unwritable for that code.
 */
export async function writeFileAtomic(
  target: string,
  data: Buffer,
  original?: Pick<ExistingFile, 'mode' | 'uid' | 'gid'>,
): Promise<void> {
  const temp = join(dirname(target), `.write-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, data, { flag: 'wx' });
    if (original) {
      await chmod(temp, original.mode & 0o7777);
      await restoreOwner(temp, original.uid, original.gid);
    }
    await rename(temp, target);
  } catch (error) {
    await removeTemp(temp);
    throw error;
  }
}

async function restoreOwner(path: string, uid: number, gid: number): Promise<void> {
  try {
    await chown(path, uid, gid);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error), uid, gid }, 'could not restore file owner after atomic write');
  }
}

async function removeTemp(temp: string): Promise<void> {
  try {
    await unlink(temp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'could not remove temp file after failed atomic write');
  }
}
