import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchDatabase,
  localDatabaseUrl,
  readMigration,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';

// Runs only against a local Postgres (DATABASE_URL on localhost). It creates and drops its own
// database, so no existing data is read or changed. Skipped otherwise.
//
// Exercises migration 0092 (grant_any_*_to_children) on a database stopped at 0091, with agent
// rows that exist before the columns do.
const BASE_URL = localDatabaseUrl();
const PRE_MIGRATION = '0091_merge_ext_prefixed_skills.sql';
const MIGRATION = '0092_agent_child_grant_scope.sql';

describe.skipIf(!BASE_URL)('agent child grant scope columns (0092, integration)', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, PRE_MIGRATION);
    const sql = scratch.sql;
    await sql`INSERT INTO users (id, username, display_name, email) VALUES ('user-1', 'one', 'One', 'one@example.test')`;
    await sql`INSERT INTO agents (id, user_id, name, prompt, child_agent_limit) VALUES
      ('agent-plain', 'user-1', 'Plain', 'p', 0),
      ('agent-parent', 'user-1', 'Parent', 'p', 3)`;
    await sql.unsafe(readMigration(MIGRATION)).simple();
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('reads false for both settings on agent rows that existed before the migration', async () => {
    const rows = await scratch.sql`
      SELECT id, grant_any_skill_to_children, grant_any_connection_to_children FROM agents ORDER BY id`;
    expect(rows).toEqual([
      { id: 'agent-parent', grant_any_skill_to_children: false, grant_any_connection_to_children: false },
      { id: 'agent-plain', grant_any_skill_to_children: false, grant_any_connection_to_children: false },
    ]);
  });

  it('leaves existing columns untouched', async () => {
    const [row] = await scratch.sql`SELECT child_agent_limit FROM agents WHERE id = 'agent-parent'`;
    expect(row?.['child_agent_limit']).toBe(3);
  });

  it('defaults both settings to false for a row inserted without them', async () => {
    await scratch.sql`INSERT INTO agents (id, user_id, name, prompt) VALUES ('agent-new', 'user-1', 'New', 'p')`;
    const [row] = await scratch.sql`
      SELECT grant_any_skill_to_children, grant_any_connection_to_children FROM agents WHERE id = 'agent-new'`;
    expect(row).toEqual({ grant_any_skill_to_children: false, grant_any_connection_to_children: false });
  });
});
