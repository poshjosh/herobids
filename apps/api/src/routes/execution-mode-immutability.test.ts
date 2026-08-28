/**
 * Unit tests for execution-mode immutability (Task 2).
 *
 * Covers:
 * - handleMode: rejection when mode arg provided, read-only display, usage message
 * - handleGoLive: placeholder behaviour
 * - parseSlashCommand: /golive is a known command
 * - Help text: /help mode is read-only, /help golive exists, general help includes golive
 * - setExecutionMode no longer exported from agent-config-service
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@herobids/db';

// ── Mock agent-config-service (grantConnection/revokeConnection are imported by handlers) ──

vi.mock('../services/agent-config-service.js', () => ({
  grantConnection: vi.fn(),
  revokeConnection: vi.fn(),
  listAgentConnections: vi.fn(),
}));

// ── Mock setup-link-token-service ──

vi.mock('../services/setup-link-token-service.js', () => ({
  makeSetupLinkUrl: vi.fn(),
  createAndStoreSetupLinkToken: vi.fn(),
}));

// ── Mock agent-lifecycle-service ──

vi.mock('../services/agent-lifecycle-service.js', () => ({
  startAgent: vi.fn(),
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

import { handleMode, handleGoLive } from './telegram-command-handlers.js';
import { parseSlashCommand, formatCommandHelp } from './telegram-slash-commands.js';

// ── DB mock helpers ──────────────────────────────────────────────────────

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Momentum',
    status: 'active',
    prompt: 'Trade BTC',
    style: 'balanced',
    executionDefaults: { mode: 'paper' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDb(agents: unknown[]): Database {
  return {
    select: vi.fn().mockReturnValue(makeChain(agents)),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// handleMode
// ─────────────────────────────────────────────────────────────────────────

describe('handleMode', () => {
  // ── Usage message ──

  it('returns usage message when no args provided', async () => {
    const db = makeDb([]);
    const result = await handleMode(db, 'user-1', []);
    expect(result).toBe('Usage: /mode <agent name>');
  });

  // ── Read-only display ──

  it('shows paper execution mode for a paper agent', async () => {
    const db = makeDb([makeAgent({ executionDefaults: { mode: 'paper' } })]);
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toContain('Momentum');
    expect(result).toContain('paper');
    expect(result).toContain('simulated');
  });

  it('shows shadow execution mode for a shadow agent', async () => {
    const db = makeDb([makeAgent({ executionDefaults: { mode: 'shadow' } })]);
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toContain('Momentum');
    expect(result).toContain('shadow');
    expect(result).toContain('venue-backed simulation');
  });

  it('shows live execution mode for a live agent', async () => {
    const db = makeDb([makeAgent({ executionDefaults: { mode: 'live' } })]);
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toContain('Momentum');
    expect(result).toContain('live');
  });

  it('shows "not applicable" when executionDefaults has no mode', async () => {
    const db = makeDb([makeAgent({ executionDefaults: {} })]);
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toContain('Momentum');
    expect(result).toContain('not applicable');
  });

  it('shows "not applicable" when executionDefaults is null', async () => {
    const db = makeDb([makeAgent({ executionDefaults: null })]);
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toContain('Momentum');
    expect(result).toContain('not applicable');
  });

  // ── Rejection when mode arg provided ──

  it('rejects mode change attempt with immutability message', async () => {
    const db = makeDb([makeAgent()]);
    const result = await handleMode(db, 'user-1', ['Momentum', 'live']);

    expect(result).toBe(
      'Execution mode cannot be changed after creation. Use /golive <agent> to create a live copy of this agent\'s configuration.',
    );
  });

  it.each(['paper', 'shadow', 'live', 'nonsense', '123'])(
    'rejects mode value "%s" with immutability message',
    async (modeArg) => {
      const db = makeDb([makeAgent()]);
      const result = await handleMode(db, 'user-1', ['Momentum', modeArg]);
      expect(result).toContain('Execution mode cannot be changed after creation');
      expect(result).toContain('/golive');
    },
  );

  it.each(['stopped', 'active', 'paused', 'starting', 'crashed'])(
    'rejects mode change when agent status is %s',
    async (status) => {
      const db = makeDb([makeAgent({ status })]);
      const result = await handleMode(db, 'user-1', ['Momentum', 'live']);
      expect(result).toContain('Execution mode cannot be changed after creation');
    },
  );

  it('rejects mode change even with extra trailing args', async () => {
    const db = makeDb([makeAgent()]);
    const result = await handleMode(db, 'user-1', ['Momentum', 'live', 'extra']);
    expect(result).toContain('Execution mode cannot be changed after creation');
  });

  // ── Agent resolution errors ──

  it('returns not-found for unknown agent', async () => {
    const db = makeDb([]);
    const result = await handleMode(db, 'user-1', ['Ghost']);
    expect(result).toContain('Agent "Ghost" not found');
  });

  it('returns ambiguous message when multiple agents match', async () => {
    const db = makeDb([
      makeAgent({ id: 'a1', name: 'Momentum' }),
      makeAgent({ id: 'a2', name: 'Momentum' }),
    ]);
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toContain('Multiple agents named "Momentum"');
  });

  // ── Error path ──

  it('returns fallback message when database query fails', async () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
      chain[method] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (
      _resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.reject(new Error('connection refused')).then(undefined, reject);

    const db = { select: vi.fn().mockReturnValue(chain) } as unknown as Database;
    const result = await handleMode(db, 'user-1', ['Momentum']);
    expect(result).toBe('Failed to retrieve execution mode. Please try again later.');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleGoLive
// ─────────────────────────────────────────────────────────────────────────

describe('handleGoLive', () => {
  it('returns usage message when no args provided', async () => {
    const db = {} as Database;
    const result = await handleGoLive(db, 'user-1', []);
    expect(result).toBe('Usage: /golive <agent name>');
  });

  it('returns placeholder message when agent name provided', async () => {
    const db = {} as Database;
    const result = await handleGoLive(db, 'user-1', ['Momentum']);
    expect(result).toBe('Go Live command will be available soon.');
  });

  it('returns placeholder message with multi-word agent name', async () => {
    const db = {} as Database;
    const result = await handleGoLive(db, 'user-1', ['DCA Bot']);
    expect(result).toBe('Go Live command will be available soon.');
  });

  it('returns placeholder message even with extra args', async () => {
    const db = {} as Database;
    const result = await handleGoLive(db, 'user-1', ['Momentum', 'extra']);
    expect(result).toBe('Go Live command will be available soon.');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseSlashCommand — /golive
// ─────────────────────────────────────────────────────────────────────────

describe('parseSlashCommand — /golive', () => {
  it('parses /golive as a known command with no args', () => {
    const result = parseSlashCommand('/golive');
    expect(result).toEqual({
      command: 'golive',
      rawCommand: '/golive',
      args: [],
    });
  });

  it('parses /golive MyAgent as a known command', () => {
    const result = parseSlashCommand('/golive MyAgent');
    expect(result).toEqual({
      command: 'golive',
      rawCommand: '/golive',
      args: ['MyAgent'],
    });
  });

  it('parses /golive with quoted agent name', () => {
    const result = parseSlashCommand('/golive "DCA Bot"');
    expect(result).toEqual({
      command: 'golive',
      rawCommand: '/golive',
      args: ['DCA Bot'],
    });
  });

  it('parses /golive case-insensitively', () => {
    const result = parseSlashCommand('/GoLive Momentum');
    expect(result).toEqual({
      command: 'golive',
      rawCommand: '/GoLive',
      args: ['Momentum'],
    });
  });

  it('strips bot suffix from /golive', () => {
    const result = parseSlashCommand('/golive@MyBot Momentum');
    expect(result).toEqual({
      command: 'golive',
      rawCommand: '/golive@MyBot',
      args: ['Momentum'],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Help text
// ─────────────────────────────────────────────────────────────────────────

describe('help text — mode (read-only)', () => {
  it('/help mode shows read-only help text', () => {
    const help = formatCommandHelp('mode');
    expect(help).toContain('/mode <agent>');
    expect(help).toContain('Shows the current execution mode');
  });

  it('/help mode does not mention setting or changing mode', () => {
    const help = formatCommandHelp('mode');
    // Should not contain legacy mode-setting verbiage
    expect(help).not.toMatch(/set.*mode/i);
    expect(help).not.toMatch(/change.*mode/i);
    expect(help).not.toMatch(/switch.*mode/i);
    expect(help).not.toContain('paper | shadow | live');
  });

  it('/help mode mentions /golive as the way to go live', () => {
    const help = formatCommandHelp('mode');
    expect(help).toContain('/golive');
  });
});

describe('help text — golive', () => {
  it('/help golive returns detailed help', () => {
    const help = formatCommandHelp('golive');
    expect(help).toContain('/golive <agent>');
    expect(help).toContain('live');
  });

  it('/help golive mentions cloning/copying configuration', () => {
    const help = formatCommandHelp('golive');
    expect(help).toMatch(/clone|copy|cloning|copying/i);
  });

  it('/help golive includes usage examples', () => {
    const help = formatCommandHelp('golive');
    expect(help).toContain('/golive Momentum');
  });
});

describe('general help includes golive', () => {
  it('general help includes golive in the Config category', () => {
    const help = formatCommandHelp();
    expect(help).toContain('/golive');
    // golive should appear in the Config section
    const configSection = help.split('Config')[1];
    expect(configSection).toBeDefined();
    expect(configSection).toContain('/golive');
  });

  it('general help shows mode syntax as read-only (no mode arg)', () => {
    const help = formatCommandHelp();
    // The mode line should be "/mode <agent> — Show execution mode" (no mode arg)
    expect(help).toContain('/mode <agent>');
    expect(help).toContain('Show execution mode');
    // Should NOT show "/mode <agent> <mode>" syntax
    expect(help).not.toContain('/mode <agent> <mode>');
  });

  it('general help shows golive description', () => {
    const help = formatCommandHelp();
    expect(help).toContain('Create a live copy');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// setExecutionMode removal
// ─────────────────────────────────────────────────────────────────────────

describe('setExecutionMode removed from agent-config-service', () => {
  it('does not export setExecutionMode', async () => {
    const exports = await vi.importActual<Record<string, unknown>>('../services/agent-config-service.js');
    expect('setExecutionMode' in exports).toBe(false);
  });
});
