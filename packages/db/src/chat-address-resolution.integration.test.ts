import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  AgentRepository,
  listChatAddressesForOutput,
  revokeChatAddress,
  setChatAddress,
} from './agent-repository.js';
import * as schema from './schema/index.js';
import {
  createScratchDatabase,
  localDatabaseUrl,
  readMigration,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';
import { truncate } from './test-helpers/integration-db.js';

// Runs only against a local Postgres (DATABASE_URL on localhost), in a database it creates and drops.
// Skipped otherwise. After the C1 cutover, addresses live in chat_addresses and opt-outs in
// chat_suppressions; reply correlation reads conversation_messages.
const BASE_URL = localDatabaseUrl();
const ALL_MIGRATIONS = '9999_all.sql';

describe.skipIf(!BASE_URL)('chat address resolution on neutral rows (integration)', () => {
  let scratch: ScratchDatabase;
  let repo: AgentRepository;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, ALL_MIGRATIONS);
    db = drizzle(scratch.sql, { schema });
    repo = new AgentRepository(db);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await truncate(scratch.sql, 'conversations', 'chat_addresses', 'chat_suppressions', 'agents', 'users');
    const sql = scratch.sql;
    await sql`INSERT INTO users (id, username, display_name, email) VALUES
      ('user-1', 'owner', 'Owner', 'owner@example.test'),
      ('user-2', 'other', 'Other', 'other@example.test')`;
    await sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES
      ('agent-1', 'user-1', 'Momo', 'p', 'active'),
      ('agent-2', 'user-1', 'Kofi', 'p', 'active'),
      ('agent-3', 'user-2', 'Ama', 'p', 'active')`;
  });

  const userScope = { userId: 'user-1', agentId: null };
  const agentOneScope = { userId: 'user-1', agentId: 'agent-1' };
  const agentOne = { agentId: 'agent-1', agentName: 'Momo', status: 'active', userId: 'user-1' };

  const addressRows = () => scratch.sql`
    SELECT "user_id", "agent_id", "provider", "address", "status" FROM "chat_addresses"
    ORDER BY "user_id", "agent_id" NULLS FIRST, "provider"`;
  const suppressionRows = () => scratch.sql`
    SELECT "provider", "address", "status" FROM "chat_suppressions" ORDER BY "provider", "address"`;

  // The message the agent sent to the chat (delivered, with the id Telegram returned).
  async function addOutbound(
    id: string,
    agentId: string,
    providerMessageId: string,
    channel = 'telegram',
    // A second after the address was saved, so a skew between this clock and the database clock cannot flip the order.
    createdAt: Date = new Date(Date.now() + 1_000),
  ) {
    const conversationId = `user_agent:${agentId}`;
    const [agent] = await scratch.sql`SELECT "user_id" FROM agents WHERE id = ${agentId}`;
    await scratch.sql`INSERT INTO conversations (id, kind, owner_user_id)
      VALUES (${conversationId}, 'user_agent', ${agent!.user_id}) ON CONFLICT DO NOTHING`;
    await scratch.sql`INSERT INTO conversation_participants (conversation_id, participant_type, participant_id)
      VALUES (${conversationId}, 'user', ${agent!.user_id}), (${conversationId}, 'agent', ${agentId}) ON CONFLICT DO NOTHING`;
    await scratch.sql`INSERT INTO conversation_messages
        (id, conversation_id, sender_type, sender_id, channel, body, delivery_status, provider_message_id, created_at)
      VALUES (${id}, ${conversationId}, 'agent', ${agentId}, ${channel}, 'hi', 'sent', ${providerMessageId},
        ${createdAt.toISOString()}::timestamptz)`;
  }

  describe('setChatAddress', () => {
    it('stores a trimmed address as an active row', async () => {
      await setChatAddress(db, userScope, 'telegram', '  5550001  ');
      await expect(addressRows()).resolves.toEqual([
        { user_id: 'user-1', agent_id: null, provider: 'telegram', address: '5550001', status: 'active' },
      ]);
    });

    it('replaces the address on a second save and keeps one row per scope', async () => {
      await setChatAddress(db, agentOneScope, 'telegram', '111');
      await setChatAddress(db, agentOneScope, 'telegram', '222');
      await expect(addressRows()).resolves.toEqual([
        { user_id: 'user-1', agent_id: 'agent-1', provider: 'telegram', address: '222', status: 'active' },
      ]);
    });

    it.each([null, '', '   '])('clearing the address with %j leaves no row', async (blank) => {
      await setChatAddress(db, agentOneScope, 'telegram', '111');
      await setChatAddress(db, agentOneScope, 'telegram', blank);
      await expect(addressRows()).resolves.toEqual([]);
    });

    it('clearing an agent override makes the agent inherit the user address', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await setChatAddress(db, agentOneScope, 'telegram', '6600002');
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '6600002' });

      await setChatAddress(db, agentOneScope, 'telegram', null);
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '5550001' });
      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '5550001' });
    });

    it('does not let one user see another user address', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await expect(repo.getEffectiveChatAddress('agent-3', 'telegram')).resolves.toBeNull();
    });
  });

  describe('revokeChatAddress and suppression', () => {
    it('deletes the active row and writes a suppression row', async () => {
      await setChatAddress(db, userScope, 'telegram', '111');
      await expect(db.transaction((tx) => revokeChatAddress(tx, userScope, 'telegram'))).resolves.toBe('111');
      await expect(addressRows()).resolves.toEqual([]);
      await expect(suppressionRows()).resolves.toEqual([{ provider: 'telegram', address: '111', status: 'revoked' }]);
      await expect(repo.isChatAddressSuppressed('telegram', '111')).resolves.toBe(true);
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
    });

    it('revoke X, then save Y: X stays blocked and Y is not', async () => {
      await setChatAddress(db, userScope, 'telegram', 'X');
      await db.transaction((tx) => revokeChatAddress(tx, userScope, 'telegram'));
      await setChatAddress(db, userScope, 'telegram', 'Y');

      await expect(repo.isChatAddressSuppressed('telegram', 'X')).resolves.toBe(true);
      await expect(repo.isChatAddressSuppressed('telegram', 'Y')).resolves.toBe(false);
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: 'Y' });
      await expect(suppressionRows()).resolves.toEqual([{ provider: 'telegram', address: 'X', status: 'revoked' }]);
    });

    it('saving the revoked address again does not lift its suppression', async () => {
      await setChatAddress(db, userScope, 'telegram', 'X');
      await db.transaction((tx) => revokeChatAddress(tx, userScope, 'telegram'));
      await setChatAddress(db, userScope, 'telegram', 'X');
      await expect(repo.isChatAddressSuppressed('telegram', 'X')).resolves.toBe(true);
      await expect(suppressionRows()).resolves.toHaveLength(1);
    });

    it('revoking twice writes one suppression row', async () => {
      await setChatAddress(db, userScope, 'telegram', 'X');
      await db.transaction((tx) => revokeChatAddress(tx, userScope, 'telegram'));
      await setChatAddress(db, userScope, 'telegram', 'X');
      await db.transaction((tx) => revokeChatAddress(tx, userScope, 'telegram'));
      await expect(suppressionRows()).resolves.toHaveLength(1);
    });

    it('revoking a scope with no active row writes nothing', async () => {
      await expect(revokeChatAddress(db, userScope, 'telegram')).resolves.toBeNull();
      await expect(suppressionRows()).resolves.toEqual([]);
    });

    it('rejects a duplicate suppression row for the same provider and address at the database', async () => {
      await scratch.sql`INSERT INTO chat_suppressions (provider, address, status) VALUES ('telegram', 'X', 'revoked')`;
      await expect(scratch.sql`INSERT INTO chat_suppressions (provider, address, status) VALUES ('telegram', 'X', 'pending_optin')`)
        .rejects.toMatchObject({ code: '23505' });
    });

    it('a suppression outlives the user that held the address', async () => {
      await setChatAddress(db, userScope, 'telegram', 'X');
      await db.transaction((tx) => revokeChatAddress(tx, userScope, 'telegram'));
      await scratch.sql`DELETE FROM agents WHERE user_id = 'user-1'`;
      await scratch.sql`DELETE FROM users WHERE id = 'user-1'`;
      await expect(repo.isChatAddressSuppressed('telegram', 'X')).resolves.toBe(true);
    });
  });

  describe('inbound reply resolution', () => {
    it('resolves the agent that holds the address as an override', async () => {
      await setChatAddress(db, agentOneScope, 'telegram', '6600002');
      await expect(repo.resolveAgentForChatReply('telegram', '6600002')).resolves.toEqual(agentOne);
    });

    it('trims the inbound address before matching', async () => {
      await setChatAddress(db, agentOneScope, 'telegram', '6600002');
      await expect(repo.resolveAgentForChatReply('telegram', '  6600002 ')).resolves.toEqual(agentOne);
    });

    it('does not resolve an agent from a user-level address', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await expect(repo.resolveAgentForChatReply('telegram', '5550001')).resolves.toBeNull();
    });

    it('resolves the agent from the conversation message, per chat', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await addOutbound('out-1', 'agent-1', '4242');
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toEqual(agentOne);
      await expect(repo.resolveAgentForChatReply('telegram', '9999999', '4242')).resolves.toBeNull();
    });

    it('picks the agent of the chat when two chats share a provider message id', async () => {
      await setChatAddress(db, agentOneScope, 'telegram', '5550001');
      await setChatAddress(db, { userId: 'user-2', agentId: 'agent-3' }, 'telegram', '8800004');
      await addOutbound('out-1', 'agent-1', '4242');
      await addOutbound('out-3', 'agent-3', '4242');
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toEqual(agentOne);
      await expect(repo.resolveAgentForChatReply('telegram', '8800004', '4242')).resolves.toEqual(
        { agentId: 'agent-3', agentName: 'Ama', status: 'active', userId: 'user-2' },
      );
    });

    it('a rebind after the message disqualifies it: a chat that merely shares the provider message id does not match', async () => {
      const hourAgo = new Date(Date.now() - 3_600_000);
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await scratch.sql`UPDATE chat_addresses SET updated_at = ${new Date(Date.now() - 7_200_000).toISOString()}::timestamptz WHERE user_id = 'user-1'`;
      await addOutbound('out-old', 'agent-1', '4242', 'telegram', hourAgo);
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toEqual(agentOne);

      await setChatAddress(db, userScope, 'telegram', '7770001');
      await expect(repo.resolveAgentForChatReply('telegram', '7770001', '4242')).resolves.toBeNull();

      await addOutbound('out-new', 'agent-1', '4343', 'telegram', new Date(Date.now() + 60_000));
      await expect(repo.resolveAgentForChatReply('telegram', '7770001', '4343')).resolves.toEqual(agentOne);
    });

    it('still finds the message when more than the candidate cap of other users share the provider message id', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await scratch.sql`UPDATE chat_addresses SET updated_at = now() - interval '1 hour' WHERE user_id = 'user-1'`;
      await addOutbound('out-1', 'agent-1', '4242', 'telegram', new Date(Date.now() - 60_000));
      for (let i = 0; i < 30; i += 1) {
        await scratch.sql`INSERT INTO users (id, username, display_name, email)
          VALUES (${`crowd-user-${i}`}, ${`crowd${i}`}, 'Crowd', ${`crowd${i}@example.test`})`;
        await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status)
          VALUES (${`crowd-agent-${i}`}, ${`crowd-user-${i}`}, 'Crowd', 'p', 'active')`;
        await setChatAddress(db, { userId: `crowd-user-${i}`, agentId: null }, 'telegram', `90000${i}`);
        await addOutbound(`crowd-out-${i}`, `crowd-agent-${i}`, '4242', 'telegram', new Date(Date.now() + 1_000 * (i + 1)));
      }
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toEqual(agentOne);
      await expect(repo.resolveAgentForChatReply('telegram', '900007', '4242')).resolves.toEqual(
        { agentId: 'crowd-agent-7', agentName: 'Crowd', status: 'active', userId: 'crowd-user-7' },
      );
    });

    it('does not match a user-level address that an agent-level override shadows', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await setChatAddress(db, agentOneScope, 'telegram', '6600002');
      await addOutbound('out-1', 'agent-1', '4242', 'telegram', new Date(Date.now() + 60_000));
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toBeNull();
      await expect(repo.resolveAgentForChatReply('telegram', '6600002', '4242')).resolves.toEqual(agentOne);
    });

    it('does not match through a non-active address row', async () => {
      await scratch.sql`INSERT INTO chat_addresses (id, user_id, agent_id, provider, address, status, updated_at)
        VALUES ('pending-1', 'user-1', NULL, 'telegram', '5550001', 'pending_optin', now() - interval '1 hour')`;
      await addOutbound('out-1', 'agent-1', '4242');
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toBeNull();
    });

    it('ignores a message that went out on another channel', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await addOutbound('out-1', 'agent-1', '4242', 'web');
      await expect(repo.resolveAgentForChatReply('telegram', '5550001', '4242')).resolves.toBeNull();
    });

    it('has retired agent_outbound_messages once every migration is applied', async () => {
      const rows = await scratch.sql`SELECT to_regclass('public.agent_outbound_messages') AS name`;
      expect(rows[0]!.name).toBeNull();
    });

    it('uses the provider message index for the lookup', async () => {
      const rows = await scratch.sql`
        SELECT "indexdef" FROM pg_indexes WHERE "indexname" = 'idx_conversation_messages_provider_message'`;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]!.indexdef)).toContain('(channel, provider_message_id)');
      expect(String(rows[0]!.indexdef)).toContain('WHERE (provider_message_id IS NOT NULL)');
    });

    it('a suppressed address resolves to nothing, even with a matching outbound message', async () => {
      await setChatAddress(db, agentOneScope, 'telegram', '6600002');
      await addOutbound('out-1', 'agent-1', '4242');
      await scratch.sql`INSERT INTO chat_suppressions (provider, address, status) VALUES ('telegram', '6600002', 'revoked')`;
      await expect(repo.resolveAgentForChatReply('telegram', '6600002')).resolves.toBeNull();
      await expect(repo.resolveAgentForChatReply('telegram', '6600002', '4242')).resolves.toBeNull();
    });
  });

  describe('listChatAddressesForOutput', () => {
    it('returns user rows and rows for two agents together, excluding another user and unlisted agents', async () => {
      await setChatAddress(db, userScope, 'telegram', '5550001');
      await setChatAddress(db, agentOneScope, 'telegram', '6600002');
      await setChatAddress(db, { userId: 'user-1', agentId: 'agent-2' }, 'telegram', '7700003');
      await setChatAddress(db, { userId: 'user-2', agentId: 'agent-3' }, 'telegram', '8800004');

      const result = await listChatAddressesForOutput(db, 'user-1', ['agent-1', 'agent-2']);
      expect(result.user).toEqual([{ provider: 'telegram', address: '5550001', scope: 'user', status: 'active' }]);
      expect(result.byAgent.get('agent-1')).toEqual([{ provider: 'telegram', address: '6600002', scope: 'agent', status: 'active' }]);
      expect(result.byAgent.get('agent-2')).toEqual([{ provider: 'telegram', address: '7700003', scope: 'agent', status: 'active' }]);
      expect(result.byAgent.has('agent-3')).toBe(false);
    });
  });

  it('rejects a second address for the same user and agent scope at the database', async () => {
    await setChatAddress(db, userScope, 'telegram', '111');
    await expect(scratch.sql`
      INSERT INTO "chat_addresses" ("id", "user_id", "agent_id", "provider", "address", "status")
      VALUES ('dup-user-level', 'user-1', NULL, 'telegram', '222', 'active')`)
      .rejects.toMatchObject({ code: '23505' });
  });
});

