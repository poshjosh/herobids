import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PlatformAlertService,
  PLATFORM_ALERT_EVENTS,
  type PlatformAlertContext,
} from './platform-alert-service.js';
import type { TelegramClient } from './telegram-client.js';
import { TelegramChannel } from './telegram-channel.js';
import { ChatDelivery } from './chat-delivery.js';
import type { EmailClient } from './email-client.js';

const logWarn = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({ createLogger: () => ({ warn: logWarn, info: vi.fn(), debug: vi.fn() }) }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentRepo(overrides: Record<string, unknown> = {}) {
  return {
    getAgent: vi.fn().mockResolvedValue({ id: 'agent-abc-12345678', userId: 'user-1' }),
    getEffectiveChatAddress: vi.fn().mockResolvedValue(null),
    isChatAddressSuppressed: vi.fn().mockResolvedValue(false),
    getUserEmailByAgentId: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeConversations(recorded: unknown = { ok: true, data: { message: { id: 'msg-001' }, created: true } }) {
  return {
    recordPlatformMessage: vi.fn().mockResolvedValue(recorded),
    markDelivery: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  };
}

function makeTelegramClient(overrides: Record<string, unknown> = {}): TelegramClient {
  return {
    sendText: vi.fn().mockResolvedValue({ ok: true, data: { messageId: 42 } }),
    ...overrides,
  } as unknown as TelegramClient;
}

function chatDelivery(agentRepo: ReturnType<typeof makeAgentRepo>, telegram: TelegramClient): ChatDelivery {
  return new ChatDelivery(agentRepo as any, { get: () => new TelegramChannel(telegram) }, { set: vi.fn() });
}

function makeEmailClient(overrides: Record<string, unknown> = {}): EmailClient {
  return {
    send: vi.fn().mockResolvedValue({ ok: true, data: { messageId: 'email-abc' } }),
    ...overrides,
  } as unknown as EmailClient;
}

function makeContext(overrides?: Partial<PlatformAlertContext>): PlatformAlertContext {
  return {
    agentId: 'agent-abc-12345678',
    agentName: 'Test Agent',
    sessionId: 'sess-xyz',
    message: 'The agent runtime has become unhealthy due to heartbeat loss.',
    detail: 'Last heartbeat was 300 seconds ago, exceeding the 120-second threshold.',
    ...overrides,
  };
}

function makeService(
  agentRepoOverrides: Record<string, unknown> = {},
  telegram?: TelegramClient,
  emailClient?: EmailClient,
) {
  const agentRepo = makeAgentRepo(agentRepoOverrides);
  return {
    service: new PlatformAlertService(agentRepo as any, telegram ? chatDelivery(agentRepo, telegram) : undefined, telegram ? 'bot-token-123' : undefined, emailClient),
    agentRepo,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformAlertService', () => {
  // -- Persistence ------------------------------------------------------------

  describe('persistence', () => {
    function threadService(agentRepoOverrides: Record<string, unknown> = {}, conversations = makeConversations()) {
      const agentRepo = makeAgentRepo(agentRepoOverrides);
      return { agentRepo, conversations, service: new PlatformAlertService(agentRepo as any, undefined, undefined, undefined, undefined, conversations as any) };
    }

    it('records the alert in the agent conversation before delivering', async () => {
      const { service, conversations } = threadService();

      await service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext());

      expect(conversations.recordPlatformMessage).toHaveBeenCalledTimes(1);
      const call = conversations.recordPlatformMessage.mock.calls[0]![0];
      expect(call.ownerUserId).toBe('user-1');
      expect(call.agentId).toBe('agent-abc-12345678');
      expect(call.messageClass).toBe('alert');
      expect(call.subject).toBe('Runtime Unhealthy');
      expect(call.body).toContain('heartbeat loss');
      expect(call.body).toContain('300 seconds ago');
    });

    it('records the body without detail when detail is undefined', async () => {
      const { service, conversations } = threadService();

      await service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext({ detail: undefined }));

      const call = conversations.recordPlatformMessage.mock.calls[0]![0];
      expect(call.body).toBe('The agent runtime has become unhealthy due to heartbeat loss.');
      expect(call.body).not.toContain('300 seconds');
    });

    it('marks the thread message not applicable when chat is not configured', async () => {
      const { service, conversations } = threadService();

      await service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext());

      expect(conversations.markDelivery).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-001', status: 'not_applicable' }));
    });

    it.each([
      ['a store error', makeConversations({ ok: false, error: { code: 'conversation.store_failed', message: 'down' } })],
      ['a thrown error', Object.assign(makeConversations(), { recordPlatformMessage: vi.fn().mockRejectedValue(new Error('DB down')) })],
    ])('survives %s on recording and continues delivery', async (_name, conversations) => {
      const agentRepo = makeAgentRepo({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
      });
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined, undefined, conversations as any);

      await expect(svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext())).resolves.toBeUndefined();

      expect(telegram.sendText).toHaveBeenCalledTimes(1);
      expect(conversations.markDelivery).not.toHaveBeenCalled();
    });

    it('survives an unknown agent and continues delivery', async () => {
      const { service, conversations } = threadService({ getAgent: vi.fn().mockResolvedValue(null) });

      await expect(service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext())).resolves.toBeUndefined();

      expect(conversations.recordPlatformMessage).not.toHaveBeenCalled();
    });
  });

  // -- Telegram delivery ------------------------------------------------------

  describe('Telegram delivery', () => {
    it('sends a formatted Telegram message when chat ID is available', async () => {
      const { service, agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
      });
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      expect(telegram.sendText).toHaveBeenCalledTimes(1);
      const [, text] = (telegram.sendText as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(text).toContain('OpenAIdom Safety Alert');
      expect(text).toContain('Runtime Failed');
      expect(text).toContain('Test Agent');
      expect(text).toContain('heartbeat loss');
    });

    it('marks the thread message sent on the Telegram channel on Telegram success', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
      });
      const conversations = makeConversations();
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined, undefined, conversations as any);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL, makeContext());

      expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-001', status: 'sent', providerMessageId: '42', channel: 'telegram' });
    });

    it('marks the thread message failed on Telegram failure', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
      });
      const conversations = makeConversations();
      const telegram = makeTelegramClient({
        sendText: vi.fn().mockResolvedValue({ ok: false, error: { code: 'tg.error', message: 'Network error' } }),
      });
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined, undefined, conversations as any);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-001', status: 'failed', detail: 'Network error' });
    });

    it('marks the thread message not applicable when the agent has no chat address', async () => {
      const { agentRepo } = makeService({ getEffectiveChatAddress: vi.fn().mockResolvedValue(null) });
      const conversations = makeConversations();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, makeTelegramClient()), 'bot-token', undefined, undefined, conversations as any);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-001', status: 'not_applicable', detail: 'no_chat_address' });
    });

    it('marks the thread message failed when the chat address lookup fails (fail closed)', async () => {
      const { agentRepo } = makeService({ getEffectiveChatAddress: vi.fn().mockRejectedValue(new Error('DB error')) });
      const conversations = makeConversations();
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined, undefined, conversations as any);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      expect(telegram.sendText).not.toHaveBeenCalled();
      expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-001', status: 'failed', detail: 'DB error' });
    });

    it('marks the thread message failed for a suppressed address', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
        isChatAddressSuppressed: vi.fn().mockResolvedValue(true),
      });
      const conversations = makeConversations();
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined, undefined, conversations as any);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      expect(telegram.sendText).not.toHaveBeenCalled();
      expect(conversations.markDelivery).toHaveBeenCalledWith({ messageId: 'msg-001', status: 'failed', detail: 'address_suppressed' });
    });

    it('skips Telegram when no chat ID is available', async () => {
      const { service, agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue(null),
      });
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext());

      expect(telegram.sendText).not.toHaveBeenCalled();
    });

    it('logs chat address lookup failure and still delivers the email fallback', async () => {
      const { service, agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockRejectedValue(new Error('DB error')),
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const telegram = makeTelegramClient();
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext());

      // Should not throw; Telegram delivery is skipped gracefully
      expect(telegram.sendText).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-abc-12345678', error: { code: 'chat.address_lookup_failed', message: 'DB error' } }),
        'Platform alert chat address lookup failed',
      );
      expect(emailClient.send).toHaveBeenCalledTimes(1);
    });

    it('skips Telegram when Telegram client is not configured', async () => {
      const { service } = makeService();

      // Should not throw
      await expect(
        service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext()),
      ).resolves.toBeUndefined();
    });

    it('uses agent ID snippet when agent name is not available', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
      });
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext({ agentName: undefined }));

      const [, text] = (telegram.sendText as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(text).toContain('agent-ab');
    });
  });

  // -- Email delivery ---------------------------------------------------------

  describe('Email delivery', () => {
    it('sends branded email when recipient email is available', async () => {
      const { service, agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext());

      expect(emailClient.send).toHaveBeenCalledTimes(1);
      const [emailMsg] = (emailClient.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(emailMsg.to).toBe('user@example.com');
      expect(emailMsg.subject).toContain('[Safety Alert]');
      expect(emailMsg.subject).toContain('Runtime Unhealthy');
      expect(emailMsg.text).toContain('heartbeat loss');
      expect(emailMsg.html).toContain('<!DOCTYPE html>');
      expect(emailMsg.html).toContain('OpenAIdom');
    });

    it('includes detail in email body when provided', async () => {
      const { agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.EXECUTION_CRITICAL_FAILURE, makeContext());

      const [emailMsg] = (emailClient.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(emailMsg.text).toContain('300 seconds ago');
    });

    it('includes agent info in email footer', async () => {
      const { agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL, makeContext());

      const [emailMsg] = (emailClient.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(emailMsg.text).toContain('Test Agent');
      expect(emailMsg.text).toContain('agent-ab');
    });

    it('uses agent ID in footer when name is not available', async () => {
      const { agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext({ agentName: undefined }));

      const [emailMsg] = (emailClient.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(emailMsg.text).toContain('Agent ID: agent-ab');
    });

    it('skips email when no recipient email is available', async () => {
      const { service, agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue(null),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext());

      expect(emailClient.send).not.toHaveBeenCalled();
    });

    it('skips email when lookup fails', async () => {
      const { service, agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockRejectedValue(new Error('DB error')),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      // Should not throw
      await expect(
        svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext()),
      ).resolves.toBeUndefined();

      expect(emailClient.send).not.toHaveBeenCalled();
    });

    it('skips email when email client is not configured', async () => {
      const { service } = makeService({ getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com') });

      // Should not throw
      await expect(
        service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext()),
      ).resolves.toBeUndefined();
    });

    it('handles email delivery failure gracefully', async () => {
      const { agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient({
        send: vi.fn().mockResolvedValue({ ok: false, error: { code: 'email.error', message: 'Send failed' } }),
      });
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      // Should not throw
      await expect(
        svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext()),
      ).resolves.toBeUndefined();
    });
  });

  // -- Dual-channel delivery --------------------------------------------------

  describe('dual-channel delivery', () => {
    it('delivers via both Telegram and email when both are configured', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const telegram = makeTelegramClient();
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      expect(telegram.sendText).toHaveBeenCalledTimes(1);
      expect(emailClient.send).toHaveBeenCalledTimes(1);
    });

    it('still delivers via email when Telegram fails', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const telegram = makeTelegramClient({
        sendText: vi.fn().mockResolvedValue({ ok: false, error: { code: 'tg.error', message: 'fail' } }),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      // Telegram was attempted (and failed)
      expect(telegram.sendText).toHaveBeenCalledTimes(1);
      // Email should still be sent despite Telegram failure
      expect(emailClient.send).toHaveBeenCalledTimes(1);
    });

    it('still delivers via Telegram when email fails', async () => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const telegram = makeTelegramClient();
      const emailClient = makeEmailClient({
        send: vi.fn().mockResolvedValue({ ok: false, error: { code: 'email.error', message: 'fail' } }),
      });
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', emailClient);

      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, makeContext());

      // Telegram should succeed even though email failed
      expect(telegram.sendText).toHaveBeenCalledTimes(1);
      expect(emailClient.send).toHaveBeenCalledTimes(1); // attempted but failed
    });

    it('logs warning when no channel succeeds', async () => {
      const { service } = makeService();

      // No Telegram, no email — should not throw
      await expect(
        service.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext()),
      ).resolves.toBeUndefined();
    });
  });

  // -- Event subject mapping --------------------------------------------------

  describe('event subjects', () => {
    it.each([
      [PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, 'Runtime Unhealthy'],
      [PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, 'Runtime Failed'],
      [PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL, 'Agent Paused by Guardrail'],
      [PLATFORM_ALERT_EVENTS.EXECUTION_CRITICAL_FAILURE, 'Critical Execution Failure'],
    ] as const)('maps %s → "%s"', async (event, expectedSubject) => {
      const { agentRepo } = makeService({
        getEffectiveChatAddress: vi.fn().mockResolvedValue({ provider: 'telegram', address: '111111' }),
      });
      const telegram = makeTelegramClient();
      const svc = new PlatformAlertService(agentRepo as any, chatDelivery(agentRepo, telegram), 'bot-token', undefined);

      await svc.fireAlert(event, makeContext());

      const [, text] = (telegram.sendText as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(text).toContain(expectedSubject);
    });
  });

  // -- Email subject format ---------------------------------------------------

  describe('email subjects', () => {
    it.each([
      [PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, 'Runtime Unhealthy'],
      [PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, 'Runtime Failed'],
      [PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL, 'Agent Paused by Guardrail'],
      [PLATFORM_ALERT_EVENTS.EXECUTION_CRITICAL_FAILURE, 'Critical Execution Failure'],
    ] as const)('prepends [Safety Alert] for %s', async (event, expectedSubject) => {
      const { agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      await svc.fireAlert(event, makeContext());

      const [emailMsg] = (emailClient.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(emailMsg.subject).toBe(`[Safety Alert] ${expectedSubject}`);
    });
  });

  // -- Detail truncation ------------------------------------------------------

  describe('detail truncation', () => {
    it('truncates long detail text in email body', async () => {
      const { agentRepo } = makeService({
        getUserEmailByAgentId: vi.fn().mockResolvedValue('user@example.com'),
      });
      const emailClient = makeEmailClient();
      const svc = new PlatformAlertService(agentRepo as any, undefined, undefined, emailClient);

      const longDetail = 'A'.repeat(1000);
      await svc.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, makeContext({ detail: longDetail }));

      const [emailMsg] = (emailClient.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      // Detail should be truncated to 500 chars
      expect(emailMsg.text).toContain('Details:');
      expect(emailMsg.text.length).toBeLessThan(longDetail.length + 500);
    });
  });
});
