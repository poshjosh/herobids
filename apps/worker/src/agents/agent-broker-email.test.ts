/**
 * Unit tests for AgentMessageBroker email policy enforcement (send_message fanout rules).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMessageBroker } from './agent-message-broker.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { EmailClient } from '../alerting/email-client.js';

const SEND_MESSAGE_ENVELOPE = {
  schemaVersion: 'v1',
  correlationId: 'corr-001',
  initiatorType: 'agent',
  initiatorId: 'agent-123',
  agentId: 'agent-123',
  type: 'agent.message.send',
  createdAt: '2026-06-01T00:00:00.000Z',
};

function makeSendEnvelope(payloadOverrides: Record<string, unknown> = {}) {
  return {
    ...SEND_MESSAGE_ENVELOPE,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    payload: {
      body: 'Test message body',
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
  return {
    isMessageDuplicate: vi.fn().mockResolvedValue(false),
    isActiveSession: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(makeAgent(agentOverrides)),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001', status: 'running' }),
    insertOutboundMessage: vi.fn().mockResolvedValue('msg-out-001'),
    markOutboundMessageSent: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageFailed: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageEmailSent: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageEmailSkipped: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageEmailFailed: vi.fn().mockResolvedValue(undefined),
    getEffectiveTelegramChatId: vi.fn().mockResolvedValue(null),
    getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
    getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue({ grantedBindingsByFamily: {}, defaultBindingByFamily: {} }),
  };
}

function makeEmailClient(): { client: EmailClient; sendSpy: ReturnType<typeof vi.fn> } {
  const sendSpy = vi.fn().mockResolvedValue({ ok: true, data: { messageId: 'email-123' } });
  return { client: { send: sendSpy }, sendSpy };
}

function makeBroker(agentRepo: ReturnType<typeof makeAgentRepo>, emailClient?: EmailClient) {
  return new AgentMessageBroker(
    {} as any,
    agentRepo as any,
    { handleDecisionSubmit: vi.fn() } as unknown as AgentDecisionHandler,
    { handleHeartbeat: vi.fn(), handlePauseRequest: vi.fn(), handleStopRequest: vi.fn() } as unknown as AgentSessionManager,
    {} as unknown as InstanceEventPublisher,
    undefined, // no Telegram
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    emailClient,
  );
}

describe('AgentMessageBroker email policy enforcement', () => {
  describe('Rule 3: routine messages never email', () => {
    it('does not email a routine message even when emailDelivery is if_allowed', async () => {
      const agentRepo = makeAgentRepo({
        notificationPolicy: {
          sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-01-01T00:00:00Z' } },
        },
      });
      const { client, sendSpy } = makeEmailClient();
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');

      const broker = makeBroker(agentRepo, client);
      await broker.processInbound(makeSendEnvelope({
        body: 'routine update',
        messageClass: 'routine',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'email_skipped_policy');
    });
  });

  describe('Rule 4: email requires explicit if_allowed', () => {
    it('does not email when emailDelivery is never', async () => {
      const agentRepo = makeAgentRepo({
        notificationPolicy: {
          sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-01-01T00:00:00Z' } },
        },
      });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'alert body',
        messageClass: 'alert',
        emailDelivery: 'never',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'feed_only');
    });
  });

  describe('Rule 2: agent must have email enabled in notificationPolicy', () => {
    it('does not email when agent has no notificationPolicy', async () => {
      const agentRepo = makeAgentRepo({ notificationPolicy: null });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'alert',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'email_skipped_policy');
    });
  });

  describe('Rule 7: operator email infrastructure required', () => {
    it('skips email when no email client is configured', async () => {
      const agentRepo = makeAgentRepo({
        notificationPolicy: {
          sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-01-01T00:00:00Z' } },
        },
      });
      const broker = makeBroker(agentRepo, undefined); // no email client

      await broker.processInbound(makeSendEnvelope({
        body: 'alert',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'email_skipped_not_configured');
    });
  });

  describe('Rule 6: no verified email records a skip', () => {
    it('skips email and records skip when no verified recipient', async () => {
      const agentRepo = makeAgentRepo({
        notificationPolicy: {
          sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-01-01T00:00:00Z' } },
        },
      });
      agentRepo.getUserEmailByAgentId.mockResolvedValue(null);
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'alert',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'email_skipped_no_verified_recipient');
    });
  });

  describe('eligible messages are sent', () => {
    it('sends email for an alert message when all rules pass', async () => {
      const agentRepo = makeAgentRepo({
        notificationPolicy: {
          sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-01-01T00:00:00Z' } },
        },
      });
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'Important alert!',
        subject: 'Alert',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        to: 'user@example.com',
        subject: 'Alert',
        text: 'Important alert!',
      }));
      expect(agentRepo.markOutboundMessageEmailSent).toHaveBeenCalledWith('msg-out-001', 'email-123');
    });

    it('sends email for a reminder message when all rules pass', async () => {
      const agentRepo = makeAgentRepo({
        notificationPolicy: {
          sendMessage: { email: { enabled: true, source: 'explicit_update', enabledAt: '2026-01-01T00:00:00Z' } },
        },
      });
      agentRepo.getUserEmailByAgentId.mockResolvedValue('user@example.com');
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'Your reminder!',
        messageClass: 'reminder',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
    });
  });
});
