import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tradingTools } from './trading.js';
import type { ToolContext } from '@herobids/domain';

const submitDecision = tradingTools.find((t) => t.name === 'submit_decision')!;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const redis = {
    hset: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue(null),
    hdel: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    blpop: vi.fn().mockResolvedValue(null), // default: timeout
    ...overrides.redis,
  };

  return {
    agentId: 'agent-test',
    sessionId: 'session-test',
    phase: 'scout',
    executionMode: 'paper',
    redis,
    publishToInbound: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const validParams = {
  instrumentId: 'BTC',
  intent: 'go_long' as const,
  targetSize: '1.5',
  rationaleSummary: 'Testing sync reply',
};

describe('submit_decision — synchronous reply', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  // -------------------------------------------------------------------------
  // publishToInbound
  // -------------------------------------------------------------------------

  it('publishes the decision with _expectsReply: true to the inbound stream', async () => {
    await submitDecision.execute(validParams, ctx);

    expect(ctx.publishToInbound).toHaveBeenCalledTimes(1);
    const [type, payload] = (ctx.publishToInbound as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(type).toBe('agent.decision.submit');
    expect(payload._expectsReply).toBe(true);
    expect(payload.decisionId).toEqual(expect.any(String));
    expect(payload.instrumentId).toBe('BTC');
    expect(payload.intent).toBe('go_long');
    expect(payload.targetSize).toBe('1.5');
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  it('returns timeout error when blpop returns null (no reply within 30s)', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('decision_reply_timeout');
    expect(result.error).toContain('timed out');
  });

  // -------------------------------------------------------------------------
  // Malformed reply
  // -------------------------------------------------------------------------

  it('returns malformed error when the reply value is not valid JSON', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue(['replyKey', 'not-json{{{']);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('decision_reply_malformed');
  });

  it('returns malformed error for empty string reply', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue(['replyKey', '']);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('decision_reply_malformed');
  });

  // -------------------------------------------------------------------------
  // Accepted reply
  // -------------------------------------------------------------------------

  it('returns success with decisionId and planId on accepted reply', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'accepted', planId: 'plan-42' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      planId: 'plan-42',
      note: expect.stringContaining('accepted'),
    });
    expect(result.data.decisionId).toEqual(expect.any(String));
  });

  it('returns success even when planId is absent in accepted reply', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'accepted' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(true);
    expect(result.data.ok).toBe(true);
    expect(result.data.planId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rejected reply
  // -------------------------------------------------------------------------

  it('returns rejection with the engine-supplied code and message', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'rejected', code: 'risk.exceeded', message: 'Daily loss limit reached' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('risk.exceeded');
    expect(result.error).toBe('Daily loss limit reached');
    expect(result.data).toEqual({ decisionId: expect.any(String) });
  });

  it('falls back to default rejection code and message when absent', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'rejected' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('risk.rejected');
    expect(result.error).toBe('Decision rejected by risk gate.');
  });

  // -------------------------------------------------------------------------
  // Error reply
  // -------------------------------------------------------------------------

  it('returns error with the engine-supplied code and message on error status', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'error', code: 'venue.timeout', message: 'Venue did not respond' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('venue.timeout');
    expect(result.error).toBe('Venue did not respond');
  });

  it('falls back to default error code/message on error status with missing fields', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'error' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('decision_processing_error');
    expect(result.error).toBe('Decision could not be processed.');
  });

  // -------------------------------------------------------------------------
  // Unknown status fallback
  // -------------------------------------------------------------------------

  it('treats an unrecognised reply status as a processing error', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'unknown_status', message: 'Something weird' }),
    ]);

    const result = await submitDecision.execute(validParams, ctx);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('decision_processing_error');
  });

  // -------------------------------------------------------------------------
  // sessionMetrics
  // -------------------------------------------------------------------------

  it('increments decisionsSubmitted on sessionMetrics when present', async () => {
    const metrics = { decisionsSubmitted: 0 };
    const ctxWithMetrics = makeCtx({ sessionMetrics: metrics } as Partial<ToolContext>);

    await submitDecision.execute(validParams, ctxWithMetrics);

    expect(metrics.decisionsSubmitted).toBe(1);
  });

  // -------------------------------------------------------------------------
  // stopLoss / takeProfit
  // -------------------------------------------------------------------------

  it('passes stopLoss and takeProfit through to publishToInbound', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'accepted', planId: 'plan-42' }),
    ]);

    await submitDecision.execute(
      { ...validParams, stopLoss: '62000', takeProfit: '68000' },
      ctx,
    );

    expect(ctx.publishToInbound).toHaveBeenCalledTimes(1);
    const [_type, payload] = (ctx.publishToInbound as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.stopLoss).toBe('62000');
    expect(payload.takeProfit).toBe('68000');
  });

  it('passes only stopLoss through to publishToInbound when takeProfit is omitted', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'accepted' }),
    ]);

    await submitDecision.execute(
      { ...validParams, stopLoss: '62000' },
      ctx,
    );

    const [_type, payload] = (ctx.publishToInbound as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.stopLoss).toBe('62000');
    expect(payload.takeProfit).toBeUndefined();
  });

  it('passes only takeProfit through to publishToInbound when stopLoss is omitted', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'accepted' }),
    ]);

    await submitDecision.execute(
      { ...validParams, takeProfit: '68000' },
      ctx,
    );

    const [_type, payload] = (ctx.publishToInbound as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.stopLoss).toBeUndefined();
    expect(payload.takeProfit).toBe('68000');
  });

  it('omits stopLoss and takeProfit from publishToInbound when neither is provided', async () => {
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValue([
      'replyKey',
      JSON.stringify({ status: 'accepted' }),
    ]);

    await submitDecision.execute(validParams, ctx);

    const [_type, payload] = (ctx.publishToInbound as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.stopLoss).toBeUndefined();
    expect(payload.takeProfit).toBeUndefined();
  });

  it('dry-run preview includes stopLoss and takeProfit when provided', async () => {
    const result = await submitDecision.execute(
      { ...validParams, dryRun: true, stopLoss: '62000', takeProfit: '68000' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data.preview.stopLoss).toBe('62000');
    expect(result.data.preview.takeProfit).toBe('68000');
  });

  it('dry-run preview shows "not set" for stopLoss and takeProfit when omitted', async () => {
    const result = await submitDecision.execute(
      { ...validParams, dryRun: true },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data.preview.stopLoss).toBe('not set');
    expect(result.data.preview.takeProfit).toBe('not set');
  });
});
