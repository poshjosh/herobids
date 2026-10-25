import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createScratchDatabase,
  localDatabaseUrl,
  readMigration,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';

// Runs only against a local Postgres (DATABASE_URL on localhost). It creates and drops its own
// database, so no existing data is read or changed. Skipped otherwise.
// Historical: it exercises migration 0077 on a database stopped at 0076, before the C1 cutover drops the legacy columns.
const BASE_URL = localDatabaseUrl();
const PRE_BACKFILL = '0076_absent_starhawk.sql';
const BACKFILL = '0077_chat_addresses_backfill.sql';

describe.skipIf(!BASE_URL)('chat_addresses backfill (0077, integration)', () => {
  let scratch: ScratchDatabase;

  const runBackfill = () => scratch.sql.unsafe(readMigration(BACKFILL)).simple();

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, PRE_BACKFILL);
    const sql = scratch.sql;

    await sql`INSERT INTO users (id, username, display_name, email, telegram_chat_id) VALUES
      ('user-padded', 'padded', 'Padded', 'padded@example.test', '  5550001  '),
      ('user-blank', 'blank', 'Blank', 'blank@example.test', '   '),
      ('user-unset', 'unset', 'Unset', 'unset@example.test', NULL)`;
    await sql`INSERT INTO agents (id, user_id, name, prompt, telegram_chat_id) VALUES
      ('agent-override', 'user-padded', 'Override', 'p', '  6600002 '),
      ('agent-inherits', 'user-padded', 'Inherits', 'p', NULL),
      ('agent-blank', 'user-padded', 'Blank', 'p', '   '),
      ('agent-other', 'user-blank', 'Other', 'p', NULL)`;
    await sql`INSERT INTO agent_outbound_messages
        (id, agent_id, authored_by, body, telegram_message_id, telegram_chat_id, delivery_provider, delivery_address, provider_message_id)
      VALUES
        ('out-telegram', 'agent-override', 'agent', 'hi', '4242', '6600002', NULL, NULL, NULL),
        ('out-plain', 'agent-inherits', 'agent', 'hi', NULL, NULL, NULL, NULL, NULL),
        ('out-neutral', 'agent-override', 'agent', 'hi', '9', '6600002', 'whatsapp', '+15555550100', NULL)`;

    await runBackfill();
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const telegramAddresses = () => scratch.sql`
    SELECT "user_id", "agent_id", "address", "status", "verified_at" IS NOT NULL AS "verified", "consent_source"
    FROM "chat_addresses" WHERE "provider" = 'telegram'
    ORDER BY "user_id", "agent_id" NULLS FIRST`;

  it('stores trimmed user-level and agent-level Telegram chat IDs as active, verified addresses', async () => {
    await expect(telegramAddresses()).resolves.toEqual([
      { user_id: 'user-padded', agent_id: null, address: '5550001', status: 'active', verified: true, consent_source: null },
      { user_id: 'user-padded', agent_id: 'agent-override', address: '6600002', status: 'active', verified: true, consent_source: null },
    ]);
  });

  it('creates no address for blank or unset legacy chat IDs', async () => {
    const rows = await telegramAddresses();
    expect(rows.map((row) => row.user_id)).not.toContain('user-blank');
    expect(rows.map((row) => row.user_id)).not.toContain('user-unset');
    expect(rows.map((row) => row.agent_id)).not.toContain('agent-blank');
  });

  it('copies Telegram delivery columns onto outbound rows that carry a Telegram message ID only', async () => {
    const rows = await scratch.sql`
      SELECT "id", "delivery_provider", "delivery_address", "provider_message_id"
      FROM "agent_outbound_messages" ORDER BY "id"`;
    expect(rows).toEqual([
      { id: 'out-neutral', delivery_provider: 'whatsapp', delivery_address: '+15555550100', provider_message_id: null },
      { id: 'out-plain', delivery_provider: null, delivery_address: null, provider_message_id: null },
      { id: 'out-telegram', delivery_provider: 'telegram', delivery_address: '6600002', provider_message_id: '4242' },
    ]);
  });

  it('leaves the legacy Telegram columns unchanged', async () => {
    const users = await scratch.sql`SELECT "id", "telegram_chat_id" FROM "users" ORDER BY "id"`;
    const agents = await scratch.sql`SELECT "id", "telegram_chat_id" FROM "agents" ORDER BY "id"`;
    expect(users).toEqual([
      { id: 'user-blank', telegram_chat_id: '   ' },
      { id: 'user-padded', telegram_chat_id: '  5550001  ' },
      { id: 'user-unset', telegram_chat_id: null },
    ]);
    expect(agents).toEqual([
      { id: 'agent-blank', telegram_chat_id: '   ' },
      { id: 'agent-inherits', telegram_chat_id: null },
      { id: 'agent-other', telegram_chat_id: null },
      { id: 'agent-override', telegram_chat_id: '  6600002 ' },
    ]);
  });

  it('rejects a second Telegram address for the same user and agent scope', async () => {
    await expect(scratch.sql`
      INSERT INTO "chat_addresses" ("id", "user_id", "agent_id", "provider", "address", "status")
      VALUES ('dup-user-level', 'user-padded', NULL, 'telegram', '7770007', 'active')`)
      .rejects.toMatchObject({ code: '23505' });
  });

  it('changes nothing when the backfill runs again', async () => {
    const addressesBefore = await scratch.sql`SELECT * FROM "chat_addresses" ORDER BY "id"`;
    const outboundBefore = await scratch.sql`SELECT * FROM "agent_outbound_messages" ORDER BY "id"`;

    await runBackfill();

    await expect(scratch.sql`SELECT * FROM "chat_addresses" ORDER BY "id"`).resolves.toEqual(addressesBefore);
    await expect(scratch.sql`SELECT * FROM "agent_outbound_messages" ORDER BY "id"`).resolves.toEqual(outboundBefore);
  });
});
