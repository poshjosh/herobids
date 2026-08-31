/**
 * Shared admin utilities — health checks and version parsing used by both
 * the admin routes and the server health publisher.
 */
import { statfsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql, count, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentRuntimeSessions } from '@herobids/db';

/** Get disk usage for the root filesystem (or a configured path). */
export function getDiskStats(): { totalBytes: number; freeBytes: number; usedBytes: number } | null {
  try {
    const stat = statfsSync('/');
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bfree * stat.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    return null;
  }
}

/** Check database connectivity with a timeout. */
export async function checkPostgres(db: Database): Promise<'ok' | 'timeout' | 'error'> {
  try {
    const result = await Promise.race<'ok' | 'timeout'>([
      db.execute(sql`SELECT 1`).then(() => 'ok' as const),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 1500)),
    ]);
    return result;
  } catch {
    return 'error';
  }
}

/** Check Redis connectivity with a timeout. */
export async function checkRedis(redis: { ping(): Promise<string> }): Promise<'ok' | 'timeout' | 'error'> {
  try {
    const result = await Promise.race<'ok' | 'timeout'>([
      redis.ping().then(() => 'ok' as const),
      new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 1500)),
    ]);
    return result;
  } catch {
    return 'error';
  }
}

export function parseAppVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Try monorepo root package.json first (../ from apps/api/src or dist).
  // In production Docker images the root package.json is copied into the runtime image
  // for this purpose. Fall back to the API's own package.json if the root is missing.
  const candidates = [
    join(__dirname, '../../../package.json'),   // monorepo root (works in dev + Docker with COPY)
    join(__dirname, '../package.json'),           // API package (pnpm deploy output)
  ];
  for (const pkgPath of candidates) {
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    } catch {
      // try next candidate
    }
  }
  return 'parse-failed';
}


/** Count non-terminal agent runtime sessions (starting, launching, running, unhealthy). */
export async function getRunningSessionCount(db: Database): Promise<number> {
  const rows = await db
    .select({ n: count(agentRuntimeSessions.id) })
    .from(agentRuntimeSessions)
    .where(inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']));
  return rows[0]?.n ?? 0;
}
