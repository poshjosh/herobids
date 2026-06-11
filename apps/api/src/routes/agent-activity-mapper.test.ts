import { describe, it, expect } from 'vitest';
import {
  mapProtocolMessage,
  mapRuntimeSession,
  mapOutboundMessage,
  mapArtifact,
  type RawAgentMessage,
  type RawRuntimeSession,
  type RawOutboundMessage,
  type RawArtifact,
} from './agent-activity-mapper.js';

describe('mapProtocolMessage', () => {
  const baseMessage: RawAgentMessage = {
    id: 'msg-1',
    messageId: 'mid-1',
    correlationId: 'corr-1',
    actorType: 'agent',
    actorId: 'agent-1',
    agentId: 'agent-1',
    botId: null,
    type: 'platform.decision.rejected',
    direction: 'outbound',
    schemaVersion: 'v1',
    sequence: null,
    traceId: 'trace-1',
    processingStatus: 'processed',
    errorDetail: { code: 'risk.exceeded', message: 'Position exceeds max notional' },
    createdAt: new Date('2026-06-11T12:00:00Z'),
  };

  it('maps a decision rejection with error details', () => {
    const entry = mapProtocolMessage(baseMessage);
    expect(entry.category).toBe('decision');
    expect(entry.severity).toBe('warn');
    expect(entry.eventType).toBe('decision.rejected');
    expect(entry.title).toBe('Decision rejected');
    expect(entry.summary).toBe('Position exceeds max notional');
    expect(entry.detail).toMatchObject({
      errorCode: 'risk.exceeded',
      errorMessage: 'Position exceeds max notional',
    });
    expect(entry.correlationId).toBe('corr-1');
    expect(entry.traceId).toBe('trace-1');
  });

  it('maps a tool result failure as a generic alert', () => {
    const toolFail: RawAgentMessage = {
      ...baseMessage,
      id: 'msg-2',
      type: 'platform.tool_result',
      processingStatus: 'failed',
      errorDetail: { code: 'tool.timeout', message: 'Tool timed out' },
    };
    const entry = mapProtocolMessage(toolFail);
    expect(entry.category).toBe('tool');
    expect(entry.eventType).toBe('system.alert');
    expect(entry.severity).toBe('warn');
  });

  it('falls back for unknown message types', () => {
    const unknown: RawAgentMessage = {
      ...baseMessage,
      id: 'msg-3',
      type: 'some.unknown.type',
      processingStatus: 'received',
      errorDetail: null,
    };
    const entry = mapProtocolMessage(unknown);
    expect(entry.category).toBe('system');
    expect(entry.title).toBe('some unknown type');
    expect(entry.summary).toContain('some.unknown.type');
  });
});

