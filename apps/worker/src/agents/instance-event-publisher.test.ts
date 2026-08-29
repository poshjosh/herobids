import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstanceEventPublisher } from './instance-event-publisher.js';

function makeRedisMock() {
  return {
    lpush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    xadd: vi.fn().mockResolvedValue('1-0'),
  } as any;
}

describe('InstanceEventPublisher — publishDecisionReply', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: InstanceEventPublisher;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = new InstanceEventPublisher(redis);
  });

  // -------------------------------------------------------------------------
  // Correct key and value
  // -------------------------------------------------------------------------

  it('pushes the serialised reply to the correct Redis list key', async () => {
    await publisher.publishDecisionReply('dec-abc', {
      status: 'accepted',
      planId: 'plan-1',
    });

    expect(redis.lpush).toHaveBeenCalledTimes(1);
    const [key, value] = redis.lpush.mock.calls[0] as [string, string];
    expect(key).toBe('agent:decision:reply:dec-abc');

    const parsed = JSON.parse(value);
    expect(parsed).toEqual({ status: 'accepted', planId: 'plan-1' });
  });

  it('sets a 60-second expiry on the reply key', async () => {
    await publisher.publishDecisionReply('dec-xyz', { status: 'rejected', code: 'risk.exceeded' });

    expect(redis.expire).toHaveBeenCalledWith('agent:decision:reply:dec-xyz', 60);
  });

  // -------------------------------------------------------------------------
  // All status types
  // -------------------------------------------------------------------------

  it('serialises a rejected reply correctly', async () => {
    await publisher.publishDecisionReply('dec-r1', {
      status: 'rejected',
      code: 'agent_paused',
      message: 'Agent is paused',
    });

    const [, raw] = redis.lpush.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      status: 'rejected',
      code: 'agent_paused',
      message: 'Agent is paused',
    });
  });

  it('serialises an error reply correctly', async () => {
    await publisher.publishDecisionReply('dec-e1', {
      status: 'error',
      code: 'execution_error',
      message: 'Something broke',
    });

    const [, raw] = redis.lpush.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      status: 'error',
      code: 'execution_error',
      message: 'Something broke',
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  it('propagates Redis lpush errors to the caller', async () => {
    redis.lpush.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      publisher.publishDecisionReply('dec-fail', { status: 'accepted' }),
    ).rejects.toThrow('connection lost');
  });

  it('propagates Redis expire errors to the caller', async () => {
    // lpush succeeds, expire fails
    redis.lpush.mockResolvedValueOnce(1);
    redis.expire.mockRejectedValueOnce(new Error('read-only'));

    await expect(
      publisher.publishDecisionReply('dec-fail2', { status: 'accepted' }),
    ).rejects.toThrow('read-only');
  });
});


// ── publishSkillsReply ───────────────────────────────────────────────────────

describe('InstanceEventPublisher — publishSkillsReply', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: InstanceEventPublisher;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = new InstanceEventPublisher(redis);
  });

  // -------------------------------------------------------------------------
  // Correct key and value
  // -------------------------------------------------------------------------

  it('pushes the serialised result to the correct Redis list key', async () => {
    const result = {
      status: 'ok' as const,
      action: 'add' as const,
      skillIds: ['trading', 'web-access'],
    };

    await publisher.publishSkillsReply('req-abc', result);

    expect(redis.lpush).toHaveBeenCalledTimes(1);
    const [key, value] = redis.lpush.mock.calls[0] as [string, string];
    expect(key).toBe('agent:skills:reply:req-abc');

    const parsed = JSON.parse(value);
    expect(parsed).toEqual({
      status: 'ok',
      action: 'add',
      skillIds: ['trading', 'web-access'],
    });
  });

  it('sets a 60-second expiry on the reply key', async () => {
    await publisher.publishSkillsReply('req-xyz', {
      status: 'ok' as const,
      action: 'remove' as const,
      skillIds: ['web-access'],
    });

    expect(redis.expire).toHaveBeenCalledWith('agent:skills:reply:req-xyz', 60);
  });

  // -------------------------------------------------------------------------
  // Serialises different result shapes
  // -------------------------------------------------------------------------

  it('serialises an error result correctly', async () => {
    await publisher.publishSkillsReply('req-err', {
      status: 'error' as const,
      action: 'add' as const,
      skillIds: [],
      error: 'Skill not found',
      errorCode: 'skill_not_found',
    });

    const [, raw] = redis.lpush.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      status: 'error',
      action: 'add',
      skillIds: [],
      error: 'Skill not found',
      errorCode: 'skill_not_found',
    });
  });

  it('serialises a result with warnings', async () => {
    await publisher.publishSkillsReply('req-warn', {
      status: 'ok' as const,
      action: 'add' as const,
      skillIds: ['trading'],
      warnings: ['skill already present'],
    });

    const [, raw] = redis.lpush.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw);
    expect(parsed.warnings).toEqual(['skill already present']);
  });

  it('omits warnings from serialized output when not provided', async () => {
    await publisher.publishSkillsReply('req-nowarn', {
      status: 'ok' as const,
      action: 'add' as const,
      skillIds: ['trading'],
    });

    const [, raw] = redis.lpush.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw);
    // publishSkillsReply serialises the result as-is without Zod parsing,
    // so warnings is absent (not defaulted to []) when not provided by caller
    expect(parsed).not.toHaveProperty('warnings');
  });

  // -------------------------------------------------------------------------
  // Difference from publishPresetToolReply: no { result } wrapper
  // -------------------------------------------------------------------------

  it('pushes the result directly (not wrapped in a { result } object)', async () => {
    await publisher.publishSkillsReply('req-direct', {
      status: 'ok' as const,
      action: 'add' as const,
      skillIds: ['trading'],
    });

    const [, raw] = redis.lpush.mock.calls[0] as [string, string];
    const parsed = JSON.parse(raw);
    // publishPresetToolReply wraps in { result }, publishSkillsReply does not
    expect(parsed).not.toHaveProperty('result');
    expect(parsed.status).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  it('propagates Redis lpush errors to the caller', async () => {
    redis.lpush.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      publisher.publishSkillsReply('req-fail', {
        status: 'ok' as const,
        action: 'add' as const,
        skillIds: [],
      }),
    ).rejects.toThrow('connection lost');
  });

  it('propagates Redis expire errors to the caller', async () => {
    redis.lpush.mockResolvedValueOnce(1);
    redis.expire.mockRejectedValueOnce(new Error('read-only'));

    await expect(
      publisher.publishSkillsReply('req-fail2', {
        status: 'ok' as const,
        action: 'add' as const,
        skillIds: [],
      }),
    ).rejects.toThrow('read-only');
  });
});
