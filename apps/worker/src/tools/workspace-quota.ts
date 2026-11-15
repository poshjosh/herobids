import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '@herobids/domain';
import { getFileToolLimits, getWorkspaceQuotaBytes } from './file-limits.js';

export interface DirUsage {
  name: string;
  bytes: number;
}

export interface WorkspaceUsage {
  usedBytes: number;
  fileCount: number;
  /** True when the walk stopped at `quotaWalkMaxFiles`, so `usedBytes` is a lower bound. */
  walkCapped: boolean;
  /** Top-level folders, largest first. Platform and dependency folders are not listed. */
  topDirs: DirUsage[];
}

export interface QuotaFailure {
  code: 'file.quota_exceeded';
  reason: 'over_quota' | 'walk_capped';
  usedBytes: number;
  quotaBytes: number;
  addBytes: number;
  walkMaxFiles: number;
  topDirs: DirUsage[];
}

/**
 * Sum the size of regular files in the workspace. Symlinks are not followed.
 * Skips `platformDirs` (top level only) and `dependencyDirs` (any depth): the first hold
 * platform-installed skill copies and `sandbox/`, the second can hold thousands of files
 * the agent cannot remove one by one.
 */
export async function getWorkspaceUsage(root: string): Promise<WorkspaceUsage> {
  const limits = getFileToolLimits();
  const platformDirs = new Set(limits.platformDirs);
  const dependencyDirs = new Set(limits.dependencyDirs);
  const perTopDir = new Map<string, number>();
  let usedBytes = 0;
  let fileCount = 0;
  let walkCapped = false;

  async function walk(dir: string, topDir: string | undefined): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // Only a missing root means "empty workspace". A folder or file that vanished
      // mid-walk (deleted by sandboxed code) is skipped on its own.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (walkCapped) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (dependencyDirs.has(entry.name)) continue;
        if (topDir === undefined) {
          if (platformDirs.has(entry.name)) continue;
          perTopDir.set(entry.name, perTopDir.get(entry.name) ?? 0);
        }
        await walk(join(dir, entry.name), topDir ?? entry.name);
      } else if (entry.isFile()) {
        if (fileCount >= limits.quotaWalkMaxFiles) {
          walkCapped = true;
          return;
        }
        let size: number;
        try {
          ({ size } = await lstat(join(dir, entry.name)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        fileCount++;
        usedBytes += size;
        if (topDir !== undefined) perTopDir.set(topDir, (perTopDir.get(topDir) ?? 0) + size);
      }
    }
  }

  // A missing root (workspace not created yet) is handled by `walk` as an empty folder.
  await walk(root, undefined);

  const topDirs = [...perTopDir.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
  return { usedBytes, fileCount, walkCapped, topDirs };
}

/**
 * Soft quota check before a write that grows the workspace by `addBytes` (net growth).
 * A write that lands exactly on the quota is allowed. Fails loudly when the walk hit its
 * file cap, because the usage is then unknown.
 */
export async function assertWithinQuota(
  root: string,
  addBytes: number,
): Promise<Result<WorkspaceUsage, QuotaFailure>> {
  const usage = await getWorkspaceUsage(root);
  const quotaBytes = getWorkspaceQuotaBytes();
  const base = {
    code: 'file.quota_exceeded' as const,
    usedBytes: usage.usedBytes,
    quotaBytes,
    addBytes,
    walkMaxFiles: getFileToolLimits().quotaWalkMaxFiles,
    topDirs: usage.topDirs,
  };
  if (usage.walkCapped) return err({ ...base, reason: 'walk_capped' });
  if (usage.usedBytes + Math.max(addBytes, 0) > quotaBytes) return err({ ...base, reason: 'over_quota' });
  return ok(usage);
}
