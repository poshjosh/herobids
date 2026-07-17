/**
 * Unit tests for AgentMessageBroker email policy enforcement (send_message fanout rules).
 */
import { describe, it, expect, vi } from 'vitest';
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

function makeAgentRepo(overrides: {
  agentOverrides?: Record<string, unknown>;
  effectiveEmailEnabled?: boolean;
} = {}) {
  return {
    isMessageDuplicate: vi.fn().mockResolvedValue(false),
    isActiveSession: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(makeAgent(overrides.agentOverrides ?? {})),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001', status: 'running' }),
    insertOutboundMessage: vi.fn().mockResolvedValue('msg-out-001'),
    markOutboundMessageSent: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageFailed: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageEmailSent: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageEmailSkipped: vi.fn().mockResolvedValue(undefined),
    markOutboundMessageEmailFailed: vi.fn().mockResolvedValue(undefined),
    getEffectiveTelegramChatId: vi.fn().mockResolvedValue(null),
    getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
    getEffectiveEmailEnabled: vi.fn().mockResolvedValue(overrides.effectiveEmailEnabled ?? true),
    getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue({ grantedConnectionsByFamily: {}, defaultConnectionByFamily: {} }),
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
    undefined,
    emailClient,
  );
}

// Email fanout from send_message has been removed (Item 5).
// Agents should use the dedicated send_email tool for email delivery.
// All tests below are skipped until email fanout is re-introduced via a different path.
describe.skip('AgentMessageBroker email policy enforcement', () => {
  describe('emailDelivery must be if_allowed', () => {
    it('does not email when emailDelivery is never', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
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

    it('does not email when emailDelivery is omitted', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'update',
        messageClass: 'alert',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'feed_only');
    });
  });

  describe('message class no longer gates email', () => {
    it('sends email for a routine message when policy allows and emailDelivery is if_allowed', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'routine update',
        messageClass: 'routine',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(agentRepo.markOutboundMessageEmailSent).toHaveBeenCalledWith('msg-out-001', 'email-123');
    });

    it('sends email for an alert message when all rules pass', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
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
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'Your reminder!',
        messageClass: 'reminder',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(agentRepo.markOutboundMessageEmailSent).toHaveBeenCalledWith('msg-out-001', 'email-123');
    });
  });

  describe('effective policy resolution', () => {
    // Note: getEffectiveEmailEnabled precedence logic is unit-tested in
    // packages/db/src/__tests__/agent-repository-email-policy.test.ts
    it('skips email when agent explicitly disables (overriding an enabled user preference)', async () => {
      // getEffectiveEmailEnabled resolves: agent explicit false → returns false
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: false });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'update',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(agentRepo.getEffectiveEmailEnabled).toHaveBeenCalledWith('agent-123');
      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'email_skipped_policy');
    });

    it('sends email when agent explicitly enables (overriding a disabled user preference)', async () => {
      // getEffectiveEmailEnabled resolves: agent explicit true → returns true
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'update',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(agentRepo.getEffectiveEmailEnabled).toHaveBeenCalledWith('agent-123');
    });

    it('sends email when agent inherits an enabled user-level preference', async () => {
      // getEffectiveEmailEnabled resolves: agent null → user enabled true → returns true
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'update',
        messageClass: 'routine',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(agentRepo.getEffectiveEmailEnabled).toHaveBeenCalledWith('agent-123');
    });

    it('sends email on system default when both agent and user preferences are unset', async () => {
      // getEffectiveEmailEnabled resolves: agent null, user null → system default true
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'update',
        messageClass: 'routine',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(agentRepo.getEffectiveEmailEnabled).toHaveBeenCalledWith('agent-123');
    });
  });

  describe('operator email infrastructure required', () => {
    it('skips email when no email client is configured', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const broker = makeBroker(agentRepo, undefined); // no email client

      await broker.processInbound(makeSendEnvelope({
        body: 'alert',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(agentRepo.markOutboundMessageEmailSkipped).toHaveBeenCalledWith('msg-out-001', 'email_skipped_not_configured');
    });
  });

  describe('verified recipient required', () => {
    it('skips email and records skip when no verified account email exists', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
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

  describe('fallback email subjects', () => {
    it('uses a neutral subject for routine messages when no subject is provided', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'routine update',
        messageClass: 'routine',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Message from your agent',
      }));
    });

    it('uses a reminder-specific fallback subject for reminder messages', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'reminder body',
        messageClass: 'reminder',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Reminder from your agent',
      }));
    });

    it('uses an alert-specific fallback subject for alert messages', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'alert body',
        messageClass: 'alert',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Alert from your agent',
      }));
    });

    it('uses the provided subject over the fallback', async () => {
      const agentRepo = makeAgentRepo({ effectiveEmailEnabled: true });
      const { client, sendSpy } = makeEmailClient();
      const broker = makeBroker(agentRepo, client);

      await broker.processInbound(makeSendEnvelope({
        body: 'routine update',
        subject: 'Custom Subject',
        messageClass: 'routine',
        emailDelivery: 'if_allowed',
      }));

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        subject: 'Custom Subject',
      }));
    });
  });
});
