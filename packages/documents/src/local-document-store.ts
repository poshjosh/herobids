import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentStore, DocumentStoreError, Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

/**
 * Filesystem-backed {@link DocumentStore}.
 *
 * Objects live under `rootDir` and are keyed by relative path. The caller's
 * {@link DocumentStore.put | `storeKey`} is used verbatim as the relative path,
 * so callers should construct it with a scheme that avoids collisions (e.g.
 * `documents/<uuid>-<filename>`).
 */
export class LocalDocumentStore implements DocumentStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async put(params: {
    keyHint: string;
    contentType: string;
    body: Buffer;
  }): Promise<Result<{ storeKey: string; sizeBytes: number }, DocumentStoreError>> {
    try {
      const safeHint = sanitizeKeyHint(params.keyHint);
      // Use a UUID-based key to avoid collisions, preserving the hint as a suffix for debuggability.
      const storeKey = `${randomUUID()}-${safeHint}`;
      const fullPath = join(this.rootDir, storeKey);
      const metaPath = `${fullPath}.meta`;
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, params.body);
      await writeFile(metaPath, JSON.stringify({
        contentType: params.contentType,
        sizeBytes: params.body.byteLength,
      }), 'utf-8');

      return ok({ storeKey, sizeBytes: params.body.byteLength });
    } catch (error) {
      return err({
        code: 'document_store.write_failed',
        message: `Failed to store document: ${(error as Error).message}`,
        context: { hint: params.keyHint },
      });
    }
  }

  async getMetadata(storeKey: string): Promise<Result<{ contentType: string; sizeBytes: number }, DocumentStoreError>> {
    try {
      const fullPath = join(this.rootDir, storeKey);
      const metaPath = `${fullPath}.meta`;
      const metaRaw = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw) as { contentType: string; sizeBytes: number };
      return ok({
        contentType: meta.contentType,
        sizeBytes: meta.sizeBytes,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'document_store.not_found'
        : 'document_store.read_failed';
      return err({
        code,
        message: `Failed to get metadata for ${storeKey}: ${(error as Error).message}`,
        context: { storeKey },
      });
    }
  }

  async read(storeKey: string): Promise<Result<Buffer, DocumentStoreError>> {
    try {
      const fullPath = join(this.rootDir, storeKey);
      const data = await readFile(fullPath);
      return ok(data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'document_store.not_found'
        : 'document_store.read_failed';
      return err({
        code,
        message: `Failed to read ${storeKey}: ${(error as Error).message}`,
        context: { storeKey },
      });
    }
  }

  async delete(storeKey: string): Promise<Result<void, DocumentStoreError>> {
    try {
      const fullPath = join(this.rootDir, storeKey);
      const metaPath = `${fullPath}.meta`;
      // Best-effort: try to delete both blob and meta; ignore ENOENT for either.
      await Promise.allSettled([
        unlink(fullPath),
        unlink(metaPath),
      ]);
      return ok(undefined);
    } catch (error) {
      // Idempotent: ENOENT is not an error.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ok(undefined);
      }
      return err({
        code: 'document_store.delete_failed',
        message: `Failed to delete ${storeKey}: ${(error as Error).message}`,
        context: { storeKey },
      });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sanitize a key hint for safe use as a filesystem path component.
 * Strips directory traversal sequences, null bytes, and other dangerous chars.
 */
function sanitizeKeyHint(hint: string): string {
  return hint
    .replace(/\x00/g, '')           // null bytes
    .replace(/\.\./g, '_')          // directory traversal
    .replace(/[/\\:*?"<>|]/g, '_')  // path separators & reserved chars
    .trim()
    .slice(0, 1024) || 'unnamed';
}
