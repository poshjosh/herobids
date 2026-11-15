/**
 * Worker flow: an agent created with the UI id `ext:o/r/s` later calls the real `add_skills` tool.
 *
 * The real tool, the real AgentMessageBroker and a real Postgres run end to end. Only the skills CLI is replaced
 * (a recording installer over a temp source tree) and the Redis reply list is an in-memory queue. The assertions
 * are on the rows the agent ends up with and on the ref the installer receives.
 *
 * Runs in a scratch database it creates and drops, and only against a local Postgres (DATABASE_URL on localhost).
 * Skipped otherwise.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Redis from 'ioredis';
import {
  AgentRepository,
  closeDatabase,
  createDatabase,
  ensureExternalSkillIds,
  externalSkillIdForRef,
  syncAgentSkillAssignments,
  type Database,
} from '@herobids/db';
import type { ExternalSkillInstaller, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import {
  createScratchDatabase,
  localDatabaseUrl,
  type ScratchDatabase,
} from '../../../../../packages/db/src/test-helpers/scratch-database.js';
import { AgentMessageBroker } from '../../agents/agent-message-broker.js';
import type { InstanceEventPublisher } from '../../agents/instance-event-publisher.js';
import { LocalDirectorySkillInstaller } from '../../tools/local-directory-skill-installer.js';
import { addSkillsTool } from '../../tools/skills.js';

const BASE_URL = localDatabaseUrl();
const CANONICAL_REF = 'o/r/s';
const EXTERNAL_SKILL_ID = externalSkillIdForRef(CANONICAL_REF);
const T0 = new Date('2026-10-30T10:00:00.000Z');
const USER_ID = 'user-U';
const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';

describe.skipIf(!BASE_URL)('add_skills for an agent created with an ext:-prefixed external skill (integration)', () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let sourceRoot: string;
  let workspaceRoot: string;
  let installedRefs: string[];
  let replies: Map<string, string[]>;
  let broker: AgentMessageBroker;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, '9999_all.sql');
    const scratchUrl = new URL(BASE_URL!);
    scratchUrl.pathname = `/${scratch.sql.options.database}`;
    db = createDatabase(scratchUrl.toString(), { max: 4 });
  }, 120_000);

  afterAll(async () => {
    if (db) await closeDatabase(db);
    await scratch?.drop();
  });

  beforeEach(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'hb-ext-ref-src-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'hb-ext-ref-ws-'));
    vi.stubEnv('AGENT_WORKSPACE_ROOT', workspaceRoot);
    const skillDir = join(sourceRoot, 'o', 'r', 'skills', 's');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: s\ndescription: Test skill.\n---\nBody.\n', 'utf-8');
    installedRefs = [];
    replies = new Map();

    await scratch.sql`TRUNCATE agent_skills, skill_usage_events, agent_messages, agent_runtime_sessions, agents, users CASCADE`;
    await scratch.sql`DELETE FROM skills WHERE source_ref IS NOT NULL`;
    await scratch.sql`INSERT INTO users (id, username, display_name, email) VALUES (${USER_ID}, 'owner', 'Owner', 'owner@example.test')`;
    await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES (${AGENT_ID}, ${USER_ID}, 'Momo', 'p', 'active')`;
    await scratch.sql`INSERT INTO agent_runtime_sessions (id, agent_id, status) VALUES (${SESSION_ID}, ${AGENT_ID}, 'running')`;

    const eventPublisher = {
      publishSkillsReply: async (requestMessageId: string, result: unknown) => {
        const queue = replies.get(requestMessageId) ?? [];
        queue.push(JSON.stringify(result));
        replies.set(requestMessageId, queue);
      },
    } as unknown as InstanceEventPublisher;
    broker = new AgentMessageBroker(
      {} as Redis,
      new AgentRepository(db),
      {} as never,
      {} as never,
      eventPublisher,
      undefined, undefined, undefined, undefined, undefined, undefined,
      db,
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  /** Installer that records the ref it is given, then installs from the temp source tree. */
  function recordingInstaller(): ExternalSkillInstaller {
    const local = new LocalDirectorySkillInstaller({ sourceRoot });
    return {
      install: async (ref, cwd) => {
        installedRefs.push(ref);
        return local.install(ref, cwd);
      },
    };
  }

  /** The agent as the create flow leaves it: `ext:o/r/s` resolved to one skill, assigned by the user at T0. */
  async function createAgentWithPrefixedSkill(): Promise<void> {
    const [skillId] = await ensureExternalSkillIds(db, ['ext:o/r/s']);
    const [skill] = await scratch.sql`SELECT current_revision_id FROM skills WHERE id = ${skillId!}`;
    await syncAgentSkillAssignments(
      db,
      AGENT_ID,
      USER_ID,
      [{ skillId: skillId!, skillRevisionId: skill!['current_revision_id'] as string }],
      'user_select',
    );
    await scratch.sql`UPDATE agent_skills SET assigned_at = ${T0} WHERE agent_id = ${AGENT_ID}`;
  }

  /** The `add_skills` tool wired to the real broker: the tool's publish becomes a broker envelope, its reply read back. */
  function toolContext(): ToolContext {
    return {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      db,
      externalSkillInstaller: recordingInstaller(),
      redis: {
        blpop: async (key: string): Promise<[string, string] | null> => {
          const reply = replies.get(key.replace('agent:skills:reply:', ''))?.shift();
          return reply === undefined ? null : [key, reply];
        },
      },
      publishToInbound: async (type: string, payload: Record<string, unknown>) => {
        await broker.processInbound({
          schemaVersion: 'v1',
          messageId: crypto.randomUUID(),
          correlationId: SESSION_ID,
          initiatorType: 'agent',
          initiatorId: AGENT_ID,
          agentId: AGENT_ID,
          type,
          createdAt: new Date().toISOString(),
          payload,
        });
      },
    } as unknown as ToolContext;
  }

  async function skillRows() {
    return scratch.sql`SELECT id, slug, source_ref FROM skills WHERE source_ref IS NOT NULL`;
  }

  async function assignments() {
    return scratch.sql`SELECT skill_id, assignment_source, assigned_at, assigned_by_user_id FROM agent_skills WHERE agent_id = ${AGENT_ID}`;
  }

  it.each(['o/r@s', 'o/r/s', 'ext:o/r/s'])(
    'add_skills([%s]) for an agent created with ext:o/r/s adds nothing new, keeps user_select, and installs via o/r@s',
    async (spelling) => {
      await createAgentWithPrefixedSkill();

      const result = await addSkillsTool.execute({ skillIds: [spelling], includeDependencies: false }, toolContext());

      expect(result.success).toBe(true);
      expect(installedRefs).toEqual(['o/r@s']);
      const rows = await skillRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: EXTERNAL_SKILL_ID, slug: CANONICAL_REF, source_ref: CANONICAL_REF });
      const held = await assignments();
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ skill_id: EXTERNAL_SKILL_ID, assignment_source: 'user_select', assigned_by_user_id: USER_ID });
      expect((held[0]!['assigned_at'] as Date).toISOString()).toBe(T0.toISOString());
    },
  );

  it('add_skills(["ext:o/r/s"]) called directly installs via o/r@s and assigns one canonical skill as agent_self', async () => {
    const result = await addSkillsTool.execute({ skillIds: ['ext:o/r/s'], includeDependencies: false }, toolContext());

    expect(result.success).toBe(true);
    expect(installedRefs).toEqual(['o/r@s']);
    const rows = await skillRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: EXTERNAL_SKILL_ID, source_ref: CANONICAL_REF });
    const held = await assignments();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ skill_id: EXTERNAL_SKILL_ID, assignment_source: 'agent_self' });
  });
});
