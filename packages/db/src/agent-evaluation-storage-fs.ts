import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { EvaluationArtifactStore, EvaluationArtifactRef } from '@herobids/domain';

// ── MIME type resolution ────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.txt': 'text/plain',
  '.html': 'text/html',
};

function mimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// ── Filesystem store ────────────────────────────────────────────────────────

/**
 * Filesystem-backed implementation of `EvaluationArtifactStore`.
 *
 * Artifacts are stored under `<rootDir>/<runId>/<artifactName>`.
 * The root directory is resolved as follows:
 *   1. Constructor argument (used by tests)
 *   2. `EVALUATION_STORAGE_ROOT` env var (used in Docker to share across containers)
 *   3. `app-data/evaluation-output/` relative to the working directory (local dev)
 *
 * Shared by the API (artifact downloads) and worker (artifact writes).
 */
export class FsEvaluationArtifactStore implements EvaluationArtifactStore {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir
      ?? process.env['EVALUATION_STORAGE_ROOT']
      ?? join(process.cwd(), 'app-data', 'evaluation-output');
  }

  // ── Write ───────────────────────────────────────────────────────────────

  async write(runId: string, name: string, content: Uint8Array | string): Promise<EvaluationArtifactRef> {
    const runDir = join(this.rootDir, runId);
    await mkdir(runDir, { recursive: true });

    const filePath = join(runDir, name);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    await writeFile(filePath, buf);

    const st = await stat(filePath);
    return { name, mimeType: mimeType(name), sizeBytes: st.size };
  }

  // ── Read ────────────────────────────────────────────────────────────────

  async read(runId: string, name: string): Promise<Uint8Array | null> {
    const filePath = join(this.rootDir, runId, name);
    if (!existsSync(filePath)) return null;
    const buf = await readFile(filePath);
    return new Uint8Array(buf);
  }

  // ── List ────────────────────────────────────────────────────────────────

  async list(runId: string): Promise<EvaluationArtifactRef[]> {
    const runDir = join(this.rootDir, runId);
    if (!existsSync(runDir)) return [];

    const names = await readdir(runDir);
    const refs: EvaluationArtifactRef[] = [];

    for (const name of names) {
      const filePath = join(runDir, name);
      try {
        const st = await stat(filePath);
        if (st.isFile()) {
          refs.push({ name, mimeType: mimeType(name), sizeBytes: st.size });
        }
      } catch {
        // Skip files that disappear between readdir and stat
      }
    }

    return refs;
  }
}
