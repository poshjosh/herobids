import { mkdir } from 'node:fs/promises';
import { resolve, normalize, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';

/** Logical reserved directory names inside the workspace root. */
const RESERVED_DIRS = new Set(['sandbox']);

export interface WorkspacePaths {
  root: string;
  sandbox: string;
}

/**
 * Resolve the workspace root and sandbox for a given agent.
 *
 * Docker mode: uses AGENT_WORKSPACE_ROOT env (default /workspace).
 * Stub mode: uses a per-agent directory under /tmp/herobids-agent-workspaces/<agentId>.
 */
export function getWorkspacePaths(agentId: string): WorkspacePaths {
  const envRoot = process.env['AGENT_WORKSPACE_ROOT'];
  const root = envRoot ? envRoot : `/tmp/herobids-agent-workspaces/${agentId}`;
  const sandbox = `${root}/sandbox`;
  return { root, sandbox };
}

/**
 * Ensure the workspace root and sandbox directories exist.
 * Safe to call multiple times (recursive + force-create).
 */
export async function ensureWorkspaceDirs(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.sandbox, { recursive: true });
}

/**
 * Resolve a relative path against the workspace root and verify it stays
 * inside the workspace root (no `..` escapes or symlink escapes).
 *
 * Returns the absolute path on success, or an error message string on failure.
 */
export async function resolveWorkspacePath(
  root: string,
  relativePath: string,
): Promise<{ ok: true; absolutePath: string } | { ok: false; error: string }> {
  // Reject absolute paths — callers must supply relative paths
  if (isAbsolute(relativePath)) {
    return { ok: false, error: 'path must be relative to the workspace root' };
  }

  // Reject any path component that looks like traversal before resolution
  const normalized = normalize(relativePath);
  if (normalized.startsWith('..')) {
    return { ok: false, error: 'path traversal is not allowed' };
  }

  const candidate = resolve(root, normalized);

  // Resolve the root's real path so we compare canonical paths
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    // Root may not exist yet — fall back to the non-symlink-resolved absolute path
    realRoot = resolve(root);
  }

  // For the candidate, resolve the nearest existing ancestor through realpath,
  // then reconstruct the full candidate path relative to that real ancestor.
  // This handles OS-level symlinks like macOS /tmp → /private/tmp.
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    // File doesn't exist yet — walk up to find the nearest existing ancestor
    let ancestor = candidate;
    let suffix = '';
    while (true) {
      const parent = resolve(ancestor, '..');
      if (parent === ancestor) {
        // Reached fs root without finding a real path — use candidate as-is
        realCandidate = candidate;
        break;
      }
      suffix = suffix ? `${ancestor.slice(parent.length + 1)}/${suffix}` : ancestor.slice(parent.length + 1);
      ancestor = parent;
      try {
        const realAncestor = await realpath(ancestor);
        realCandidate = suffix ? `${realAncestor}/${suffix}` : realAncestor;
        break;
      } catch {
        // keep walking up
      }
    }
  }

  if (!realCandidate.startsWith(realRoot + '/') && realCandidate !== realRoot) {
    return { ok: false, error: 'path escapes workspace root' };
  }

  return { ok: true, absolutePath: candidate };
}

/**
 * Check whether a relative path targets a reserved execution directory.
 * Returns an error string if reserved, undefined if allowed.
 */
export function checkReservedDir(relativePath: string): string | undefined {
  const normalized = normalize(relativePath);
  const firstSegment = normalized.split('/')[0];
  if (firstSegment && RESERVED_DIRS.has(firstSegment)) {
    return `'${firstSegment}' is a reserved directory`;
  }
  return undefined;
}
