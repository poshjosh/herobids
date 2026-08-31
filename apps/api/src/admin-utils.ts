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

// ---------------------------------------------------------------------------
// Docker container helpers — shared by admin routes and the health publisher
// ---------------------------------------------------------------------------

const AGENT_CONTAINER_FILTER = encodeURIComponent(JSON.stringify({ label: ['herobids.role=agent'] }));
const DOCKER_SOCKET = process.env['DOCKER_SOCKET_PATH'] ?? '/var/run/docker.sock';

function parseDockerTcpHost(): { hostname: string; port: number } | null {
  const host = process.env['DOCKER_HOST'];
  if (!host?.startsWith('tcp://')) return null;
  const parts = host.slice(6).split(':');
  const hostname = parts[0];
  if (!hostname) return null;
  return { hostname, port: parseInt(parts[1] ?? '2375', 10) };
}

const DOCKER_TCP_HOST = parseDockerTcpHost();

/** Send a single HTTP GET to the Docker daemon and return the parsed JSON body.
 * Uses TCP (docker-proxy) when DOCKER_HOST=tcp://... is set; falls back to Unix socket. */
export async function dockerSocketGet(path: string): Promise<unknown> {
  if (DOCKER_TCP_HOST) {
    const { default: http } = await import('node:http');
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: DOCKER_TCP_HOST.hostname, port: DOCKER_TCP_HOST.port, path, timeout: 3000 },
        (res) => {
          let rawData = '';
          res.on('data', (chunk: Buffer) => { rawData += chunk.toString(); });
          res.on('end', () => {
            try { resolve(JSON.parse(rawData)); }
            catch { reject(new Error('Non-JSON response from Docker TCP')); }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('Docker TCP timeout')); });
    });
  }

  const { default: net } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(DOCKER_SOCKET);
    let rawData = '';
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => { rawData += chunk.toString(); });
    socket.on('end', () => {
      const bodyStart = rawData.indexOf('\r\n\r\n');
      if (bodyStart === -1) return reject(new Error('Malformed HTTP response'));
      try {
        resolve(JSON.parse(rawData.slice(bodyStart + 4)));
      } catch {
        reject(new Error('Non-JSON response from Docker socket'));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy(new Error('Docker socket timeout'));
    });
  });
}

/** Query running agent containers from Docker. Returns the raw container list. */
export async function dockerSocketGetAgentContainers(): Promise<unknown[]> {
  const result = await dockerIo.get(`/containers/json?all=false&size=1&filters=${AGENT_CONTAINER_FILTER}`);
  return Array.isArray(result) ? result : [];
}

/** Best-effort count of running agent containers. Returns null when Docker is unavailable. */
export async function getRunningContainerCount(): Promise<number | null> {
  try {
    const containers = await dockerSocketGetAgentContainers();
    return containers.length;
  } catch {
    return null;
  }
}

/**
 * Indirection layer for Docker I/O — allows tests to replace `dockerSocketGet`
 * without needing to mock Node.js built-in modules (whose dynamic imports are
 * not interceptable by vitest in ESM).
 */
export const dockerIo = {
  get: dockerSocketGet,
};
