import { describe, it, expect, vi } from 'vitest';
import { analyzeCore } from './core.js';
import type { EvidenceManifest } from '../collectors/evidence-assembler.js';
import type { EvaluationArtifactStore, EvaluationThresholds } from '@herobids/domain';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockStore(artifacts: Record<string, string>): EvaluationArtifactStore {
  return {
    write: vi.fn(),
    read: vi.fn(async (_runId: string, name: string) => {
      const content = artifacts[name];
      if (content === undefined) return null;
      return new TextEncoder().encode(content);
    }),
    list: vi.fn(),
  };
}

function defaultThresholds(): EvaluationThresholds {
  return {
    toolFailureRatePct: 20,
    highDrawdownPct: 20,
    negativeExpectancyFlag: true,
    veryShortHoldSec: 30,
    rateLimitAnomalyCount: 5,
    veryShortSessionSec: 60,
  };
}

function defaultManifest(overrides?: Partial<EvidenceManifest>): EvidenceManifest {
  return {
    entries: [
      { artifactName: 'fills.json', collected: true, itemCount: 10 },
      { artifactName: 'journal.json', collected: true, itemCount: 50 },
      { artifactName: 'sessions.json', collected: true, itemCount: 1 },
      { artifactName: 'positions.json', collected: true, itemCount: 3 },
      { artifactName: 'agent-metadata.json', collected: true },
      { artifactName: 'costs.json', collected: false, error: 'not yet implemented' },
    ],
    scope: { type: 'session', sessionId: 'sess-1' },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('analyzeCore', () => {
  it('flags critical when no sessions exist', async () => {
    const store = mockStore({ 'sessions.json': '[]' });
    const result = await analyzeCore(store, 'run-1', defaultManifest({ entries: [] }), defaultThresholds());

    const sessionSection = result.find((s) => s.section === 'session_health');
    expect(sessionSection).toBeDefined();
    const noSessions = sessionSection!.findings.find((f) => f.code === 'core.no_sessions');
    expect(noSessions).toBeDefined();
    expect(noSessions!.severity).toBe('critical');
  });

  it('flags high when a session crashed', async () => {
    const store = mockStore({
      'sessions.json': JSON.stringify([
        { id: 'sess-1', agentId: 'agent-1', status: 'crashed', startedAt: '2026-01-15T10:00:00Z', stoppedAt: '2026-01-15T11:00:00Z' },
      ]),
    });

    const result = await analyzeCore(store, 'run-2', defaultManifest(), defaultThresholds());
    const sessionSection = result.find((s) => s.section === 'session_health');
    const crashed = sessionSection!.findings.find((f) => f.code === 'core.session_crashed');
    expect(crashed).toBeDefined();
    expect(crashed!.severity).toBe('high');
    expect(crashed!.title).toBe('Session crashed');
  });

  it('flags info for very short sessions', async () => {
    const store = mockStore({
      'sessions.json': JSON.stringify([
        { id: 'sess-2', agentId: 'agent-1', status: 'stopped', startedAt: '2026-01-15T10:00:00Z', stoppedAt: '2026-01-15T10:00:30Z' },
      ]),
    });

    const result = await analyzeCore(store, 'run-3', defaultManifest(), defaultThresholds());
    const sessionSection = result.find((s) => s.section === 'session_health');
    const short = sessionSection!.findings.find((f) => f.code === 'core.very_short_session');
    expect(short).toBeDefined();
    expect(short!.severity).toBe('info');
  });

  it('does not flag sessions above the short-session threshold', async () => {
    const store = mockStore({
      'sessions.json': JSON.stringify([
        { id: 'sess-3', agentId: 'agent-1', status: 'stopped', startedAt: '2026-01-15T10:00:00Z', stoppedAt: '2026-01-15T10:05:00Z' },
      ]),
    });

    const result = await analyzeCore(store, 'run-4', defaultManifest(), defaultThresholds());
    const sessionSection = result.find((s) => s.section === 'session_health');
    const short = sessionSection!.findings.find((f) => f.code === 'core.very_short_session');
    expect(short).toBeUndefined();
  });

  it('flags medium for high tool failure rate', async () => {
    // 50 total events, 15 tool failures = 30% > 20% threshold
    const journalEntries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 15; i++) {
      journalEntries.push({ id: `fail-${i}`, type: 'tool.http_request', actorType: 'agent', actorId: 'agent-1', payload: { error: 'timeout' }, createdAt: new Date().toISOString() });
    }
    for (let i = 0; i < 35; i++) {
      journalEntries.push({ id: `ok-${i}`, type: 'agent.tick', actorType: 'agent', actorId: 'agent-1', payload: {}, createdAt: new Date().toISOString() });
    }

    const store = mockStore({
      'journal.json': JSON.stringify(journalEntries),
    });

    const result = await analyzeCore(store, 'run-5', defaultManifest(), defaultThresholds());
    const toolSection = result.find((s) => s.section === 'tool_usage');
    const highFail = toolSection!.findings.find((f) => f.code === 'core.high_tool_failure_rate');
    expect(highFail).toBeDefined();
    expect(highFail!.severity).toBe('medium');
  });

  it('does not flag tool failure rate below threshold', async () => {
    // 50 total events, 5 tool failures = 10% < 20% threshold
    const journalEntries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 5; i++) {
      journalEntries.push({ id: `fail-${i}`, type: 'tool.http_request', actorType: 'agent', actorId: 'agent-1', payload: { error: 'timeout' }, createdAt: new Date().toISOString() });
    }
    for (let i = 0; i < 45; i++) {
      journalEntries.push({ id: `ok-${i}`, type: 'agent.tick', actorType: 'agent', actorId: 'agent-1', payload: {}, createdAt: new Date().toISOString() });
    }

    const store = mockStore({
      'journal.json': JSON.stringify(journalEntries),
    });

    const result = await analyzeCore(store, 'run-6', defaultManifest(), defaultThresholds());
    const toolSection = result.find((s) => s.section === 'tool_usage');
    const highFail = toolSection!.findings.find((f) => f.code === 'core.high_tool_failure_rate');
    expect(highFail).toBeUndefined();
  });

  it('flags low for no cost data', async () => {
    const store = mockStore({});
    const manifest = defaultManifest();
    manifest.entries.push({ artifactName: 'costs.json', collected: false, error: 'not available' });

    const result = await analyzeCore(store, 'run-7', manifest, defaultThresholds());
    const costSection = result.find((s) => s.section === 'cost');
    const noCost = costSection!.findings.find((f) => f.code === 'core.no_cost_data');
    expect(noCost).toBeDefined();
    expect(noCost!.severity).toBe('low');
  });

  it('flags medium for no journal entries', async () => {
    const store = mockStore({});
    const result = await analyzeCore(store, 'run-8', defaultManifest(), defaultThresholds());
    const persistSection = result.find((s) => s.section === 'persistence');
    const noJournal = persistSection!.findings.find((f) => f.code === 'core.no_journal_entries');
    expect(noJournal).toBeDefined();
    expect(noJournal!.severity).toBe('medium');
  });

  it('returns clean result for a healthy agent', async () => {
    const store = mockStore({
      'sessions.json': JSON.stringify([
        { id: 'sess-4', agentId: 'agent-1', status: 'stopped', startedAt: '2026-01-15T10:00:00Z', stoppedAt: '2026-01-15T12:00:00Z' },
      ]),
      'journal.json': JSON.stringify([
        { id: 'ev-1', type: 'agent.tick', actorType: 'agent', actorId: 'agent-1', payload: {}, createdAt: '2026-01-15T10:30:00Z' },
        { id: 'ev-2', type: 'agent.tick', actorType: 'agent', actorId: 'agent-1', payload: {}, createdAt: '2026-01-15T10:31:00Z' },
      ]),
    });

    // Build a manifest where costs.json is collected (no cost warning)
    const manifest = defaultManifest({
      entries: [
        { artifactName: 'fills.json', collected: true, itemCount: 10 },
        { artifactName: 'journal.json', collected: true, itemCount: 2 },
        { artifactName: 'sessions.json', collected: true, itemCount: 1 },
        { artifactName: 'positions.json', collected: true, itemCount: 0 },
        { artifactName: 'agent-metadata.json', collected: true },
        { artifactName: 'costs.json', collected: true },
      ],
    });

    const result = await analyzeCore(store, 'run-9', manifest, defaultThresholds());
    const allFindings = result.flatMap((s) => s.findings);
    expect(allFindings).toHaveLength(0);

    const sessionSection = result.find((s) => s.section === 'session_health');
    expect(sessionSection!.score).toBe(100);
  });

  it('produces expected section count', async () => {
    const store = mockStore({});
    const result = await analyzeCore(store, 'run-10', defaultManifest(), defaultThresholds());
    const sectionNames = result.map((s) => s.section);
    expect(sectionNames).toContain('session_health');
    expect(sectionNames).toContain('tool_usage');
    expect(sectionNames).toContain('cost');
    expect(sectionNames).toContain('persistence');
  });
});
