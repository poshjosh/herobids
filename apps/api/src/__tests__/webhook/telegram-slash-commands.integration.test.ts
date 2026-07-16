/**
 * Webhook-level integration tests for Telegram slash commands.
 *
 * Exercises the full dispatch path:
 *   Telegram text → parseSlashCommand → handler → response sent via sendMessage
 *
 * Also includes stopped-agent constraint tests for /mode, /connect, /disconnect (H2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { telegramWebhookHandler } from '../../routes/agent-interactivity.js';
import { ok, err } from '@herobids/domain';
import type { Database } from '@herobids/db';
import type { Redis } from 'ioredis';

// ── Service mocks ─────────────────────────────────────────────────────────

vi.mock('../../services/agent-lifecycle-service.js', () => ({
  startAgent: vi.fn(),
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock('../../services/agent-config-service.js', () => ({
  setExecutionMode: vi.fn(),
  grantConnection: vi.fn(),
  revokeConnection: vi.fn(),
  listAgentConnections: vi.fn(),
}));

import { startAgent, stopAgent } from '../../services/agent-lifecycle-service.js';
import { setExecutionMode, grantConnection, revokeConnection } from '../../services/agent-config-service.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const TEST_USER_ID = 'user-1';
const TEST_CHAT_ID = '12345';
const AGENT_ID = 'agent-1';
const AGENT_NAME = 'MyAgent';

/** Flush all pending promise micro-tasks — needed after webhook inject calls
 *  because the handler fires delivery work asynchronously (fire-and-forget). */
function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function buildMockRedis() {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1-1'),
    hgetall: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    ttl: vi.fn().mockResolvedValue(-1),
  } as unknown as Redis;
}

function buildAlertsConfig() {
  return {
    enabled: false,
    dispatchIntervalMs: 10_000,
    defaultCooldownMs: 0,
    maxBatchSize: 10,
    maxRetries: 3,
    telegram: {
      botToken: 'test-bot-token',
      webhookSecret: 'webhook-secret',
      channels: [],
    },
    email: {
      apiKey: '',
      fromEmail: '',
      timeoutMs: 10_000,
    },
  };
}

const WEBHOOK_HEADERS = {
  'x-telegram-bot-api-secret-token': 'webhook-secret',
};

async function sendWebhook(
  app: ReturnType<typeof Fastify>,
  text: string,
  chatId = TEST_CHAT_ID,
) {
  return app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: WEBHOOK_HEADERS,
    payload: {
      message: {
        chat: { id: chatId },
        text,
      },
    },
  });
}

/**
 * Extract the `text` field from the JSON body of the first Telegram
 * sendMessage fetch call.
 */
function sentText(fetchSpy: ReturnType<typeof vi.fn>): string | null {
  const sendMsgCall = fetchSpy.mock.calls.find(
    (c: unknown[]) => typeof c[0] === 'string' && String(c[0]).includes('sendMessage'),
  );
  if (!sendMsgCall) return null;
  const body = (sendMsgCall[1] as RequestInit | undefined)?.body;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.text === 'string' ? (parsed.text as string) : null;
  } catch {
    return null;
  }
}

// ─── Stub rows ────────────────────────────────────────────────────────────

