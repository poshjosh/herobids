import { describe, it, expect } from 'vitest';
import {
  MessageEnvelopeSchema,
  DecisionSubmitPayloadSchema,
  HeartbeatPayloadSchema,
  PauseRequestPayloadSchema,
  StopRequestPayloadSchema,
  ArtifactPublishPayloadSchema,
  ContextSnapshotPayloadSchema,
  DecisionAcceptedPayloadSchema,
  DecisionRejectedPayloadSchema,
  PlanStatusPayloadSchema,
  ExecutionResultPayloadSchema,
  GuardrailTriggeredPayloadSchema,
  ReconciliationNoticePayloadSchema,
  InstanceStatusPayloadSchema,
  TickStartedPayloadSchema,
  TickSkippedPayloadSchema,
  ScoutHeldPayloadSchema,
  ScoutEscalatedPayloadSchema,
  LlmDispatchPayloadSchema,
  LlmCompletedPayloadSchema,
  RuntimeToolCallPayloadSchema,
  RuntimeToolResultPayloadSchema,
  AGENT_MESSAGE_TYPES,
  AGENT_RUNTIME_ACTIVITY_TYPES,
  INSTANCE_MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
} from '@herobids/domain';

describe('agent-protocol schema validation', () => {
  describe('MessageEnvelopeSchema', () => {
    const validEnvelope = {
      messageId: 'msg-001',
      correlationId: 'corr-001',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      tradingInstanceId: 'ti-456',
      type: 'agent.decision.submit',
      createdAt: '2026-06-01T00:00:00.000Z',
      payload: {},
    };

    it('accepts a valid envelope', () => {
      const result = MessageEnvelopeSchema.safeParse(validEnvelope);
      expect(result.success).toBe(true);
    });

    it('rejects envelope missing messageId', () => {
      const { messageId: _, ...incomplete } = validEnvelope;
      const result = MessageEnvelopeSchema.safeParse(incomplete);
      expect(result.success).toBe(false);
    });

    it('rejects envelope with invalid initiatorType', () => {
      const result = MessageEnvelopeSchema.safeParse({ ...validEnvelope, initiatorType: 'hacker' });
      expect(result.success).toBe(false);
    });

    it('rejects envelope with invalid createdAt format', () => {
      const result = MessageEnvelopeSchema.safeParse({ ...validEnvelope, createdAt: 'not-a-date' });
      expect(result.success).toBe(false);
    });

    it('defaults schemaVersion to v1', () => {
      const result = MessageEnvelopeSchema.parse(validEnvelope);
      expect(result.schemaVersion).toBe('v1');
    });

    it('accepts all valid actor types', () => {
      for (const type of ['agent', 'bot', 'user', 'system']) {
        const result = MessageEnvelopeSchema.safeParse({ ...validEnvelope, initiatorType: type });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('DecisionSubmitPayloadSchema', () => {
    const validPayload = {
      decisionId: 'dec-001',
      instrumentId: 'BTC-USD',
      intent: 'go_long',
      targetSize: '1.5',
      rationaleSummary: 'Momentum breakout above key level',
    };

    it('accepts a valid decision submit payload', () => {
      const result = DecisionSubmitPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('rejects invalid intent values', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, intent: 'buy_all' });
      expect(result.success).toBe(false);
    });

    it('rejects non-decimal targetSize', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, targetSize: 'abc' });
      expect(result.success).toBe(false);
    });

    it('accepts optional limitPrice', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, limitPrice: '50000.50' });
      expect(result.success).toBe(true);
    });

    it('accepts optional confidence between 0 and 1', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, confidence: 0.85 });
      expect(result.success).toBe(true);
    });

    it('rejects confidence above 1', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, confidence: 1.5 });
      expect(result.success).toBe(false);
    });

    it('accepts all valid intent values', () => {
      for (const intent of ['go_long', 'go_short', 'go_flat', 'increase', 'decrease']) {
        const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, intent });
        expect(result.success).toBe(true);
      }
    });

    it('rejects rationaleSummary over max(400) chars', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, rationaleSummary: 'x'.repeat(401) });
      expect(result.success).toBe(false);
    });

    it('accepts rationaleSummary at exactly max(400) chars', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, rationaleSummary: 'x'.repeat(400) });
      expect(result.success).toBe(true);
    });

    it('accepts rationaleSummary at min(1) char boundary', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({ ...validPayload, rationaleSummary: 'x'.repeat(1) });
      expect(result.success).toBe(true);
    });
  });

  describe('HeartbeatPayloadSchema', () => {
    it('accepts a valid heartbeat', () => {
      const result = HeartbeatPayloadSchema.safeParse({
        sessionId: 'sess-001',
        status: 'ready',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid status', () => {
      const result = HeartbeatPayloadSchema.safeParse({
        sessionId: 'sess-001',
        status: 'broken',
      });
      expect(result.success).toBe(false);
    });

    it('accepts all valid statuses', () => {
      for (const status of ['starting', 'ready', 'busy', 'degraded']) {
        const result = HeartbeatPayloadSchema.safeParse({ sessionId: 'sess-001', status });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('PauseRequestPayloadSchema', () => {
    it('accepts a valid pause request', () => {
      const result = PauseRequestPayloadSchema.safeParse({ reason: 'Taking a break' });
      expect(result.success).toBe(true);
    });

    it('rejects empty reason', () => {
      const result = PauseRequestPayloadSchema.safeParse({ reason: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('StopRequestPayloadSchema', () => {
    it('accepts a valid stop request', () => {
      const result = StopRequestPayloadSchema.safeParse({ reason: 'Done for the day' });
      expect(result.success).toBe(true);
    });
  });

  describe('ArtifactPublishPayloadSchema', () => {
    it('accepts a valid artifact', () => {
      const result = ArtifactPublishPayloadSchema.safeParse({
        artifactId: 'art-001',
        artifactType: 'analysis_report',
        contentType: 'application/pdf',
        summary: 'Technical analysis for BTC',
      });
      expect(result.success).toBe(true);
    });

    it('accepts artifact with location', () => {
      const result = ArtifactPublishPayloadSchema.safeParse({
        artifactId: 'art-002',
        artifactType: 'chart',
        contentType: 'image/png',
        summary: 'Momentum chart',
        location: { bucket: 'artifacts', key: 'charts/btc.png' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Instance → Agent message schemas', () => {
    it('validates ContextSnapshotPayload', () => {
      const result = ContextSnapshotPayloadSchema.safeParse({
        snapshotId: 'snap-001',
        symbol: 'BTC-USD',
        price: '60000',
        timestamp: '2026-06-01T00:00:00.000Z',
        position: null,
        referenceMark: { price: '59900', source: 'hyperliquid' },
        strategyParams: {},
        executionMode: 'paper',
        guardrails: {},
      });
      expect(result.success).toBe(true);
    });

    it('validates DecisionAcceptedPayload', () => {
      const result = DecisionAcceptedPayloadSchema.safeParse({
        decisionId: 'dec-001',
        acceptedAt: '2026-06-01T00:00:01.000Z',
        normalizedDecision: { intent: 'go_long', size: '1.5' },
      });
      expect(result.success).toBe(true);
    });

    it('validates DecisionRejectedPayload', () => {
      const result = DecisionRejectedPayloadSchema.safeParse({
        decisionId: 'dec-001',
        code: 'risk.exceeded',
        message: 'Notional exceeds limit',
        retryable: false,
      });
      expect(result.success).toBe(true);
    });

    it('validates PlanStatusPayload', () => {
      const result = PlanStatusPayloadSchema.safeParse({
        decisionId: 'dec-001',
        planId: 'plan-001',
        status: 'executing',
        action: 'open_long',
        venue: 'hyperliquid',
        symbol: 'BTC-USD',
        orderCount: 2,
      });
      expect(result.success).toBe(true);
    });

    it('validates ExecutionResultPayload', () => {
      const result = ExecutionResultPayloadSchema.safeParse({
        decisionId: 'dec-001',
        planId: 'plan-001',
        orders: [{ id: 'ord-1', status: 'filled' }],
        fills: [{ id: 'fill-1', amount: '1.0' }],
        positionAfter: { side: 'long', size: '1.5' },
        executionFailed: false,
        completedAt: '2026-06-01T00:01:00.000Z',
      });
      expect(result.success).toBe(true);
    });

    it('validates GuardrailTriggeredPayload', () => {
      const result = GuardrailTriggeredPayloadSchema.safeParse({
        scope: 'risk_gate',
        code: 'risk.exceeded',
        message: 'Position limit exceeded',
      });
      expect(result.success).toBe(true);
    });

    it('validates ReconciliationNoticePayload', () => {
      const result = ReconciliationNoticePayloadSchema.safeParse({
        severity: 'warn',
        eventType: 'drift_detected',
        summary: 'Position drift of 0.1 BTC detected',
        occurredAt: '2026-06-01T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
    });

    it('validates InstanceStatusPayload', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'running',
        reason: 'normal_start',
        updatedAt: '2026-06-01T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
    });

    it('validates InstanceStatusPayload with managedBots', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'running',
        reason: 'bot_created',
        updatedAt: '2026-06-01T00:00:00.000Z',
        managedBots: [
          { id: 'bot-1', status: 'running', strategyPreset: 'momentum', symbol: 'BTC-USD' },
          { id: 'bot-2', status: 'stopped' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.managedBots).toHaveLength(2);
        expect(result.data.managedBots![0]).toMatchObject({ id: 'bot-1', status: 'running' });
        expect(result.data.managedBots![1]!.strategyPreset).toBeUndefined();
      }
    });

    it('validates InstanceStatusPayload with empty managedBots array', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'running',
        updatedAt: '2026-06-01T00:00:00.000Z',
        managedBots: [],
      });
      expect(result.success).toBe(true);
    });

    it('validates InstanceStatusPayload without managedBots (field is optional)', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'paused',
        updatedAt: '2026-06-01T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.managedBots).toBeUndefined();
      }
    });

    it('rejects InstanceStatusPayload with managedBots missing required id field', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'running',
        updatedAt: '2026-06-01T00:00:00.000Z',
        managedBots: [{ status: 'running' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects InstanceStatusPayload with managedBots missing required status field', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'running',
        updatedAt: '2026-06-01T00:00:00.000Z',
        managedBots: [{ id: 'bot-1' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects InstanceStatusPayload with invalid status value', () => {
      const result = InstanceStatusPayloadSchema.safeParse({
        status: 'on_fire',
        updatedAt: '2026-06-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('MESSAGE_PAYLOAD_SCHEMAS mapping', () => {
    it('maps all agent message types to schemas', () => {
      for (const type of Object.values(AGENT_MESSAGE_TYPES)) {
        expect(MESSAGE_PAYLOAD_SCHEMAS[type]).toBeDefined();
      }
    });

    it('maps all instance message types to schemas', () => {
      for (const type of Object.values(INSTANCE_MESSAGE_TYPES)) {
        expect(MESSAGE_PAYLOAD_SCHEMAS[type]).toBeDefined();
      }
    });

    it('maps all runtime activity types to schemas', () => {
      for (const type of Object.values(AGENT_RUNTIME_ACTIVITY_TYPES)) {
        expect(MESSAGE_PAYLOAD_SCHEMAS[type]).toBeDefined();
      }
    });
  });

  describe('Runtime activity payload schemas', () => {
    it('validates TickStartedPayload', () => {
      const result = TickStartedPayloadSchema.safeParse({
        tickId: 'tick-001',
        trigger: 'scheduled',
        positionSide: 'long',
        hasWakeSignal: false,
      });
      expect(result.success).toBe(true);
    });

    it('requires tickId and hasWakeSignal in TickStartedPayload', () => {
      expect(TickStartedPayloadSchema.safeParse({ trigger: 'scheduled', hasWakeSignal: false }).success).toBe(false);
      expect(TickStartedPayloadSchema.safeParse({ tickId: 'tick-001', trigger: 'scheduled' }).success).toBe(false);
    });

    it('validates TickSkippedPayload', () => {
      const result = TickSkippedPayloadSchema.safeParse({
        tickId: 'tick-002',
        reason: 'context_unchanged',
        gate: 'context',
      });
      expect(result.success).toBe(true);
    });

    it('rejects TickSkippedPayload missing required fields', () => {
      expect(TickSkippedPayloadSchema.safeParse({ reason: 'no_change' }).success).toBe(false);
    });

    it('validates ScoutHeldPayload', () => {
      const result = ScoutHeldPayloadSchema.safeParse({
        tickId: 'tick-003',
        reason: 'no_action_needed',
      });
      expect(result.success).toBe(true);
    });

    it('validates ScoutEscalatedPayload', () => {
      const result = ScoutEscalatedPayloadSchema.safeParse({
        tickId: 'tick-003',
        reason: 'open_position_detected',
        summary: 'Position opened, escalating to judge.',
      });
      expect(result.success).toBe(true);
    });

    it('validates LlmDispatchPayload', () => {
      const result = LlmDispatchPayloadSchema.safeParse({
        tickId: 'tick-004',
        phase: 'scout',
        model: 'claude-3-5-haiku-latest',
        maxTurns: 3,
      });
      expect(result.success).toBe(true);
    });

    it('rejects LlmDispatchPayload with invalid phase', () => {
      const result = LlmDispatchPayloadSchema.safeParse({
        tickId: 'tick-004',
        phase: 'invalid',
        model: 'claude',
        maxTurns: 3,
      });
      expect(result.success).toBe(false);
    });

    it('validates LlmCompletedPayload', () => {
      const result = LlmCompletedPayloadSchema.safeParse({
        tickId: 'tick-004',
        phase: 'judge',
        model: 'claude-sonnet-4-5',
        turnsUsed: 2,
        finishReason: 'stop',
        tokensUsed: 1500,
        thinkingTokens: 300,
      });
      expect(result.success).toBe(true);
    });

    it('validates RuntimeToolCallPayload', () => {
      const result = RuntimeToolCallPayloadSchema.safeParse({
        tickId: 'tick-005',
        phase: 'judge',
        toolName: 'get_market_overview',
        correlationId: 'corr-001',
      });
      expect(result.success).toBe(true);
    });

    it('validates RuntimeToolResultPayload', () => {
      const result = RuntimeToolResultPayloadSchema.safeParse({
        tickId: 'tick-005',
        phase: 'judge',
        toolName: 'get_market_overview',
        status: 'ok',
        correlationId: 'corr-001',
        summary: 'BTC at $60000, momentum bullish.',
      });
      expect(result.success).toBe(true);
    });

    it('rejects RuntimeToolResultPayload with invalid status', () => {
      const result = RuntimeToolResultPayloadSchema.safeParse({
        tickId: 'tick-005',
        phase: 'judge',
        toolName: 'get_market_overview',
        status: 'pending',
        correlationId: 'corr-001',
      });
      expect(result.success).toBe(false);
    });
  });
});
