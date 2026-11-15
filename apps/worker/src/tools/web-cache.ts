import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import { getWebCacheConfig } from './file-limits.js';
import { browseSaveErrorText, browseSaveFailedText } from './file-messages.js';
import { writeFileAtomic } from './file-write.js';
import { assertWithinQuota } from './workspace-quota.js';
import { ensureWorkspaceDirs, getWorkspacePaths, resolveWorkspacePath } from './workspace.js';

const logger = createLogger('tools:web-cache');

const BYTES_PER_MIB = 1024 * 1024;
const HASH_CHARS = 12;
const MAX_HOST_SLUG_CHARS = 60;

export type WebCacheSave =
  /** Saving is switched off (`sizeMb: 0`). Not an error. */
  | { status: 'disabled' }
  | { status: 'saved'; savedTo: string }
  /** Not saved; `saveError` is the text for the agent. */
  | { status: 'not_saved'; saveError: string };

/**
 * `<host-slug>-<sha256(url)[0..12]>.txt`. Derived from the final URL only, so the model
 * and the page cannot choose a path, and the same URL always maps to the same file.
 */
export function webCacheFileName(finalUrl: string): string {
  let host = '';
  try {
    host = new URL(finalUrl).hostname.toLowerCase();
  } catch {
    // An unparsable URL cannot reach here (the fetch succeeded); fall back to the hash alone.
  }
  const slug = host.replace(/[^a-z0-9.-]/g, '-').replace(/^[.-]+/, '').slice(0, MAX_HOST_SLUG_CHARS);
  const hash = createHash('sha256').update(finalUrl).digest('hex').slice(0, HASH_CHARS);
  return slug === '' ? `${hash}.txt` : `${slug}-${hash}.txt`;
}

/** Total bytes of the regular files directly inside the cache folder. */
async function cacheFolderBytes(cacheDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const name of entries) {
    try {
      const info = await lstat(join(cacheDir, name));
      if (info.isFile()) total += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return total;
}

async function existingFileBytes(absolutePath: string): Promise<number> {
  try {
    const info = await stat(absolutePath);
    return info.isFile() ? info.size : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Save the full cleaned text of a page that did not fit one result page.
 *
 * Order (Design 9): disabled check, cache cap, workspace quota, write. Nothing is ever
 * deleted here: a same-URL repeat visit replaces only its own file, and a full cache or
 * workspace just means "not saved" with a text telling the agent to free space.
 */
export async function saveToWebCache(agentId: string, finalUrl: string, text: string): Promise<WebCacheSave> {
  const { sizeMb, dir } = getWebCacheConfig();
  if (sizeMb === 0) return { status: 'disabled' };

  try {
    const paths = getWorkspacePaths(agentId);
    await ensureWorkspaceDirs(paths);
    const relativePath = `${dir}/${webCacheFileName(finalUrl)}`;
    const resolved = await resolveWorkspacePath(paths.root, relativePath);
    if (!resolved.ok) {
      logger.warn({ agentId, relativePath }, 'web cache path rejected; page not saved');
      return { status: 'not_saved', saveError: browseSaveFailedText() };
    }

    const cacheDir = join(paths.root, dir);
    const data = Buffer.from(text, 'utf8');
    const ownBytes = await existingFileBytes(resolved.absolutePath);
    const growth = data.length - ownBytes;

    // Cache cap: a re-save of the same URL only counts at its net growth.
    const folderBytes = await cacheFolderBytes(cacheDir);
    if (folderBytes + growth > sizeMb * BYTES_PER_MIB) {
      return { status: 'not_saved', saveError: browseSaveErrorText() };
    }

    const quota = await assertWithinQuota(paths.root, Math.max(growth, 0));
    if (!quota.ok) return { status: 'not_saved', saveError: browseSaveErrorText() };

    await mkdir(cacheDir, { recursive: true });
    await writeFileAtomic(resolved.absolutePath, data);
    return { status: 'saved', savedTo: relativePath };
  } catch (error) {
    // A page is still useful without its saved copy, so this is not a tool failure.
    logger.warn(
      { agentId, err: error instanceof Error ? error.message : String(error) },
      'web cache save failed; returning the first page only',
    );
    return { status: 'not_saved', saveError: browseSaveFailedText() };
  }
}
