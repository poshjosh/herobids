import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { AgentRepository, setTelegramChatAddress, type TelegramChatAddressScope } from './agent-repository.js';
import * as schema from './schema/index.js';
import {
  createScratchDatabase,
  localDatabaseUrl,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';
import { truncate } from './test-helpers/integration-db.js';

// Runs only against a local Postgres (DATABASE_URL on localhost), in a database it creates and drops.
// Skipped otherwise. Each test seeds one data state: legacy Telegram columns, neutral chat_addresses
// and outbound delivery columns, or both.
const BASE_URL = localDatabaseUrl();
const EXPAND_LAST = '0076_absent_starhawk.sql';

describe.skipIf(!BASE_URL)('chat address resolution by data state (integration)', () => {
  let scratch: ScratchDatabase;
  let repo: AgentRepository;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, EXPAND_LAST);
    repo = new AgentRepository(drizzle(scratch.sql, { schema }));
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await truncate(scratch.sql, 'agent_outbound_messages', 'chat_addresses', 'agents', 'users');
  });

  /** One user with two agents. legacy.* sets the Telegram columns; agent-2 never has an agent-level value. */
  async function seedUser(legacy: { userChatId: string | null; agentChatId: string | null }) {
    const sql = scratch.sql;
    await sql`INSERT INTO users (id, username, display_name, email, telegram_chat_id)
      VALUES ('user-1', 'owner', 'Owner', 'owner@example.test', ${legacy.userChatId})`;
    await sql`INSERT INTO agents (id, user_id, name, prompt, status, telegram_chat_id) VALUES
      ('agent-1', 'user-1', 'Momo', 'p', 'active', ${legacy.agentChatId}),
      ('agent-2', 'user-1', 'Kofi', 'p', 'active', NULL)`;
  }

  async function addChatAddress(agentId: string | null, address: string, status = 'active') {
    await scratch.sql`INSERT INTO chat_addresses (id, user_id, agent_id, provider, address, status)
      VALUES (${`addr-${agentId ?? 'user'}-${address}`}, 'user-1', ${agentId}, 'telegram', ${address}, ${status})`;
  }

  /** An outbound message from agent-1 with legacy Telegram columns, neutral delivery columns, or both. */
  async function addOutbound(row: {
    id: string;
    legacy?: { messageId: string; chatId: string };
    neutral?: { messageId: string; address: string };
  }) {
    await scratch.sql`INSERT INTO agent_outbound_messages
        (id, agent_id, authored_by, body, telegram_message_id, telegram_chat_id, delivery_provider, delivery_address, provider_message_id)
      VALUES (${row.id}, 'agent-1', 'agent', 'hi',
        ${row.legacy?.messageId ?? null}, ${row.legacy?.chatId ?? null},
        ${row.neutral ? 'telegram' : null}, ${row.neutral?.address ?? null}, ${row.neutral?.messageId ?? null})`;
  }

  const agentOne = { agentId: 'agent-1', agentName: 'Momo', status: 'active', userId: 'user-1' };

  describe('when only the legacy Telegram columns hold the chat', () => {
    beforeEach(async () => {
      await seedUser({ userChatId: '555001', agentChatId: '777001' });
      await addOutbound({ id: 'out-1', legacy: { messageId: '42', chatId: '777001' } });
    });

    it('returns the agent-level legacy chat ID as the effective address', async () => {
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '777001' });
    });

    it('falls back to the user-level legacy chat ID when the agent has none', async () => {
      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '555001' });
    });

    it('resolves the agent from its legacy outbound message when the message ID matches', async () => {
      await expect(repo.resolveAgentForChatReply('telegram', '777001', '42')).resolves.toEqual(agentOne);
    });

    it('resolves no agent from the legacy chat ID without a message ID', async () => {
      await expect(repo.resolveAgentForChatReply('telegram', '777001')).resolves.toBeNull();
    });

    it('returns no address or agent for a non-telegram provider', async () => {
      await expect(repo.getEffectiveChatAddress('agent-1', 'sms')).resolves.toBeNull();
      await expect(repo.resolveAgentForChatReply('sms', '777001', '42')).resolves.toBeNull();
    });
  });

  describe('when only neutral chat_addresses and delivery columns hold the chat', () => {
    beforeEach(async () => {
      await seedUser({ userChatId: null, agentChatId: null });
      await addChatAddress('agent-1', '777001');
      await addChatAddress(null, '555001');
      await addOutbound({ id: 'out-1', neutral: { messageId: '42', address: '777001' } });
    });

    it('returns the agent-level neutral address as the effective address', async () => {
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '777001' });
    });

    it('falls back to the user-level neutral address when the agent has no override', async () => {
      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '555001' });
    });

    it('resolves the agent from its neutral outbound delivery when the message ID matches', async () => {
      await expect(repo.resolveAgentForChatReply('telegram', '777001', '42')).resolves.toEqual(agentOne);
    });

    it('resolves the agent from the neutral agent-level address without a message ID', async () => {
      await expect(repo.resolveAgentForChatReply('telegram', '777001')).resolves.toEqual(agentOne);
    });

    it('resolves no agent from a user-level neutral address', async () => {
      await expect(repo.resolveAgentForChatReply('telegram', '555001')).resolves.toBeNull();
    });
  });

  describe('when both legacy columns and neutral data hold the chat', () => {
    it('returns the same address when the neutral row and the legacy column agree', async () => {
      await seedUser({ userChatId: '555001', agentChatId: '777001' });
      await addChatAddress('agent-1', '777001');
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '777001' });
    });

    it('returns the neutral address over a different legacy chat ID', async () => {
      await seedUser({ userChatId: '555001', agentChatId: '777001' });
      await addChatAddress('agent-1', '888001');
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '888001' });
    });

    it('resolves the agent from the neutral address when the legacy chat ID differs', async () => {
      await seedUser({ userChatId: null, agentChatId: '777001' });
      await addChatAddress('agent-1', '888001');
      await expect(repo.resolveAgentForChatReply('telegram', '888001')).resolves.toEqual(agentOne);
    });

    it('a revoked neutral address blocks the legacy chat ID instead of falling back to it', async () => {
      await seedUser({ userChatId: null, agentChatId: '777001' });
      await addChatAddress('agent-1', '777001', 'revoked');
      await addOutbound({ id: 'out-1', legacy: { messageId: '42', chatId: '777001' } });
      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toBeNull();
      await expect(repo.resolveAgentForChatReply('telegram', '777001', '42')).resolves.toBeNull();
    });
  });

  describe('when the user changes the Telegram chat ID in Settings', () => {
    // Mirrors PATCH /auth/me (apps/api/src/routes/auth.ts): the legacy users.telegram_chat_id column is
    // written, then the user-level neutral address is written with agentId null.
    it('resolves the new Telegram chat ID after the user changes it', async () => {
      await seedUser({ userChatId: '555001', agentChatId: null });
      await addChatAddress(null, '555001');
      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '555001' });

      const db = drizzle(scratch.sql, { schema });
      await db.update(schema.users).set({ telegramChatId: '555002' }).where(eq(schema.users.id, 'user-1'));
      await setTelegramChatAddress(db, { userId: 'user-1', agentId: null }, '555002');

      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '555002' });
    });

    it('saving the same Telegram chat ID again keeps the existing address active', async () => {
      await seedUser({ userChatId: '555001', agentChatId: null });
      await addChatAddress(null, '555001');

      await setTelegramChatAddress(drizzle(scratch.sql, { schema }), { userId: 'user-1', agentId: null }, '555001');

      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '555001' });
      const [row] = await scratch.sql<{ status: string }[]>`SELECT status FROM chat_addresses WHERE id = 'addr-user-555001'`;
      expect(row?.status).toBe('active');
    });
  });

  describe('when a Telegram chat ID is saved through the shared chat address write', () => {
    function writeTelegramChatAddress(scope: TelegramChatAddressScope, chatId: string | null) {
      return setTelegramChatAddress(drizzle(scratch.sql, { schema }), scope, chatId);
    }

    async function chatAddressStatus(agentId: string | null): Promise<{ address: string; status: string } | undefined> {
      const rows = await scratch.sql<{ address: string; status: string }[]>`SELECT address, status FROM chat_addresses
        WHERE user_id = 'user-1' AND provider = 'telegram'
          AND agent_id IS NOT DISTINCT FROM ${agentId}`;
      return rows[0];
    }

    it('agent chat ID change propagates to the agent scope and its replies', async () => {
      await seedUser({ userChatId: null, agentChatId: null });
      await writeTelegramChatAddress({ userId: 'user-1', agentId: 'agent-1' }, '777001');
      await writeTelegramChatAddress({ userId: 'user-1', agentId: 'agent-1' }, ' 777002 ');

      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '777002' });
      await expect(repo.resolveAgentForChatReply('telegram', '777002')).resolves.toEqual(agentOne);
      await expect(repo.resolveAgentForChatReply('telegram', '777001')).resolves.toBeNull();
    });

    it('clearing an active chat ID falls through to the other scopes', async () => {
      await seedUser({ userChatId: null, agentChatId: null });
      await addChatAddress(null, '555001');
      await writeTelegramChatAddress({ userId: 'user-1', agentId: 'agent-1' }, '777001');
      await writeTelegramChatAddress({ userId: 'user-1', agentId: 'agent-1' }, '  ');

      await expect(repo.getEffectiveChatAddress('agent-1', 'telegram')).resolves.toEqual({ provider: 'telegram', address: '555001' });
      await expect(chatAddressStatus('agent-1')).resolves.toEqual({ address: '', status: 'active' });
    });

    it('clearing the user chat ID does not reactivate a revoked row', async () => {
      await seedUser({ userChatId: null, agentChatId: null });
      await addChatAddress(null, '555001', 'revoked');
      await writeTelegramChatAddress({ userId: 'user-1', agentId: null }, null);

      await expect(chatAddressStatus(null)).resolves.toEqual({ address: '555001', status: 'revoked' });
      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toBeNull();
    });

    it('a revoked row for the same address stays blocked after the user saves it again', async () => {
      await seedUser({ userChatId: null, agentChatId: null });
      await addChatAddress(null, '555001', 'revoked');
      await writeTelegramChatAddress({ userId: 'user-1', agentId: null }, '555001');

      await expect(chatAddressStatus(null)).resolves.toEqual({ address: '555001', status: 'revoked' });
      await expect(repo.getEffectiveChatAddress('agent-2', 'telegram')).resolves.toBeNull();
    });
  });
});
