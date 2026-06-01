import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index.js';

/**
 * Opens a real Postgres connection for integration tests.
 * Requires DATABASE_URL env var to be set.
 * Call client.end() in afterAll to release the connection.
 */
export function openTestDb() {
  const url = process.env['DATABASE_URL']!;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  return { db, client };
}

/** db type alias for use in integration test files */
export type TestDb = ReturnType<typeof openTestDb>['db'];

/** Truncate one or more tables (CASCADE). Only for test databases. */
export async function truncate(
  client: ReturnType<typeof postgres>,
  ...tables: string[]
): Promise<void> {
  if (tables.length === 0) return;
  await client.unsafe(`TRUNCATE ${tables.join(', ')} CASCADE`);
}