describe.skipIf(!BASE_URL)('0083 cutover migration (integration)', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, '0082_wakeful_mantis.sql');
    const sql = scratch.sql;
    await sql`INSERT INTO users (id, username, display_name, email) VALUES ('user-1', 'owner', 'Owner', 'owner@example.test')`;
    await sql`INSERT INTO agents (id, user_id, name, prompt) VALUES
      ('agent-1', 'user-1', 'A', 'p'), ('agent-2', 'user-1', 'B', 'p'), ('agent-3', 'user-1', 'C', 'p')`;
    await sql`INSERT INTO chat_addresses (id, user_id, agent_id, provider, address, status) VALUES
      ('a-user', 'user-1', NULL, 'telegram', '5550001', 'active'),
      ('a-blank', 'user-1', 'agent-1', 'telegram', '', 'active'),
      ('a-revoked', 'user-1', 'agent-2', 'telegram', ' 6600002 ', 'revoked'),
      ('a-pending', 'user-1', 'agent-3', 'whatsapp', '+15555550100', 'pending_optin')`;
    await sql.unsafe(readMigration('0083_lying_zaran.sql')).simple();
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps active rows, deletes blank and non-active rows', async () => {
    await expect(scratch.sql`SELECT "id" FROM "chat_addresses" ORDER BY "id"`).resolves.toEqual([{ id: 'a-user' }]);
  });

  it('moves non-active rows into chat_suppressions with trimmed addresses', async () => {
    await expect(scratch.sql`SELECT "provider", "address", "status" FROM "chat_suppressions" ORDER BY "provider"`).resolves.toEqual([
      { provider: 'telegram', address: '6600002', status: 'revoked' },
      { provider: 'whatsapp', address: '+15555550100', status: 'pending_optin' },
    ]);
  });

  it('drops the four legacy columns', async () => {
    const rows = await scratch.sql`
      SELECT "table_name", "column_name" FROM information_schema.columns
      WHERE "table_schema" = 'public'
        AND "table_name" IN ('users', 'agents', 'agent_outbound_messages') AND "column_name" LIKE 'telegram%'`;
    expect(rows).toEqual([]);
  });
});
