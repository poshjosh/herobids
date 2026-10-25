import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { CONVERSATION_ERROR_CODES, ConversationService, peerConversationId, userAgentConversationId } from '@herobids/domain';
import { AgentRepository } from './agent-repository.js';
import { ConversationRepository, deleteUserAgentConversations } from './conversation-repository.js';
import * as schema from './schema/index.js';
import {
  createScratchDatabase,
  localDatabaseUrl,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';
import { truncate } from './test-helpers/integration-db.js';

// Runs only against a local Postgres (DATABASE_URL on localhost), in a database it creates and drops.
const BASE_URL = localDatabaseUrl();
const ALL_MIGRATIONS = '9999_all.sql';
const LIMITS = { userMessageMaxChars: 4000, threadDefaultPageSize: 50, threadMaxPageSize: 200, staleQueuedAfterSeconds: 60 };

describe.skipIf(!BASE_URL)('ConversationRepository (integration)', () => {
  let scratch: ScratchDatabase;
  let pool: postgres.Sql;
  let connect: () => postgres.Sql;
  let repo: ConversationRepository;
  let clock: number;
  let nextId: number;

  // Same database, several connections, so concurrent writes really overlap.
  const service = () => new ConversationService({
    store: repo,
    limits: LIMITS,
    newId: () => `generated-${++nextId}`,
    now: () => new Date(++clock),
  });

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, ALL_MIGRATIONS);
    const { host, port, user, pass, database } = scratch.sql.options;
    connect = () => postgres({ host: host[0], port: port[0], user, pass: pass ?? undefined, database }, { max: 1 });
    pool = postgres({ host: host[0], port: port[0], user, pass: pass ?? undefined, database }, { max: 8 });
    repo = new ConversationRepository(drizzle(pool, { schema }));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    clock = Date.parse('2026-10-25T10:00:00.000Z');
    nextId = 0;
    await truncate(scratch.sql, 'conversations', 'agents', 'users');
    await scratch.sql`INSERT INTO users (id, username, display_name, email) VALUES
      ('user-1', 'owner', 'Owner', 'owner@example.test'),
      ('user-2', 'other', 'Other', 'other@example.test')`;
    await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES
      ('agent-1', 'user-1', 'Momo', 'p', 'active'),
      ('agent-2', 'user-1', 'Kofi', 'p', 'active'),
      ('agent-3', 'user-2', 'Ama', 'p', 'active')`;
  });

  const user = (agentId = 'agent-1', body = 'hello', id?: string) =>
    service().recordUserMessage({ ownerUserId: 'user-1', agentId, channel: 'web', body, ...(id ? { id } : {}) });

  describe('migrations 0084 and 0085', () => {
    it('creates the three tables with the columns of the schema note', async () => {
      const columns = await scratch.sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
        SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_name IN ('conversations', 'conversation_participants', 'conversation_messages')
        ORDER BY table_name, ordinal_position`;
      const byTable = (table: string) => columns.filter((c) => c.table_name === table).map((c) => `${c.column_name}${c.is_nullable === 'YES' ? '?' : ''}`);

      expect(byTable('conversations')).toEqual(['id', 'kind', 'owner_user_id', 'peer_key?', 'last_message_at?', 'created_at']);
      expect(byTable('conversation_participants')).toEqual(['conversation_id', 'participant_type', 'participant_id']);
      expect(byTable('conversation_messages')).toEqual([
        'id', 'conversation_id', 'sender_type', 'sender_id?', 'channel', 'subject?', 'body', 'message_class?',
        'delivery_status', 'delivery_detail?', 'provider_message_id?', 'created_at', 'queued_at',
      ]);
    });

    it('adds users.peer_messaging_paused as a non-null boolean defaulting to false', async () => {
      const [column] = await scratch.sql<{ data_type: string; is_nullable: string; column_default: string }[]>`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'peer_messaging_paused'`;
      const [row] = await scratch.sql<{ peer_messaging_paused: boolean }[]>`
        SELECT peer_messaging_paused FROM users WHERE id = 'user-1'`;

      expect(column).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
      expect(row?.peer_messaging_paused).toBe(false);
    });

    it('creates the indexes of the schema note', async () => {
      const indexes = await scratch.sql<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('conversations', 'conversation_participants', 'conversation_messages')`;
      const defs = new Map(indexes.map((i) => [i.indexname, i.indexdef]));

      expect(defs.get('idx_conversation_messages_conversation_created')).toContain('(conversation_id, created_at)');
      expect(defs.get('idx_conversation_participants_participant')).toContain('(participant_type, participant_id)');
      expect(defs.get('idx_conversations_owner_last_message')).toContain('(owner_user_id, last_message_at DESC');
      expect(defs.get('uq_conversations_peer_key')).toMatch(/UNIQUE INDEX .*\(peer_key\) WHERE .*kind.*agent_agent/);
    });

    it('allows one agent_agent thread per peer key and any number of user_agent threads', async () => {
      const insert = (id: string, kind: string, peerKey: string | null) => scratch.sql`
        INSERT INTO conversations (id, kind, owner_user_id, peer_key) VALUES (${id}, ${kind}, 'user-1', ${peerKey})`;

      await insert('p1', 'agent_agent', 'agent-1:agent-2');
      await expect(insert('p2', 'agent_agent', 'agent-1:agent-2')).rejects.toThrow(/uq_conversations_peer_key/);
      await insert('p3', 'agent_agent', 'agent-1:agent-3');
      await insert('u1', 'user_agent', null);
      await insert('u2', 'user_agent', null);
    });

    it('cascades from the conversation to its participants and messages, and from the owner to the conversation', async () => {
      await user('agent-1', 'one');
      await user('agent-2', 'two');

      await scratch.sql`DELETE FROM conversations WHERE id = ${userAgentConversationId('agent-1')}`;
      const afterConversation = await scratch.sql`SELECT
        (SELECT count(*)::int FROM conversation_messages) AS messages,
        (SELECT count(*)::int FROM conversation_participants) AS participants`;
      // agents do not cascade from users, so clear them first
      await truncate(scratch.sql, 'agents');
      await scratch.sql`DELETE FROM users WHERE id = 'user-1'`;
      const afterOwner = await scratch.sql`SELECT (SELECT count(*)::int FROM conversations) AS conversations,
        (SELECT count(*)::int FROM conversation_messages) AS messages`;

      expect(afterConversation[0]).toEqual({ messages: 1, participants: 2 });
      expect(afterOwner[0]).toEqual({ conversations: 0, messages: 0 });
    });
  });

  describe('recordUserAgentMessage', () => {
    it('creates the conversation with the owner and the agent as participants on the first message', async () => {
      const result = await user('agent-1', 'hello');

      expect(result).toMatchObject({ ok: true, data: { created: true, message: { body: 'hello', senderType: 'user', senderId: 'user-1', deliveryStatus: 'queued', channel: 'web' } } });
      const conversations = await scratch.sql`SELECT id, kind, owner_user_id, peer_key, last_message_at FROM conversations`;
      const participants = await scratch.sql`SELECT participant_type, participant_id FROM conversation_participants ORDER BY participant_type`;
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({ id: 'user_agent:agent-1', kind: 'user_agent', owner_user_id: 'user-1', peer_key: null });
      expect(participants.map((p) => `${p.participant_type}:${p.participant_id}`)).toEqual(['agent:agent-1', 'user:user-1']);
    });

    it('reuses the conversation for later messages and moves last_message_at to the newest message', async () => {
      const first = await user('agent-1', 'one');
      const second = await service().recordAgentMessage({ ownerUserId: 'user-1', agentId: 'agent-1', channel: 'web', body: 'two' });

      expect(first.ok && second.ok).toBe(true);
      const [conversationCount] = await scratch.sql`SELECT count(*)::int AS n FROM conversations`;
      const [participantCount] = await scratch.sql`SELECT count(*)::int AS n FROM conversation_participants`;
      const [conversation] = await scratch.sql<{ last_message_at: Date }[]>`SELECT last_message_at FROM conversations`;
      expect(conversationCount?.n).toBe(1);
      expect(participantCount?.n).toBe(2);
      expect(conversation?.last_message_at.getTime()).toBe(second.ok ? second.data.message.createdAt.getTime() : 0);
    });

    it('never moves last_message_at backwards when an older message arrives late', async () => {
      await user('agent-1', 'newer');
      const [before] = await scratch.sql<{ last_message_at: Date }[]>`SELECT last_message_at FROM conversations`;

      const late = await repo.recordUserAgentMessage({
        conversationId: userAgentConversationId('agent-1'),
        ownerUserId: 'user-1',
        agentId: 'agent-1',
        message: {
          id: 'late', senderType: 'platform', senderId: null, channel: 'web', subject: null, body: 'late',
          messageClass: null, deliveryStatus: 'queued', createdAt: new Date(clock - 60_000),
        },
      });

      const [after] = await scratch.sql<{ last_message_at: Date }[]>`SELECT last_message_at FROM conversations`;
      expect(late.ok).toBe(true);
      expect(after?.last_message_at.getTime()).toBe(before?.last_message_at.getTime());
    });

    it('returns the stored row for a repeated id and does not insert or move last_message_at', async () => {
      const first = await user('agent-1', 'hello', 'client-1');
      const [afterFirst] = await scratch.sql<{ last_message_at: Date }[]>`SELECT last_message_at FROM conversations`;
      const retry = await user('agent-1', 'hello', 'client-1');

      expect(first).toMatchObject({ ok: true, data: { created: true } });
      expect(retry).toMatchObject({ ok: true, data: { created: false, message: { id: 'client-1', body: 'hello' } } });
      const [count] = await scratch.sql`SELECT count(*)::int AS n FROM conversation_messages`;
      const [afterRetry] = await scratch.sql<{ last_message_at: Date }[]>`SELECT last_message_at FROM conversations`;
      expect(count?.n).toBe(1);
      expect(afterRetry?.last_message_at.getTime()).toBe(afterFirst?.last_message_at.getTime());
    });

    it('refuses an id that already belongs to another conversation, without returning that row', async () => {
      await user('agent-1', 'secret', 'shared-id');

      const clash = await user('agent-2', 'other text', 'shared-id');

      expect(clash).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.messageIdConflict } });
      expect(JSON.stringify(clash)).not.toContain('secret');
    });

    it('rolls back a first write refused for its message id, leaving no empty conversation or participants', async () => {
      await user('agent-1', 'secret', 'shared-id');

      const clash = await user('agent-2', 'other text', 'shared-id');

      expect(clash).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.messageIdConflict } });
      const [rows] = await scratch.sql<{ conversations: number; participants: number; messages: number }[]>`
        SELECT
          (SELECT count(*)::int FROM conversations WHERE id = ${userAgentConversationId('agent-2')}) AS conversations,
          (SELECT count(*)::int FROM conversation_participants WHERE conversation_id = ${userAgentConversationId('agent-2')}) AS participants,
          (SELECT count(*)::int FROM conversation_messages) AS messages`;
      expect(rows).toEqual({ conversations: 0, participants: 0, messages: 1 });
    });

    it('refuses an id reused by a different sender in the same conversation', async () => {
      await user('agent-1', 'hello', 'same-id');

      const clash = await service().recordAgentMessage({ id: 'same-id', ownerUserId: 'user-1', agentId: 'agent-1', channel: 'web', body: 'forged' });

      expect(clash).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.messageIdConflict } });
    });

    it('refuses a write by a user who does not own the conversation, and writes nothing', async () => {
      await user('agent-1', 'hello');

      const intruder = await service().recordUserMessage({ ownerUserId: 'user-2', agentId: 'agent-1', channel: 'web', body: 'let me in' });

      expect(intruder).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.ownerMismatch } });
      const [count] = await scratch.sql`SELECT count(*)::int AS n FROM conversation_messages`;
      expect(count?.n).toBe(1);
    });

    it('stores agent, creator-agent and platform messages with their sender, subject and class', async () => {
      const svc = service();
      await svc.recordAgentMessage({ ownerUserId: 'user-1', agentId: 'agent-1', channel: 'telegram', subject: 'Update', body: 'a', messageClass: 'alert' });
      await svc.recordAgentMessage({ ownerUserId: 'user-1', agentId: 'agent-1', senderAgentId: 'agent-2', channel: 'web', body: 'b' });
      await svc.recordPlatformMessage({ ownerUserId: 'user-1', agentId: 'agent-1', channel: 'web', subject: 'Safety', body: 'c', messageClass: 'alert', deliveryStatus: 'not_applicable' });

      const rows = await scratch.sql`SELECT sender_type, sender_id, channel, subject, message_class, delivery_status FROM conversation_messages ORDER BY created_at`;
      expect(rows).toEqual([
        { sender_type: 'agent', sender_id: 'agent-1', channel: 'telegram', subject: 'Update', message_class: 'alert', delivery_status: 'queued' },
        { sender_type: 'agent', sender_id: 'agent-2', channel: 'web', subject: null, message_class: null, delivery_status: 'queued' },
        { sender_type: 'platform', sender_id: null, channel: 'web', subject: 'Safety', message_class: 'alert', delivery_status: 'not_applicable' },
      ]);
    });

    it('creates one conversation and two participants when first messages race on separate connections', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => user('agent-1', `message ${i}`)));

      expect(results.every((r) => r.ok)).toBe(true);
      const [counts] = await scratch.sql`SELECT
        (SELECT count(*)::int FROM conversations) AS conversations,
        (SELECT count(*)::int FROM conversation_participants) AS participants,
        (SELECT count(*)::int FROM conversation_messages) AS messages`;
      expect(counts).toEqual({ conversations: 1, participants: 2, messages: 8 });
    });

    it('persists nothing for a foreign owner who loses the first-write race, and keeps the winner intact', async () => {
      // The winner has inserted the conversation but not committed. The intruder's insert blocks on the
      // unique key, then sees DO NOTHING once the winner commits: the interleaving that used to leave the
      // intruder's participant rows behind.
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const winnerHoldsRow = new Promise<void>((resolve) => { held = resolve; });
      // scratch.sql has one connection, so the winner gets its own; the poll below uses scratch.sql.
      const winnerSql = connect();
      const winner = winnerSql.begin(async (tx) => {
        await tx`INSERT INTO conversations (id, kind, owner_user_id, created_at) VALUES (${userAgentConversationId('agent-1')}, 'user_agent', 'user-1', now())`;
        await tx`INSERT INTO conversation_participants (conversation_id, participant_type, participant_id) VALUES
          (${userAgentConversationId('agent-1')}, 'user', 'user-1'), (${userAgentConversationId('agent-1')}, 'agent', 'agent-1')`;
        held();
        await released;
      });
      await winnerHoldsRow;

      const intruder = service().recordUserMessage({ ownerUserId: 'user-2', agentId: 'agent-1', channel: 'web', body: 'let me in' });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [waiting] = await scratch.sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'insert into "conversations"%'`;
        if (waiting && waiting.n > 0) break;
        if (Date.now() > deadline) throw new Error('intruder never blocked on the conversation insert');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await winner;
      await winnerSql.end();
      const result = await intruder;

      expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.ownerMismatch } });
      const participants = await scratch.sql`SELECT participant_type, participant_id FROM conversation_participants ORDER BY participant_type`;
      const [conversation] = await scratch.sql`SELECT owner_user_id FROM conversations`;
      const [messages] = await scratch.sql`SELECT count(*)::int AS n FROM conversation_messages`;
      expect(participants.map((p) => `${p.participant_type}:${p.participant_id}`)).toEqual(['agent:agent-1', 'user:user-1']);
      expect(conversation?.owner_user_id).toBe('user-1');
      expect(messages?.n).toBe(0);
    });

    it('persists nothing when a foreign owner writes to an existing conversation', async () => {
      await user('agent-1', 'hello');

      const intruder = await service().recordUserMessage({ ownerUserId: 'user-2', agentId: 'agent-1', channel: 'web', body: 'x' });

      expect(intruder).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.ownerMismatch } });
      const [participants] = await scratch.sql`SELECT count(*)::int AS n FROM conversation_participants`;
      expect(participants?.n).toBe(2);
    });

    it('inserts a retried id once when the same message is posted concurrently', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => user('agent-1', 'hello', 'client-race')));

      expect(results.every((r) => r.ok)).toBe(true);
      const created = results.filter((r) => r.ok && r.data.created);
      expect(created).toHaveLength(1);
      const [count] = await scratch.sql`SELECT count(*)::int AS n FROM conversation_messages`;
      expect(count?.n).toBe(1);
    });
  });

  describe('markDelivery', () => {
    const row = async (id: string) => {
      const [r] = await scratch.sql<{ delivery_status: string; delivery_detail: string | null; provider_message_id: string | null }[]>`
        SELECT delivery_status, delivery_detail, provider_message_id FROM conversation_messages WHERE id = ${id}`;
      return r;
    };

    it('moves a queued row to sent and records the provider message id', async () => {
      await user('agent-1', 'hello', 'm1');

      const sent = await service().markDelivery({ messageId: 'm1', status: 'sent', providerMessageId: 'tg-42' });

      expect(sent).toMatchObject({ ok: true, data: { deliveryStatus: 'sent', providerMessageId: 'tg-42', deliveryDetail: null } });
    });

    it('moves a queued row to failed and records the detail', async () => {
      await user('agent-1', 'hello', 'm1');

      const failed = await service().markDelivery({ messageId: 'm1', status: 'failed', detail: 'timeout' });

      expect(failed).toMatchObject({ ok: true, data: { deliveryStatus: 'failed', deliveryDetail: 'timeout', providerMessageId: null } });
    });

    it('stores a refused status with a reason code', async () => {
      await user('agent-1', 'hello', 'm1');

      const refused = await service().markDelivery({ messageId: 'm1', status: 'refused', detail: 'peer.rate_limited' });

      expect(refused).toMatchObject({ ok: true, data: { deliveryStatus: 'refused', deliveryDetail: 'peer.rate_limited' } });
    });

    it('moves a queued row to not_applicable: it had nowhere to go', async () => {
      await user('agent-1', 'hello', 'm1');

      const marked = await service().markDelivery({ messageId: 'm1', status: 'not_applicable', detail: 'chat.no_address' });

      expect(marked).toMatchObject({ ok: true, data: { deliveryStatus: 'not_applicable', deliveryDetail: 'chat.no_address' } });
    });

    it('moves the channel with a sent mark and leaves it alone otherwise', async () => {
      await user('agent-1', 'hello', 'm1');
      await user('agent-1', 'again', 'm2');

      const sent = await service().markDelivery({ messageId: 'm1', status: 'sent', providerMessageId: 'tg-1', channel: 'telegram' });
      const failed = await service().markDelivery({ messageId: 'm2', status: 'failed', detail: 'boom' });

      expect(sent).toMatchObject({ ok: true, data: { channel: 'telegram', providerMessageId: 'tg-1' } });
      expect(failed).toMatchObject({ ok: true, data: { channel: 'web' } });
    });

    it.each(['sent', 'failed', 'refused', 'not_applicable'] as const)('treats %s as final: no later mark changes the row', async (final) => {
      await user('agent-1', 'hello', 'm1');
      await service().markDelivery({ messageId: 'm1', status: final, detail: 'first', providerMessageId: 'p1' });

      for (const next of ['sent', 'failed', 'refused', 'not_applicable'] as const) {
        const again = await service().markDelivery({ messageId: 'm1', status: next, detail: 'second', providerMessageId: 'p2' });
        expect(again).toMatchObject({
          ok: false,
          error: { code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition, context: { from: final, to: next } },
        });
      }
      expect(await row('m1')).toEqual({ delivery_status: final, delivery_detail: 'first', provider_message_id: 'p1' });
    });

    it('refuses to move a row back to queued', async () => {
      await user('agent-1', 'hello', 'm1');

      for (const status of ['queued'] as const) {
        const result = await service().markDelivery({ messageId: 'm1', status });
        expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition } });
      }
      expect(await row('m1')).toEqual({ delivery_status: 'queued', delivery_detail: null, provider_message_id: null });
    });

    it('does not mark a row that never was queued (a platform not_applicable row)', async () => {
      await service().recordPlatformMessage({ id: 'p1', ownerUserId: 'user-1', agentId: 'agent-1', channel: 'web', body: 'notice', deliveryStatus: 'not_applicable' });

      const result = await service().markDelivery({ messageId: 'p1', status: 'sent' });

      expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition, context: { from: 'not_applicable', to: 'sent' } } });
    });

    it('applies exactly one of several concurrent marks and keeps that mark\'s fields', async () => {
      await user('agent-1', 'hello', 'm1');

      const results = await Promise.all([
        service().markDelivery({ messageId: 'm1', status: 'sent', providerMessageId: 'tg-1' }),
        service().markDelivery({ messageId: 'm1', status: 'failed', detail: 'boom' }),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const final = await row('m1');
      expect(final).toEqual(final?.delivery_status === 'sent'
        ? { delivery_status: 'sent', delivery_detail: null, provider_message_id: 'tg-1' }
        : { delivery_status: 'failed', delivery_detail: 'boom', provider_message_id: null });
    });

    it('keeps stored detail and provider id when a mark omits them', async () => {
      await user('agent-1', 'hello', 'm1');
      // Stored by an earlier writer; the guard allows the omitting mark to proceed from queued.
      await scratch.sql`UPDATE conversation_messages SET delivery_detail = 'retrying', provider_message_id = 'tg-7' WHERE id = 'm1'`;

      const sent = await service().markDelivery({ messageId: 'm1', status: 'sent' });

      expect(sent).toMatchObject({ ok: true, data: { deliveryStatus: 'sent', deliveryDetail: 'retrying', providerMessageId: 'tg-7' } });
    });

    it('reports an unknown message id', async () => {
      const result = await service().markDelivery({ messageId: 'missing', status: 'sent' });

      expect(result).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.messageNotFound } });
    });
  });

  describe('retryUndeliveredMessage', () => {
    const USER = { type: 'user' } as const;
    const failed = async (id = 'client-1') => {
      await user('agent-1', 'hello', id);
      await service().markDelivery({ messageId: id, status: 'failed', detail: 'publish_failed' });
    };
    const retry = (id = 'client-1', ownerUserId = 'user-1', agentId = 'agent-1', sender: Parameters<ConversationService['retryUndeliveredMessage']>[0]['sender'] = USER) =>
      service().retryUndeliveredMessage({ ownerUserId, agentId, messageId: id, sender });
    // Moves the clock past the stale age so a queued row counts as stuck.
    const ageQueuedRows = () => { clock += (LIMITS.staleQueuedAfterSeconds + 1) * 1000; };

    it('moves a failed message back to queued, clears the failure text and restamps queued_at', async () => {
      await failed();
      const createdAt = Date.parse('2026-10-25T10:00:00.001Z');

      const result = await retry();

      expect(result).toMatchObject({ ok: true, data: { id: 'client-1', deliveryStatus: 'queued', deliveryDetail: null } });
      expect(result.ok && result.data && result.data.queuedAt.getTime()).toBeGreaterThan(createdAt);
      expect(result.ok && result.data && result.data.createdAt.getTime()).toBe(createdAt);
    });

    it('lets exactly one of several concurrent retries claim the message', async () => {
      await failed();

      const results = await Promise.all(Array.from({ length: 6 }, () => retry()));

      const claimed = results.filter((result) => result.ok && result.data !== null);
      expect(claimed).toHaveLength(1);
      expect(results.every((result) => result.ok)).toBe(true);
    });

    it('returns null for a message that is not failed', async () => {
      await user('agent-1', 'hello', 'client-1');
      await service().markDelivery({ messageId: 'client-1', status: 'sent' });
      ageQueuedRows();

      expect(await retry()).toEqual({ ok: true, data: null });
      const [row] = await scratch.sql`SELECT delivery_status FROM conversation_messages WHERE id = 'client-1'`;
      expect(row?.delivery_status).toBe('sent');
    });

    it('does not requeue another user\'s message, another conversation\'s message, or an agent message as the user', async () => {
      await failed();
      await service().recordAgentMessage({ id: 'agent-msg', ownerUserId: 'user-1', agentId: 'agent-1', channel: 'web', body: 'reply', deliveryStatus: 'queued' });
      await service().markDelivery({ messageId: 'agent-msg', status: 'failed', detail: 'x' });

      expect(await retry('client-1', 'user-2', 'agent-3')).toEqual({ ok: true, data: null });
      expect(await retry('client-1', 'user-1', 'agent-2')).toEqual({ ok: true, data: null });
      expect(await retry('agent-msg')).toEqual({ ok: true, data: null });
      const rows = await scratch.sql`SELECT id, delivery_status FROM conversation_messages ORDER BY id`;
      expect(rows.map((row) => [row.id, row.delivery_status])).toEqual([['agent-msg', 'failed'], ['client-1', 'failed']]);
    });

    describe('a creator agent\'s message', () => {
      const CREATOR = { type: 'agent', agentId: 'agent-2' } as const;
      const creatorFailed = async () => {
        await service().recordAgentMessage({ id: 'creator-msg', ownerUserId: 'user-1', agentId: 'agent-1', senderAgentId: 'agent-2', channel: 'web', body: 'do it' });
        await service().markDelivery({ messageId: 'creator-msg', status: 'failed', detail: 'publish_failed' });
      };

      it('is requeued for its own author', async () => {
        await creatorFailed();

        const result = await retry('creator-msg', 'user-1', 'agent-1', CREATOR);

        expect(result).toMatchObject({ ok: true, data: { id: 'creator-msg', senderType: 'agent', senderId: 'agent-2', deliveryStatus: 'queued', deliveryDetail: null } });
      });

      it('is not requeued for the user, another agent, or another owner', async () => {
        await creatorFailed();

        expect(await retry('creator-msg')).toEqual({ ok: true, data: null });
        expect(await retry('creator-msg', 'user-1', 'agent-1', { type: 'agent', agentId: 'agent-3' })).toEqual({ ok: true, data: null });
        expect(await retry('creator-msg', 'user-2', 'agent-1', CREATOR)).toEqual({ ok: true, data: null });
        const [row] = await scratch.sql`SELECT delivery_status FROM conversation_messages WHERE id = 'creator-msg'`;
        expect(row?.delivery_status).toBe('failed');
      });
    });

    describe('a stuck queued message', () => {
      it('is not claimable while younger than the stale age', async () => {
        await user('agent-1', 'hello', 'client-1');

        expect(await retry()).toEqual({ ok: true, data: null });
      });

      it('is claimable once older than the stale age, and the claim restamps queued_at', async () => {
        await user('agent-1', 'hello', 'client-1');
        ageQueuedRows();

        const claimed = await retry();
        const again = await retry();

        expect(claimed).toMatchObject({ ok: true, data: { id: 'client-1', deliveryStatus: 'queued' } });
        expect(again).toEqual({ ok: true, data: null });
      });

      it('lets exactly one of several concurrent retries claim it', async () => {
        await user('agent-1', 'hello', 'client-1');
        ageQueuedRows();

        const results = await Promise.all(Array.from({ length: 6 }, () => retry()));

        expect(results.filter((result) => result.ok && result.data !== null)).toHaveLength(1);
      });

      it('can be marked sent after the claim', async () => {
        await user('agent-1', 'hello', 'client-1');
        ageQueuedRows();
        await retry();

        const sent = await service().markDelivery({ messageId: 'client-1', status: 'sent' });

        expect(sent).toMatchObject({ ok: true, data: { deliveryStatus: 'sent' } });
      });

      it('is not claimable by another user or as a different sender', async () => {
        await user('agent-1', 'hello', 'client-1');
        ageQueuedRows();

        expect(await retry('client-1', 'user-2', 'agent-3')).toEqual({ ok: true, data: null });
        expect(await retry('client-1', 'user-1', 'agent-1', { type: 'agent', agentId: 'agent-2' })).toEqual({ ok: true, data: null });
      });
    });
  });

  describe('findMessage', () => {
    it('returns the sender\'s own message and nothing for another sender, owner or conversation', async () => {
      await user('agent-1', 'hello', 'client-1');

      const own = await service().findMessage({ ownerUserId: 'user-1', agentId: 'agent-1', messageId: 'client-1', sender: { type: 'user' } });
      const asAgent = await service().findMessage({ ownerUserId: 'user-1', agentId: 'agent-1', messageId: 'client-1', sender: { type: 'agent', agentId: 'agent-2' } });
      const otherOwner = await service().findMessage({ ownerUserId: 'user-2', agentId: 'agent-1', messageId: 'client-1', sender: { type: 'user' } });
      const otherThread = await service().findMessage({ ownerUserId: 'user-1', agentId: 'agent-2', messageId: 'client-1', sender: { type: 'user' } });
      const missing = await service().findMessage({ ownerUserId: 'user-1', agentId: 'agent-1', messageId: 'nope', sender: { type: 'user' } });

      expect(own).toMatchObject({ ok: true, data: { id: 'client-1', senderType: 'user', deliveryStatus: 'queued' } });
      expect(asAgent).toEqual({ ok: true, data: null });
      expect(otherOwner).toEqual({ ok: true, data: null });
      expect(otherThread).toEqual({ ok: true, data: null });
      expect(missing).toEqual({ ok: true, data: null });
    });
  });

  describe('deleteUserAgentConversations', () => {
    it('removes the agents\' conversations with their participants and messages, and leaves others', async () => {
      await user('agent-1', 'one');
      await user('agent-2', 'two');
      await user('agent-1', 'one again');

      await deleteUserAgentConversations(drizzle(pool, { schema }), ['agent-1']);

      const [counts] = await scratch.sql<{ conversations: number; participants: number; messages: number }[]>`
        SELECT (SELECT count(*)::int FROM conversations) AS conversations,
               (SELECT count(*)::int FROM conversation_participants) AS participants,
               (SELECT count(*)::int FROM conversation_messages) AS messages`;
      expect(counts).toEqual({ conversations: 1, participants: 2, messages: 1 });
    });

    it('does nothing for an empty list', async () => {
      await user('agent-1', 'one');

      await deleteUserAgentConversations(drizzle(pool, { schema }), []);

      const [count] = await scratch.sql`SELECT count(*)::int AS n FROM conversations`;
      expect(count?.n).toBe(1);
    });
  });

  describe('listThread', () => {
    const seed = async (count: number) => {
      for (let i = 1; i <= count; i++) await user('agent-1', `m${i}`);
    };
    const bodies = (result: Awaited<ReturnType<ConversationService['listThread']>>) =>
      result.ok ? result.data.map((m) => m.body) : null;

    it('returns the newest page in ascending order', async () => {
      await seed(5);

      const page = await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1', limit: 3 });

      expect(bodies(page)).toEqual(['m3', 'm4', 'm5']);
    });

    it('walks back through older pages with the before cursor without gaps or repeats', async () => {
      await seed(7);
      const collected: string[] = [];
      let cursor: { before: Date; beforeId: string } | undefined;

      for (let guard = 0; guard < 5; guard++) {
        const page = await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1', limit: 3, ...cursor });
        if (!page.ok || page.data.length === 0) break;
        collected.unshift(...page.data.map((m) => m.body));
        const oldest = page.data[0];
        cursor = oldest ? { before: oldest.createdAt, beforeId: oldest.id } : undefined;
      }

      expect(collected).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    });

    it('orders rows that share a timestamp by id, deterministically', async () => {
      const at = new Date(clock + 1000);
      for (const id of ['b', 'a', 'c']) {
        await repo.recordUserAgentMessage({
          conversationId: userAgentConversationId('agent-1'), ownerUserId: 'user-1', agentId: 'agent-1',
          message: { id, senderType: 'user', senderId: 'user-1', channel: 'web', subject: null, body: id, messageClass: null, deliveryStatus: 'queued', createdAt: at },
        });
      }

      const page = await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1' });

      expect(bodies(page)).toEqual(['a', 'b', 'c']);
    });

    it('pages across a run of rows that share one timestamp without skipping or repeating any', async () => {
      const at = new Date(clock + 1000);
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      await user('agent-1', 'older');
      for (const id of ids) {
        await repo.recordUserAgentMessage({
          conversationId: userAgentConversationId('agent-1'), ownerUserId: 'user-1', agentId: 'agent-1',
          message: { id, senderType: 'user', senderId: 'user-1', channel: 'web', subject: null, body: id, messageClass: null, deliveryStatus: 'queued', createdAt: at },
        });
      }
      const collected: string[] = [];
      let cursor: { before: Date; beforeId: string } | undefined;

      for (let guard = 0; guard < 6; guard++) {
        const page = await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1', limit: 3, ...cursor });
        if (!page.ok || page.data.length === 0) break;
        collected.unshift(...page.data.map((m) => m.body));
        const oldest = page.data[0];
        cursor = oldest ? { before: oldest.createdAt, beforeId: oldest.id } : undefined;
      }

      expect(collected).toEqual(['older', ...ids]);
    });

    it('rejects a cursor with only one half', async () => {
      const missingId = await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1', before: new Date(clock) });
      const missingTime = await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1', beforeId: 'x' });

      expect(missingId).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidCursor } });
      expect(missingTime).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidCursor } });
    });

    it('keeps a conversation per agent separate', async () => {
      await user('agent-1', 'for one');
      await user('agent-2', 'for two');

      expect(bodies(await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-1' }))).toEqual(['for one']);
      expect(bodies(await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-2' }))).toEqual(['for two']);
    });

    it('returns an empty thread to a user who does not own it, and for an agent with no messages', async () => {
      await user('agent-1', 'private');

      expect(bodies(await service().listThread({ ownerUserId: 'user-2', agentId: 'agent-1' }))).toEqual([]);
      expect(bodies(await service().listThread({ ownerUserId: 'user-1', agentId: 'agent-2' }))).toEqual([]);
    });

    it('clamps the page to the configured maximum', async () => {
      const small = new ConversationService({ store: repo, limits: { ...LIMITS, threadMaxPageSize: 2 }, newId: () => `s-${++nextId}`, now: () => new Date(++clock) });
      await seed(4);

      const page = await small.listThread({ ownerUserId: 'user-1', agentId: 'agent-1', limit: 100 });

      expect(bodies(page)).toEqual(['m3', 'm4']);
    });
  });
  describe('peer messages (A2A-B)', () => {
    const peer = (from: string, to: string, body = 'hello', extra: Record<string, unknown> = {}) =>
      service().recordPeerMessage({ ownerUserId: 'user-1', fromAgentId: from, toAgentId: to, body, ...extra });
    const peerBodies = (messages: { ok: boolean; data?: unknown }) => ((messages as { data: Array<{ body: string }> }).data).map((m) => m.body);

    beforeEach(async () => {
      await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES
        ('agent-4', 'user-1', 'Dozer', 'p', 'active'),
        ('agent-5', 'user-1', 'Zuri', 'p', 'stopped')`;
    });

    it('records a message as sent by the sending agent in one agent_agent thread with two agent participants', async () => {
      const recorded = await peer('agent-2', 'agent-1', 'from kofi');

      expect(recorded).toMatchObject({ ok: true, data: { created: true, message: { senderType: 'agent', senderId: 'agent-2', channel: 'internal', deliveryStatus: 'queued', body: 'from kofi' } } });
      const [thread] = await scratch.sql<{ id: string; kind: string; owner_user_id: string; peer_key: string; last_message_at: Date | null }[]>`
        SELECT id, kind, owner_user_id, peer_key, last_message_at FROM conversations`;
      expect(thread).toMatchObject({ id: peerConversationId('agent-1', 'agent-2'), kind: 'agent_agent', owner_user_id: 'user-1', peer_key: 'agent-1:agent-2' });
      expect(thread?.last_message_at).not.toBeNull();
      const participants = await scratch.sql`SELECT participant_type, participant_id FROM conversation_participants ORDER BY participant_id`;
      expect(participants.map((p) => `${p.participant_type}:${p.participant_id}`)).toEqual(['agent:agent-1', 'agent:agent-2']);
    });

    it('is never recorded as a user message', async () => {
      await peer('agent-1', 'agent-2');

      const rows = await scratch.sql`SELECT sender_type FROM conversation_messages`;
      expect(rows.map((r) => r.sender_type)).toEqual(['agent']);
    });

    it('keeps one thread per pair when both agents write first at the same time', async () => {
      const results = await Promise.all([
        peer('agent-1', 'agent-2', 'a'), peer('agent-2', 'agent-1', 'b'),
        peer('agent-1', 'agent-2', 'c'), peer('agent-2', 'agent-1', 'd'),
        peer('agent-1', 'agent-2', 'e'), peer('agent-2', 'agent-1', 'f'),
      ].map((p) => p));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(await scratch.sql`SELECT id FROM conversations WHERE kind = 'agent_agent'`).toHaveLength(1);
      expect(await scratch.sql`SELECT 1 FROM conversation_participants`).toHaveLength(2);
      expect(await scratch.sql`SELECT 1 FROM conversation_messages`).toHaveLength(6);
    });

    it('stores a refused message with its reason code, in the same thread', async () => {
      await peer('agent-1', 'agent-2', 'sent');
      const refused = await peer('agent-1', 'agent-2', 'too many', { id: 'refused-1', deliveryStatus: 'refused', deliveryDetail: 'peer.rate_limited' });

      expect(refused).toMatchObject({ ok: true, data: { message: { deliveryStatus: 'refused', deliveryDetail: 'peer.rate_limited' } } });
      const thread = await service().listPeerThread({ ownerUserId: 'user-1', agentId: 'agent-1', peerAgentId: 'agent-2' });
      expect(thread).toMatchObject({ ok: true });
      expect((thread as { data: Array<{ deliveryStatus: string }> }).data.map((m) => m.deliveryStatus)).toEqual(['queued', 'refused']);
    });

    it('returns the stored row for a repeated id and refuses an id used in another thread', async () => {
      await peer('agent-1', 'agent-2', 'once', { id: 'env-1' });

      const again = await peer('agent-1', 'agent-2', 'once', { id: 'env-1' });
      const elsewhere = await peer('agent-1', 'agent-4', 'once', { id: 'env-1' });

      expect(again).toMatchObject({ ok: true, data: { created: false } });
      expect(elsewhere).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.messageIdConflict } });
      expect(await scratch.sql`SELECT 1 FROM conversation_messages`).toHaveLength(1);
      expect(await scratch.sql`SELECT 1 FROM conversations`).toHaveLength(1);
    });

    it('refuses a write into another owner\'s thread and leaves nothing behind', async () => {
      await peer('agent-1', 'agent-2', 'mine');

      const foreign = await service().recordPeerMessage({ ownerUserId: 'user-2', fromAgentId: 'agent-1', toAgentId: 'agent-2', body: 'intruder' });

      expect(foreign).toMatchObject({ ok: false, error: { code: CONVERSATION_ERROR_CODES.ownerMismatch } });
      expect(await scratch.sql`SELECT body FROM conversation_messages`).toHaveLength(1);
    });

    it('marks a queued peer message sent and keeps it on the internal channel', async () => {
      await peer('agent-1', 'agent-2', 'hello', { id: 'env-1' });

      const marked = await service().markDelivery({ messageId: 'env-1', status: 'sent' });

      expect(marked).toMatchObject({ ok: true, data: { deliveryStatus: 'sent', channel: 'internal' } });
    });

    describe('listPeerThreads', () => {
      it('lists the agent\'s threads newest first with the peer of each, in two queries whatever the page size', async () => {
        await peer('agent-1', 'agent-2', 'first');
        await peer('agent-4', 'agent-1', 'second');
        await peer('agent-1', 'agent-5', 'third');
        await peer('agent-2', 'agent-1', 'fourth, back to the first thread');
        let queries = 0;
        const counting = new ConversationRepository(drizzle(pool, { schema, logger: { logQuery: () => { queries += 1; } } }));
        const countingService = new ConversationService({ store: counting, limits: LIMITS, newId: () => `c-${++nextId}`, now: () => new Date(++clock) });

        const threads = await countingService.listPeerThreads({ ownerUserId: 'user-1', agentId: 'agent-1' });

        expect(queries).toBe(2);
        expect(threads).toMatchObject({ ok: true });
        expect((threads as { data: Array<{ peerAgentId: string }> }).data.map((t) => t.peerAgentId)).toEqual(['agent-2', 'agent-5', 'agent-4']);

        queries = 0;
        await countingService.listPeerThreads({ ownerUserId: 'user-1', agentId: 'agent-4' });
        expect(queries).toBe(2);
      });

      it('lists only the owner\'s threads that include the agent, and applies the limit', async () => {
        await peer('agent-1', 'agent-2');
        await peer('agent-1', 'agent-4');
        await peer('agent-2', 'agent-4');
        await user('agent-1', 'a user thread is not a peer thread');

        const all = await service().listPeerThreads({ ownerUserId: 'user-1', agentId: 'agent-1' });
        const limited = await service().listPeerThreads({ ownerUserId: 'user-1', agentId: 'agent-1', limit: 1 });
        const stranger = await service().listPeerThreads({ ownerUserId: 'user-2', agentId: 'agent-1' });

        expect((all as { data: unknown[] }).data).toHaveLength(2);
        expect((limited as { data: unknown[] }).data).toHaveLength(1);
        expect((stranger as { data: unknown[] }).data).toEqual([]);
      });

      it('returns an empty list for an agent with no peer threads', async () => {
        expect(await service().listPeerThreads({ ownerUserId: 'user-1', agentId: 'agent-1' })).toEqual({ ok: true, data: [] });
      });
    });

    describe('listPeerThread', () => {
      it('reads the same messages from either side, oldest first, and pages by cursor', async () => {
        await peer('agent-1', 'agent-2', 'm1');
        await peer('agent-2', 'agent-1', 'm2');
        await peer('agent-1', 'agent-2', 'm3');

        const fromOne = await service().listPeerThread({ ownerUserId: 'user-1', agentId: 'agent-1', peerAgentId: 'agent-2' });
        const fromTwo = await service().listPeerThread({ ownerUserId: 'user-1', agentId: 'agent-2', peerAgentId: 'agent-1' });
        const page = await service().listPeerThread({ ownerUserId: 'user-1', agentId: 'agent-1', peerAgentId: 'agent-2', limit: 2 });
        const oldest = (page as { data: Array<{ createdAt: Date; id: string }> }).data[0]!;
        const older = await service().listPeerThread({ ownerUserId: 'user-1', agentId: 'agent-1', peerAgentId: 'agent-2', limit: 2, before: oldest.createdAt, beforeId: oldest.id });

        expect(peerBodies(fromOne)).toEqual(['m1', 'm2', 'm3']);
        expect(peerBodies(fromTwo)).toEqual(['m1', 'm2', 'm3']);
        expect(peerBodies(page)).toEqual(['m2', 'm3']);
        expect(peerBodies(older)).toEqual(['m1']);
      });

      it('does not show another owner\'s thread, or the user thread of the same agent', async () => {
        await peer('agent-1', 'agent-2', 'private');
        await user('agent-1', 'user thread');

        expect(peerBodies(await service().listPeerThread({ ownerUserId: 'user-2', agentId: 'agent-1', peerAgentId: 'agent-2' }))).toEqual([]);
        expect(peerBodies(await service().listPeerThread({ ownerUserId: 'user-1', agentId: 'agent-1', peerAgentId: 'agent-2' }))).toEqual(['private']);
      });
    });

    it('removes the peer threads of a deleted agent, and only those', async () => {
      await peer('agent-1', 'agent-2', 'gone');
      await peer('agent-1', 'agent-4', 'gone too');
      await peer('agent-2', 'agent-4', 'stays');
      await user('agent-1', 'user thread');

      await deleteUserAgentConversations(drizzle(pool, { schema }), ['agent-1']);

      const left = await scratch.sql<{ id: string }[]>`SELECT id FROM conversations ORDER BY id`;
      expect(left.map((c) => c.id)).toEqual([peerConversationId('agent-2', 'agent-4')]);
      expect(await scratch.sql`SELECT 1 FROM conversation_messages`).toHaveLength(1);
      expect(await scratch.sql`SELECT 1 FROM conversation_participants`).toHaveLength(2);
    });
  });

  describe('AgentRepository peer reads (A2A-B)', () => {
    let agents: AgentRepository;
    beforeEach(() => { agents = new AgentRepository(drizzle(pool, { schema })); });

    it('reads the stop switch: off by default, on after the owner turns it on, on for an unknown user (fail closed)', async () => {
      expect(await agents.isPeerMessagingPaused('user-1')).toBe(false);

      await scratch.sql`UPDATE users SET peer_messaging_paused = true WHERE id = 'user-1'`;

      expect(await agents.isPeerMessagingPaused('user-1')).toBe(true);
      expect(await agents.isPeerMessagingPaused('user-2')).toBe(false);
      expect(await agents.isPeerMessagingPaused('nobody')).toBe(true);
    });

    it('lists one user\'s agents as id, name and status, and no other user\'s', async () => {
      const summaries = await agents.listAgentSummaries('user-1');

      expect(summaries).toEqual([
        { id: 'agent-2', name: 'Kofi', status: 'active' },
        { id: 'agent-1', name: 'Momo', status: 'active' },
      ]);
      expect(Object.keys(summaries[0]!).sort()).toEqual(['id', 'name', 'status']);
    });
  });
});
