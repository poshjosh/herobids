import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_BODY, buildNotificationPayload } from '@herobids/domain';
import { EMAIL_SUBJECT_AGENT_NAME_MAX_LENGTH, EmailNotificationChannel, buildEmailSubject } from './email-notification-channel.js';
import type { EmailClient, EmailMessage } from '../alerting/email-client.js';

const PAYLOAD = buildNotificationPayload({ agentId: 'agent-1', agentName: 'Research Bot', eventClass: 'agent.question' });
const OPTIONS = { publicBaseUrl: 'https://app.example.test/' };

function fakeClient(send = vi.fn(async (_message: EmailMessage) => ({ ok: true as const, data: { messageId: 'ses-1' } }))): EmailClient & { send: typeof send } {
  return { send };
}

function recipients(email: string | null | Error = 'owner@example.test') {
  const getUserEmailByAgentId = vi.fn(async () => {
    if (email instanceof Error) throw email;
    return email;
  });
  return { getUserEmailByAgentId };
}

describe('EmailNotificationChannel', () => {
  it('sends the fixed notification to the agent owner and returns the provider message id', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(), OPTIONS);

    const result = await channel.notify(PAYLOAD);

    expect(result).toEqual({ ok: true, data: { messageId: 'ses-1' } });
    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = client.send.mock.calls[0]?.[0];
    expect(sent?.to).toBe('owner@example.test');
    expect(sent?.subject).toBe('New message from Research Bot');
    expect(sent?.text).toContain(NOTIFICATION_BODY);
    expect(sent?.html).toContain(NOTIFICATION_BODY);
  });

  it('links to the agent conversation on the public base URL without a doubled slash', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(), OPTIONS);

    await channel.notify(PAYLOAD);

    expect(client.send.mock.calls[0]?.[0].text).toContain('https://app.example.test/agents/agent-1');
    expect(client.send.mock.calls[0]?.[0].html).toContain('https://app.example.test/agents/agent-1');
  });

  it('escapes an agent name that contains markup', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(), OPTIONS);

    await channel.notify({ ...PAYLOAD, agentName: '<img src=x onerror=1>', title: '<img src=x onerror=1>' });

    expect(client.send.mock.calls[0]?.[0].html).not.toContain('<img src=x onerror=1>');
  });

  it('strips control and bidi characters from the agent name in the subject', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(), OPTIONS);

    await channel.notify({ ...PAYLOAD, agentName: 'Bot\u202Egnp.exe\r\nSubj\u2066ect' });

    expect(client.send.mock.calls[0]?.[0].subject).toBe('New message from Bot gnp.exe Subj ect');
  });

  it('caps the agent name in the subject at the named length', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(), OPTIONS);

    await channel.notify({ ...PAYLOAD, agentName: 'a'.repeat(EMAIL_SUBJECT_AGENT_NAME_MAX_LENGTH + 20) });

    expect(client.send.mock.calls[0]?.[0].subject).toBe(`New message from ${'a'.repeat(EMAIL_SUBJECT_AGENT_NAME_MAX_LENGTH)}`);
  });

  it('falls back to a generic name when the agent name is blank after cleaning', async () => {
    expect(buildEmailSubject('\u200E \n\t')).toBe('New message from an agent');
  });

  it('returns email.disabled when no email client is configured and sends nothing', async () => {
    const lookup = recipients();
    const channel = new EmailNotificationChannel(undefined, lookup, OPTIONS);

    const result = await channel.notify(PAYLOAD);

    expect(result).toMatchObject({ ok: false, error: { code: 'notification.email_disabled' } });
    expect(lookup.getUserEmailByAgentId).not.toHaveBeenCalled();
  });

  it('returns recipient_missing when the agent owner has no account email', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(null), OPTIONS);

    const result = await channel.notify(PAYLOAD);

    expect(result).toMatchObject({ ok: false, error: { code: 'notification.recipient_missing' } });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns recipient_lookup_failed without throwing when the lookup fails', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(new Error('connection reset')), OPTIONS);

    const result = await channel.notify(PAYLOAD);

    expect(result).toMatchObject({ ok: false, error: { code: 'notification.recipient_lookup_failed', message: 'Error' } });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('maps a provider failure to provider_failed and keeps the provider code as context', async () => {
    const client = fakeClient(vi.fn(async () => ({ ok: false as const, error: { code: 'email.timeout', message: 'timed out' } })));
    const channel = new EmailNotificationChannel(client, recipients(), OPTIONS);

    const result = await channel.notify(PAYLOAD);

    expect(result).toEqual({
      ok: false,
      error: { code: 'notification.provider_failed', message: 'provider_failed', context: { providerCode: 'email.timeout' } },
    });
  });

  it('includes the brand image only when one is configured', async () => {
    const client = fakeClient();
    const channel = new EmailNotificationChannel(client, recipients(), {
      ...OPTIONS,
      brandImageUrl: 'https://cdn.example.test/logo.png',
    });

    await channel.notify(PAYLOAD);

    expect(client.send.mock.calls[0]?.[0].html).toContain('https://cdn.example.test/logo.png');
  });
});