describe('mapRuntimeSession', () => {
  it('creates start entry for any session', () => {
    const session: RawRuntimeSession = {
      id: 'sess-1',
      agentId: 'agent-1',
      status: 'running',
      lastHeartbeatAt: new Date('2026-06-11T12:01:00Z'),
      cpuPct: 5,
      memoryBytes: 1024,
      startedAt: new Date('2026-06-11T12:00:00Z'),
      stoppedAt: null,
    };
    const entries = mapRuntimeSession(session);
    expect(entries.length).toBe(1);
    expect(entries[0]!.eventType).toBe('runtime.started');
    expect(entries[0]!.title).toBe('Session started');
  });

  it('adds unhealthy entry for unhealthy session', () => {
    const session: RawRuntimeSession = {
      id: 'sess-2',
      agentId: 'agent-1',
      status: 'unhealthy',
      lastHeartbeatAt: new Date('2026-06-11T12:05:00Z'),
      cpuPct: null,
      memoryBytes: null,
      startedAt: new Date('2026-06-11T12:00:00Z'),
      stoppedAt: null,
    };
    const entries = mapRuntimeSession(session);
    expect(entries.length).toBe(2);
    expect(entries[1]!.eventType).toBe('runtime.unhealthy');
    expect(entries[1]!.severity).toBe('warn');
  });

  it('adds crashed entry for crashed session', () => {
    const session: RawRuntimeSession = {
      id: 'sess-3',
      agentId: 'agent-1',
      status: 'crashed',
      lastHeartbeatAt: new Date('2026-06-11T12:05:00Z'),
      cpuPct: null,
      memoryBytes: null,
      startedAt: new Date('2026-06-11T12:00:00Z'),
      stoppedAt: new Date('2026-06-11T12:06:00Z'),
    };
    const entries = mapRuntimeSession(session);
    expect(entries.length).toBe(2);
    expect(entries[1]!.eventType).toBe('runtime.failed');
    expect(entries[1]!.severity).toBe('critical');
    expect(entries[1]!.title).toBe('Runtime crashed');
  });

  it('adds stopped entry for stopped session with stoppedAt', () => {
    const session: RawRuntimeSession = {
      id: 'sess-4',
      agentId: 'agent-1',
      status: 'stopped',
      lastHeartbeatAt: new Date('2026-06-11T12:05:00Z'),
      cpuPct: null,
      memoryBytes: null,
      startedAt: new Date('2026-06-11T12:00:00Z'),
      stoppedAt: new Date('2026-06-11T12:10:00Z'),
    };
    const entries = mapRuntimeSession(session);
    expect(entries.length).toBe(2);
    expect(entries[1]!.title).toBe('Session stopped');
  });
});

describe('mapOutboundMessage', () => {
  it('maps an agent-authored message correctly', () => {
    const msg: RawOutboundMessage = {
      id: 'om-1',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      authoredBy: 'agent',
      subject: 'Market Update',
      body: 'ETH is up 5% in the last hour.',
      contextRef: null,
      messageClass: 'routine',
      deliveryStatus: 'sent',
      createdAt: new Date('2026-06-11T12:00:00Z'),
    };
    const entry = mapOutboundMessage(msg);
    expect(entry.category).toBe('message');
    expect(entry.title).toBe('Agent message');
    expect(entry.summary).toBe('Market Update');
    expect(entry.sessionId).toBe('sess-1');
  });

  it('maps a platform-authored message', () => {
    const msg: RawOutboundMessage = {
      id: 'om-2',
      agentId: 'agent-1',
      sessionId: null,
      authoredBy: 'platform',
      subject: null,
      body: 'Your agent was stopped due to excessive losses.',
      contextRef: null,
      messageClass: 'alert',
      deliveryStatus: 'sent',
      createdAt: new Date('2026-06-11T12:00:00Z'),
    };
    const entry = mapOutboundMessage(msg);
    expect(entry.title).toBe('Platform message');
    expect(entry.summary).toBe('Your agent was stopped due to excessive losses.');
  });
});

describe('mapArtifact', () => {
  it('maps an artifact with summary', () => {
    const artifact: RawArtifact = {
      id: 'art-1',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      artifactType: 'tool_trace',
      contentType: 'application/json',
      summary: 'Tool execution trace for list_bots',
      createdAt: new Date('2026-06-11T12:00:00Z'),
    };
    const entry = mapArtifact(artifact);
    expect(entry.category).toBe('artifact');
    expect(entry.eventType).toBe('artifact.published');
    expect(entry.summary).toBe('Tool execution trace for list_bots');
    expect(entry.sessionId).toBe('sess-1');
  });

  it('falls back to type and content when no summary', () => {
    const artifact: RawArtifact = {
      id: 'art-2',
      agentId: 'agent-1',
      sessionId: null,
      artifactType: 'code_exec_summary',
      contentType: 'text/plain',
      summary: null,
      createdAt: new Date('2026-06-11T12:00:00Z'),
    };
    const entry = mapArtifact(artifact);
    expect(entry.summary).toBe('Published code_exec_summary (text/plain)');
  });
});
