import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIGRATIONS_DIR = new URL('../../drizzle/', import.meta.url);

/**
 * DATABASE_URL, but only when it points at this machine. Tests that create scratch
 * databases must never run against a shared or remote server, so anything else yields null.
 */
export function localDatabaseUrl(): string | null {
  const raw = process.env['DATABASE_URL'];
  if (!raw) return null;
  try {
    return LOCAL_HOSTNAMES.has(new URL(raw).hostname) ? raw : null;
  } catch {
    return null;
  }
}

/** Migration file names in journal order (the 4-digit prefix sorts them). */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

export function readMigration(fileName: string): string {
  return readFileSync(new URL(fileName, MIGRATIONS_DIR), 'utf8');
}

function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export interface ScratchDatabase {
  sql: postgres.Sql;
  drop: () => Promise<void>;
}

/**
 * Creates an empty, uniquely named database on the server behind `baseUrl` and applies every
 * migration up to and including `lastMigration`. The database is dropped by `drop()`.
 * Migration SQL hardcodes the public schema, so a schema-only isolation would not work.
 */
export async function createScratchDatabase(baseUrl: string, lastMigration: string): Promise<ScratchDatabase> {
  const name = `herobids_scratch_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(withDatabaseName(baseUrl, 'postgres'), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const sql = postgres(withDatabaseName(baseUrl, name), { max: 1 });
  const drop = async (): Promise<void> => {
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  };

  try {
    for (const file of migrationFiles().filter((f) => f <= lastMigration)) {
      await sql.unsafe(readMigration(file)).simple();
    }
  } catch (error) {
    await drop();
    throw error;
  }
  return { sql, drop };
}
