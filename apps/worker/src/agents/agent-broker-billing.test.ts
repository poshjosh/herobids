/**
 * Unit tests for AgentMessageBroker billing notification dispatch
 * (TICK_SKIPPED with billing reasons → Telegram + email).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMessageBroker } from './agent-message-broker.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { TelegramClient } from '../alerting/telegram-client.js';
import type { EmailClient } from '../alerting/email-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ENVELOPE = {
  schemaVersion: 'v1',
  correlationId: 'corr-001',
  initiatorType: 'agent',
  initiatorId: 'agent-123',
  agentId: 'agent-123',
  type: 'agent.tick.skipped',
  createdAt: '2026-06-01T00:00:00.000Z',
};

function makeTickSkippedEnvelope(payloadOverrides: Record<string, unknown> = {}) {
  return {
    ...BASE_ENVELOPE,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    payload: {
      tickId: 'tick-001',
      reason: 'billing.soft_limit_reached',
      ...payloadOverrides,
    },
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-123',
    name: 'Test Agent',
    status: 'active',
    skillIds: [],
    toolPolicy: null,
    notificationPolicy: null,
    ...overrides,
  };
}

function makeAgentRepo(agentOverrides: Record<string, unknown> = {}) {
  const agent = makeAgent(agentOverrides);
  return {
    isMessageDuplicate: vi.fn().mockResolvedValue(false),
    isActiveSession: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(agent),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001', status: 'running' }),
    getEffectiveTelegramChatId: vi.fn().mockResolvedValue(null),
    getUserEmailByAgentId: vi.fn().mockResolvedValue(null),
    getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue({ grantedConnectionsByFamily: {}, defaultConnectionByFamily: {} }),
  };
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

function makeTelegramClient(): { client: TelegramClient; sendTextSpy: ReturnType<typeof vi.fn> } {
  const sendTextSpy = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 42 } });
  return {
    client: { sendText: sendTextSpy, sendAlert: vi.fn(), setWebhook: vi.fn() } as unknown as TelegramClient,
    sendTextSpy,
  };
}

function makeEmailClient(): { client: EmailClient; sendSpy: ReturnType<typeof vi.fn> } {
  const sendSpy = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 'email-123' } });
  return { client: { send: sendSpy }, sendSpy };
}

function makeBroker(
  agentRepo: ReturnType<typeof makeAgentRepo>,
  redis: ReturnType<typeof makeRedis>,
  telegram?: TelegramClient,
  emailClient?: EmailClient,
) {
  return new AgentMessageBroker(
    redis as any,
    agentRepo as any,
    { handleDecisionSubmit: vi.fn() } as unknown as AgentDecisionHandler,
    {
      handleHeartbeat: vi.fn(),
      handlePauseRequest: vi.fn(),
      handleStopRequest: vi.fn(),
      handleRuntimeSessionEnd: vi.fn(),
    } as unknown as AgentSessionManager,
    {} as unknown as InstanceEventPublisher,
    telegram,
    undefined, // botRepo
    undefined, // botStart
    undefined, // botLimitCheck
    undefined, // botLiveCheck
    undefined, // botStop
    undefined, // botRestart
    emailClient,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentMessageBroker billing notifications', () => {
  describe('Soft cap (billing.soft_limit_reached)', () => {
    it('emits Telegram notification with warning message', async () => {
      const agentRepo = makeAgentRepo({ name: 'MomentumBot' });
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.soft_limit_reached',
      }));

      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      const message: string = sendTextSpy.mock.calls[0]![1];
      expect(message).toContain('soft spending cap');
      expect(message).toContain('MomentumBot');
      expect(message).not.toContain('stopped');
    });

    it('does NOT call telegram when no chat ID is available', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue(null);
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.soft_limit_reached',
      }));

      expect(sendTextSpy).not.toHaveBeenCalled();
    });

    it('does NOT call telegram when telegram client is not configured', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      const broker = makeBroker(agentRepo, redis, undefined);

      // Should not throw — telegram is optional
      await expect(
        broker.processInbound(makeTickSkippedEnvelope({
          reason: 'billing.soft_limit_reached',
        })),
      ).resolves.toBeDefined();
    });
  });

  describe('Hard cap (billing.limit_exceeded)', () => {
    it('emits Telegram notification with hard-stop message', async () => {
      const agentRepo = makeAgentRepo({ name: 'MomentumBot' });
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));

      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      const message: string = sendTextSpy.mock.calls[0]![1];
      expect(message).toContain('hard spending cap');
      expect(message).toContain('stopped');
      expect(message).toContain('MomentumBot');
    });

    it('includes open positions in the hard-stop message', async () => {
      const agentRepo = makeAgentRepo({ name: 'MomentumBot' });
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
        openPositions: ['BTC-USD long', 'ETH-USD short'],
      }));

      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      const message: string = sendTextSpy.mock.calls[0]![1];
      expect(message).toContain('BTC-USD long');
      expect(message).toContain('ETH-USD short');
      expect(message).toContain('no longer monitored');
    });

    it('emits email notification with open positions', async () => {
      const agentRepo = makeAgentRepo({ name: 'MomentumBot' });
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');
      const redis = makeRedis();
      const { client: emailClient, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, redis, undefined, emailClient);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
        openPositions: ['BTC-USD long'],
      }));

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const emailMsg = sendSpy.mock.calls[0]![0];
      expect(emailMsg.to).toBe('user@example.com');
      expect(emailMsg.subject).toContain('stopped');
      expect(emailMsg.text).toContain('BTC-USD long');
      expect(emailMsg.text).toContain('no longer monitored');
    });

    it('does not email when no email client is configured', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');
      const redis = makeRedis();
      const broker = makeBroker(agentRepo, redis, undefined, undefined);

      await expect(
        broker.processInbound(makeTickSkippedEnvelope({
          reason: 'billing.limit_exceeded',
        })),
      ).resolves.toBeDefined();
    });

    it('does not email when user has no verified email', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getUserEmailByAgentId.mockResolvedValue(null);
      const redis = makeRedis();
      const { client: emailClient, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, redis, undefined, emailClient);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('sends both Telegram and email when both are configured', async () => {
      const agentRepo = makeAgentRepo({ name: 'DualBot' });
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const { client: emailClient, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, redis, telegram, emailClient);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));

      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Deduplication', () => {
    it('suppresses second hard-limit tick for same agent', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      // First call: no cached status → should notify
      redis.get.mockResolvedValueOnce(null);
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      // First tick — should notify
      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));
      expect(sendTextSpy).toHaveBeenCalledTimes(1);

      // Second tick — same status cached → should suppress
      redis.get.mockResolvedValueOnce('hard_limited');
      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
        messageId: 'msg-different-2',
      }));
      // Still only called once (from first tick)
      expect(sendTextSpy).toHaveBeenCalledTimes(1);
    });

    it('resends on status transition from soft to hard', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      // First call: no cached status → should notify soft
      redis.get.mockResolvedValueOnce(null);
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      // Soft cap notification
      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.soft_limit_reached',
      }));
      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      const softMsg: string = sendTextSpy.mock.calls[0]![1];
      expect(softMsg).toContain('soft spending cap');

      // Now transition to hard — cached status is 'soft_limited', different from 'hard_limited'
      redis.get.mockResolvedValueOnce('soft_limited');
      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
        messageId: 'msg-different-2',
      }));
      expect(sendTextSpy).toHaveBeenCalledTimes(2);
      const hardMsg: string = sendTextSpy.mock.calls[1]![1];
      expect(hardMsg).toContain('hard spending cap');
    });

    it('caches dedup key with 24h TTL after notification', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      redis.get.mockResolvedValue(null);
      const { client: telegram } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));

      expect(redis.set).toHaveBeenCalledWith(
        'agent:billing:notified:agent-123',
        'hard_limited',
        'EX',
        86400,
      );
    });
  });

  describe('Non-billing TICK_SKIPPED', () => {
    it('does NOT trigger notification for non-billing reason', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const { client: emailClient, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, redis, telegram, emailClient);

      await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'cooldown.active',
      }));

      expect(sendTextSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      // Message should still be accepted (audit-only) — verify processed
      expect(agentRepo.markMessageProcessed).toHaveBeenCalled();
    });

    it('accepts non-billing TICK_SKIPPED without side effects', async () => {
      const agentRepo = makeAgentRepo();
      const redis = makeRedis();
      const broker = makeBroker(agentRepo, redis);

      const result = await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'rate_limit.throttled',
      }));

      expect(result.accepted).toBe(true);
      // Redis dedup key should NOT be touched for non-billing reasons
      expect(redis.get).not.toHaveBeenCalledWith('agent:billing:notified:agent-123');
    });
  });

  describe('Edge cases', () => {
    it('handles missing agent gracefully', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getAgent.mockResolvedValue(null);
      const redis = makeRedis();
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      await expect(
        broker.processInbound(makeTickSkippedEnvelope({
          reason: 'billing.limit_exceeded',
        })),
      ).resolves.toBeDefined();

      // Should not send notification if agent not found
      expect(sendTextSpy).not.toHaveBeenCalled();
    });

    it('handles Telegram delivery failure gracefully', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      redis.get.mockResolvedValue(null);
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      sendTextSpy.mockResolvedValue({ ok: false, error: { code: 'telegram.network_error', message: 'Network error' } });
      const broker = makeBroker(agentRepo, redis, telegram);

      // Should not throw on Telegram failure
      await expect(
        broker.processInbound(makeTickSkippedEnvelope({
          reason: 'billing.soft_limit_reached',
        })),
      ).resolves.toBeDefined();
    });

    it('handles email delivery failure gracefully', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');
      const redis = makeRedis();
      redis.get.mockResolvedValue(null);
      const { client: emailClient, sendSpy } = makeEmailClient();
      sendSpy.mockResolvedValue({ ok: false, error: { code: 'email.send_error', message: 'Send failed' } });
      const broker = makeBroker(agentRepo, redis, undefined, emailClient);

      // Should not throw on email failure
      await expect(
        broker.processInbound(makeTickSkippedEnvelope({
          reason: 'billing.limit_exceeded',
        })),
      ).resolves.toBeDefined();
    });

    it('survives redis.set failure and still marks message processed', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getEffectiveTelegramChatId.mockResolvedValue('111111');
      const redis = makeRedis();
      redis.get.mockResolvedValue(null);
      redis.set.mockRejectedValue(new Error('Redis connection lost'));
      const { client: telegram, sendTextSpy } = makeTelegramClient();
      const broker = makeBroker(agentRepo, redis, telegram);

      // Should not throw — cache write failure is logged but not fatal
      const result = await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));

      // Telegram should still have been attempted
      expect(sendTextSpy).toHaveBeenCalledTimes(1);
      // Message should still be marked as processed (notification was attempted)
      expect(result.accepted).toBe(true);
    });

    it('marks message as failed when handleBillingNotification throws unexpectedly', async () => {
      const agentRepo = makeAgentRepo();
      agentRepo.getAgent.mockRejectedValue(new Error('DB connection lost'));
      const redis = makeRedis();
      const broker = makeBroker(agentRepo, redis);

      const result = await broker.processInbound(makeTickSkippedEnvelope({
        reason: 'billing.limit_exceeded',
      }));

      expect(result.accepted).toBe(false);
      expect(result.error).toBeDefined();
      expect(agentRepo.markMessageProcessed).toHaveBeenCalled();
    });
  });
});