function stubAgent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: AGENT_ID,
    userId: TEST_USER_ID,
    name: AGENT_NAME,
    prompt: 'Test agent',
    skillIds: [],
    status: 'stopped',
    toolPolicy: null,
    modelPolicy: null,
    telegramChatId: null,
    executionMode: null,
    dailyTokenBudget: null,
    dailyLossLimit: null,
    maxBots: null,
    maxSlippageBps: null,
    pauseState: null,
    unifiedConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Telegram Slash Commands — Webhook Integration', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
  });

  // ── H1: Unbound chat ──────────────────────────────────────────────────

  it('unbound chat — any command returns "bind first" message', async () => {
    // User lookup returns empty → no userId bound
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([]); // always empty
      }),
      execute: vi.fn().mockResolvedValue([{ count: 0 }]),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/agents');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('bind your Telegram account');
  });

  // ── H1: /help ─────────────────────────────────────────────────────────

  it('/help returns command list', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/help');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Available commands:');
    expect(text).toContain('Discovery');
    expect(text).toContain('Lifecycle');
    expect(text).toContain('Config');
  });

  it('/help start returns detailed start help', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/help start');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('/start');
    expect(text).toContain('Starts a stopped agent');
  });

  it('/help /start (leading slash) returns same as /help start (M5)', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/help /start');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('/start');
    expect(text).toContain('Starts a stopped agent');
  });

  // ── H1: /agents ──────────────────────────────────────────────────────

  it('/agents returns agent list', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return makeChain([{ userId: TEST_USER_ID }]);
        }
        return makeChain([{ name: 'TestAgent', status: 'stopped' }]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/agents');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('TestAgent');
    expect(text).toContain('stopped');
  });

  it('/agents returns helpful message when user has no agents', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([]); // empty agent list
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/agents');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain("don't have any agents");
  });

  // ── H1: /info ────────────────────────────────────────────────────────

  it('/info <agent> returns detail block', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active', executionMode: 'test' })]);
      }),
      execute: vi.fn().mockResolvedValue([{ count: 0 }]),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/info ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain(AGENT_NAME);
    expect(text).toContain('Status:');
    expect(text).toContain('Execution mode:');
  });

  // ── H1: /start ───────────────────────────────────────────────────────

  it('/start <agent> starts a stopped agent (happy path)', async () => {
    const mockStart = vi.mocked(startAgent);
    mockStart.mockResolvedValue(ok({ status: 'active' }));

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'stopped' })]);
      }),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({})),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/start ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Started');
    expect(text).toContain(AGENT_NAME);
  });

  it('/start <agent> rejects already-running agent', async () => {
    const mockStart = vi.mocked(startAgent);
    mockStart.mockResolvedValue(
      err({ code: 'agent.invalid_status', message: 'Not stopped', currentStatus: 'active' }),
    );

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active' })]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/start ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('cannot start');
    expect(text).toContain('active');
  });

  // ── H1: /stop ────────────────────────────────────────────────────────

  it('/stop <agent> stops an agent (happy path)', async () => {
    const mockStop = vi.mocked(stopAgent);
    mockStop.mockResolvedValue(ok({ status: 'stopped' }));

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active' })]);
      }),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({})),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/stop ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Stopped');
    expect(text).toContain(AGENT_NAME);
  });

  // ── H2: Stopped-agent constraint — /mode ──────────────────────────────

  it('/mode <agent> live rejects non-stopped agent', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active' })]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/mode ${AGENT_NAME} live`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Cannot change execution mode');
    expect(text).toContain('active');
    expect(text).toContain('Stop the agent first');
  });

  // ── H2: Stopped-agent constraint — /connect ──────────────────────────

  it('/connect <agent> <id> rejects non-stopped agent', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active' })]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/connect ${AGENT_NAME} conn-1`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Cannot change connections');
    expect(text).toContain('active');
    expect(text).toContain('Stop the agent first');
  });

  // ── H2: Stopped-agent constraint — /disconnect ───────────────────────

  it('/disconnect <agent> <id> rejects non-stopped agent', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active' })]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/disconnect ${AGENT_NAME} conn-1`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Cannot change connections');
    expect(text).toContain('active');
    expect(text).toContain('Stop the agent first');
  });

  // ── H1: Unknown command ───────────────────────────────────────────────

  it('unknown command returns help with unrecognized message', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/foobar');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Unknown command:');
    expect(text).toContain('/foobar');
  });

  // ── H1: Bare /start ──────────────────────────────────────────────────

  it('bare /start returns onboarding/help', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, '/start');
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('Available commands:');
    expect(text).not.toContain('Usage: /start');
  });

  // ── H1: /connect setup link flow ─────────────────────────────────────

  it('/connect <agent> with no connections offers setup link when authConfig provided', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        if (selectCount === 2) return makeChain([stubAgent({ status: 'stopped' })]);
        if (selectCount === 3) return makeChain([]); // user connections — none
        return makeChain([]); // any connection — none
      }),
    } as unknown as Database;
    const redis = {
      ...buildMockRedis(),
      ttl: vi.fn().mockResolvedValue(-1),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const app = Fastify();
    const authConfig = {
      jwtSecret: 'test-secret-at-least-32-chars-long!!',
      loginLinkTtlSecs: 600,
      loginLinkResendCooldownSecs: 60,
      publicBaseUrl: 'https://herobids.com',
    };
    await telegramWebhookHandler(app, db, redis as unknown as Redis, buildAlertsConfig(), authConfig);

    const res = await sendWebhook(app, `/connect ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('link');
    expect(text).toContain(AGENT_NAME);
  });

  it('/connect <agent> with active connections lists them and still offers setup for a new one', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        if (selectCount === 2) return makeChain([stubAgent({ status: 'stopped' })]);
        return makeChain([
          { id: 'a2b32d6c-1111', label: '1inch', provider: '1inch', status: 'active' },
          { id: '2fec1431-2222', label: 'Hyperliquid', provider: 'hyperliquid', status: 'active' },
        ]);
      }),
    } as unknown as Database;
    const redis = {
      ...buildMockRedis(),
      ttl: vi.fn().mockResolvedValue(-1),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const app = Fastify();
    const authConfig = {
      jwtSecret: 'test-secret-at-least-32-chars-long!!',
      loginLinkTtlSecs: 600,
      loginLinkResendCooldownSecs: 60,
      publicBaseUrl: 'https://herobids.com',
    };
    await telegramWebhookHandler(app, db, redis as unknown as Redis, buildAlertsConfig(), authConfig);

    const res = await sendWebhook(app, `/connect ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain(`Choose a connection for ${AGENT_NAME}:`);
    expect(text).toContain('a2b32d6c... — 1inch: 1inch');
    expect(text).toContain('2fec1431... — hyperliquid: Hyperliquid');
    expect(text).toContain(`Use /connect ${AGENT_NAME} <id> or /connect ${AGENT_NAME} "label" to pick one.`);
    expect(text).toContain('Need a new connection instead? Open this setup link:');
    expect(text).toMatch(/https:\/\/herobids\.com\/auth\/setup-link\/callback\?token=/);
  });

  // ── H1: /mode read-only (no second arg) ──────────────────────────────

  it('/mode <agent> (read-only) shows current execution mode', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([{ userId: TEST_USER_ID }]);
        return makeChain([stubAgent({ status: 'active', executionMode: 'test' })]);
      }),
    } as unknown as Database;
    const redis = buildMockRedis();
    const app = Fastify();
    await telegramWebhookHandler(app, db, redis, buildAlertsConfig());

    const res = await sendWebhook(app, `/mode ${AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    await flushPromises();

    const text = sentText(fetchSpy);
    expect(text).toContain('execution mode');
    expect(text).toContain('simulated');
  });
});

// ─── H2: Stopped-agent constraint — handler-level unit tests ─────────────

describe('Telegram Slash Commands — Stopped-Agent Constraints (Handler Unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMode rejects non-stopped agent with "Cannot change execution mode"', async () => {
    const { handleMode } = await import('../../routes/telegram-command-handlers.js');

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([stubAgent({ status: 'active' })]);
        return makeChain([]);
      }),
    } as unknown as Database;

    const result = await handleMode(db, TEST_USER_ID, ['MyAgent', 'live']);
    expect(result).toContain('Cannot change execution mode');
    expect(result).toContain('active');
    expect(result).toContain('Stop the agent first');
    expect(setExecutionMode).not.toHaveBeenCalled();
  });

  it('handleConnect rejects non-stopped agent with "Agent must be stopped"', async () => {
    const { handleConnect } = await import('../../routes/telegram-command-handlers.js');

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([stubAgent({ status: 'active' })]);
      }),
    } as unknown as Database;

    const result = await handleConnect(db, TEST_USER_ID, ['MyAgent', 'conn-1']);
    expect(result).toContain('Cannot change connections');
    expect(result).toContain('active');
    expect(result).toContain('Stop the agent first');
    expect(grantConnection).not.toHaveBeenCalled();
  });

  it('handleDisconnect rejects non-stopped agent with "Agent must be stopped"', async () => {
    const { handleDisconnect } = await import('../../routes/telegram-command-handlers.js');

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        return makeChain([stubAgent({ status: 'active' })]);
      }),
    } as unknown as Database;

    const result = await handleDisconnect(db, TEST_USER_ID, ['MyAgent', 'conn-1']);
    expect(result).toContain('Cannot change connections');
    expect(result).toContain('active');
    expect(result).toContain('Stop the agent first');
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  it('handleMode accepts stopped agent and calls setExecutionMode', async () => {
    const mockSetMode = vi.mocked(setExecutionMode);
    mockSetMode.mockResolvedValue(ok({ mode: 'test' }));

    const { handleMode } = await import('../../routes/telegram-command-handlers.js');

    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount += 1;
        if (selectCount === 1) return makeChain([stubAgent({ status: 'stopped' })]);
        return makeChain([{ skillId: 'trading' }]); // skills query — real system skill ID
      }),
    } as unknown as Database;

    const result = await handleMode(db, TEST_USER_ID, ['MyAgent', 'live']);
    expect(result).toContain('execution mode set to');
    expect(setExecutionMode).toHaveBeenCalled();
  });
});
