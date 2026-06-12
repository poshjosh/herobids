import { describe, it, expect } from 'vitest';
import {
  mapProtocolMessage,
  mapRuntimeSession,
  mapOutboundMessage,
  mapArtifact,
  isSuppressedProtocolMessageType,
  type RawAgentMessage,
  type RawRuntimeSession,
  type RawOutboundMessage,
  type RawArtifact,
} from './agent-activity-mapper.js';

describe('isSuppressedProtocolMessageType', () => {
  it('suppresses runtime heartbeat message types', () => {
    expect(isSuppressedProtocolMessageType('agent.heartbeat')).toBe(true);
    expect(isSuppressedProtocolMessageType('agent.runtime.heartbeat')).toBe(true);
    expect(isSuppressedProtocolMessageType('agent.message.send')).toBe(false);
  });
});

describe('mapProtocolMessage', () => {
  const baseMessage: RawAgentMessage = {
    id: 'msg-1',
    messageId: 'mid-1',
    correlationId: 'corr-1',
    actorType: 'agent',
    actorId: 'agent-1',
    agentId: 'agent-1',
    botId: null,
    type: 'instance.decision.rejected',
    direction: 'outbound',
    schemaVersion: 'v1',
    sequence: null,
    traceId: 'trace-1',
    processingStatus: 'processed',
    errorDetail: { code: 'risk.exceeded', message: 'Position exceeds max notional' },
    payload: null,
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
      type: 'instance.tool.result',
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

describe('mapProtocolMessage — runtime activity event families', () => {
  const base: RawAgentMessage = {
    id: 'msg-ra-1',
    messageId: 'mid-ra-1',
    correlationId: 'corr-ra',
    actorType: 'agent',
    actorId: 'agent-1',
    agentId: 'agent-1',
    botId: null,
    type: 'agent.tick.started',
    direction: 'inbound',
    schemaVersion: 'v1',
    sequence: null,
    traceId: null,
    processingStatus: 'processed',
    errorDetail: null,
    payload: null,
    createdAt: new Date('2026-06-11T13:00:00Z'),
  };

  it('classifies tick.started with payload', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.tick.started',
      payload: { tickId: 't-1', trigger: 'scheduled', hasWakeSignal: false },
    });
    expect(entry.category).toBe('tick');
    expect(entry.eventType).toBe('tick.started');
    expect(entry.title).toBe('Tick started');
    expect(entry.summary).toContain('scheduled');
    expect(entry.detail['payload']).toBeDefined();
  });

  it('classifies tick.skipped with reason and gate', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.tick.skipped',
      payload: { tickId: 't-2', reason: 'context_unchanged', gate: 'context' },
    });
    expect(entry.category).toBe('tick');
    expect(entry.eventType).toBe('tick.skipped');
    expect(entry.summary).toContain('context_unchanged');
    expect(entry.summary).toContain('context');
  });

  it('classifies scout.held', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.scout.held',
      payload: { tickId: 't-3', reason: 'no_action_needed' },
    });
    expect(entry.category).toBe('tick');
    expect(entry.eventType).toBe('scout.held');
    expect(entry.summary).toContain('no_action_needed');
  });

  it('classifies scout.escalated', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.scout.escalated',
      payload: { tickId: 't-4', reason: 'open_position_detected' },
    });
    expect(entry.category).toBe('tick');
    expect(entry.eventType).toBe('scout.escalated');
    expect(entry.summary).toContain('open_position_detected');
  });

  it('classifies llm.dispatch with phase and model', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.llm.dispatch',
      payload: { tickId: 't-5', phase: 'scout', model: 'claude-haiku', maxTurns: 3 },
    });
    expect(entry.category).toBe('tick');
    expect(entry.eventType).toBe('llm.dispatch');
    expect(entry.summary).toContain('scout');
    expect(entry.summary).toContain('claude-haiku');
  });

  it('classifies llm.completed with finish reason', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.llm.completed',
      payload: { tickId: 't-5', phase: 'judge', model: 'claude-sonnet', turnsUsed: 2, finishReason: 'stop' },
    });
    expect(entry.category).toBe('tick');
    expect(entry.eventType).toBe('llm.completed');
    expect(entry.summary).toContain('judge');
    expect(entry.summary).toContain('stop');
  });

  it('elevates llm.completed with finishReason=error to warn severity', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.llm.completed',
      payload: { tickId: 't-5', phase: 'judge', model: 'claude-sonnet', turnsUsed: 0, finishReason: 'error' },
    });
    expect(entry.severity).toBe('warn');
  });

  it('elevates llm.completed with finishReason=turn_limit to warn severity', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.llm.completed',
      payload: { tickId: 't-5', phase: 'judge', model: 'claude-sonnet', turnsUsed: 5, finishReason: 'turn_limit' },
    });
    expect(entry.severity).toBe('warn');
  });

  it('keeps scout turn-limit completions at info severity', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.llm.completed',
      payload: { tickId: 't-5', phase: 'scout', model: 'claude-sonnet', turnsUsed: 3, finishReason: 'turn_limit' },
    });
    expect(entry.severity).toBe('info');
  });

  it('classifies tool.call with tool name', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.tool.call',
      payload: { tickId: 't-6', phase: 'judge', toolName: 'list_bots', correlationId: 'c-1' },
    });
    expect(entry.category).toBe('tool');
    expect(entry.eventType).toBe('tool.called');
    expect(entry.summary).toContain('list_bots');
    expect(entry.summary).toContain('judge');
  });

  it('classifies tool.result with ok status', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.tool.result',
      payload: { tickId: 't-6', phase: 'judge', toolName: 'list_bots', status: 'ok', correlationId: 'c-1', summary: 'Found 2 bots.' },
    });
    expect(entry.category).toBe('tool');
    expect(entry.eventType).toBe('tool.result');
    expect(entry.summary).toContain('list_bots');
    expect(entry.summary).toContain('ok');
  });

  it('elevates tool.result with error status to warn severity', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.tool.result',
      payload: { tickId: 't-6', phase: 'judge', toolName: 'list_bots', status: 'error', correlationId: 'c-1', summary: 'tool rejected: list_bots' },
    });
    expect(entry.severity).toBe('warn');
  });

  it('renders gracefully when payload is null (legacy row)', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'agent.tick.started',
      payload: null,
    });
    expect(entry.category).toBe('tick');
    expect(entry.summary).toBe('Agent tick started.');
  });

  it('uses canonical instance.decision.accepted type', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'instance.decision.accepted',
      payload: null,
    });
    expect(entry.category).toBe('decision');
    expect(entry.eventType).toBe('decision.accepted');
    expect(entry.title).toBe('Decision accepted');
  });

  it('uses canonical instance.tool.result type', () => {
    const entry = mapProtocolMessage({
      ...base,
      type: 'instance.tool.result',
      processingStatus: 'failed',
      payload: null,
    });
    expect(entry.category).toBe('tool');
    expect(entry.eventType).toBe('system.alert');
    expect(entry.severity).toBe('warn');
  });
});
