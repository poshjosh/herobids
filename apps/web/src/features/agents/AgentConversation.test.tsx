import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import { AgentConversationView, formatMessageTime, isAgentConversable, isSendShortcut } from './AgentConversation.js';
import type { AgentOutboundMessage } from '../../lib/api-client.js';

const messages: AgentOutboundMessage[] = [{
  id: 'm1',
  agentId: 'agent-1',
  sessionId: null,
  authoredBy: 'agent',
  subject: null,
  body: 'Watching ETH.',
  createdAt: '2026-10-23T09:30:00.000Z',
  contextRef: null,
  messageClass: 'routine',
  deliveryStatus: 'sent',
  emailDeliveryStatus: 'feed_only',
} as unknown as AgentOutboundMessage];

const englishMessages: Record<string, string> = {
  'agentDetail.conversation.title': 'Chat with {name}',
  'agentDetail.conversation.placeholder': 'Message your agent',
  'agentDetail.conversation.send': 'Send',
  'agentDetail.conversation.empty': 'No messages yet.',
  'agentDetail.conversation.starting': 'Starting your agent… it will be ready to chat in a moment.',
  'agentDetail.conversation.intro': 'Tell your agent what to do by chatting with it on Telegram (if configured) or directly here, just like you would a human employee or personal assistant.',
  'agentDetail.conversation.introClose': 'Close',
  'agentDetail.conversation.notRunning': 'Start your agent to talk to it.',
  'agentDetail.conversation.fromPlatform': 'Safety alert',
  'agentDetail.conversation.fromOpenAIdom': 'OpenAIdom',
};

function render(props: Partial<Parameters<typeof AgentConversationView>[0]> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={englishMessages}>
      <AgentConversationView
        agentName="Tom"
        messages={[]}
        canSend
        draft=""
        isSending={false}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
}

describe('isAgentConversable', () => {
  it('allows messages only while the agent is running', () => {
    expect(isAgentConversable('active')).toBe(true);
    expect(isAgentConversable('stopped')).toBe(false);
    expect(isAgentConversable('crashed')).toBe(false);
  });
});

describe('isSendShortcut', () => {
  it('sends on Enter and keeps Shift+Enter for a new line', () => {
    expect(isSendShortcut('Enter', false, false)).toBe(true);
    expect(isSendShortcut('Enter', true, false)).toBe(false);
  });

  it('does not send on Enter while an IME composition is open', () => {
    expect(isSendShortcut('Enter', false, true)).toBe(false);
  });
});

describe('AgentConversationView', () => {
  it('disables the composer and shows the not-running hint when the agent cannot receive messages', () => {
    const html = render({ canSend: false });

    expect(html).toContain('disabled');
    expect(html).toContain('Start your agent to talk to it.');
  });

  it('renders each message body in the thread', () => {
    const html = render({ messages });

    expect(html).toContain('Watching ETH.');
    expect(html).not.toContain('No messages yet.');
  });

  it('titles the card with the agent name', () => {
    expect(render()).toContain('Chat with Tom');
  });

  it('labels platform safety alerts as safety alerts, never as the user', () => {
    const alert = { ...messages[0], id: 'm2', authoredBy: 'platform', messageClass: 'alert', body: 'Balance low.' } as unknown as AgentOutboundMessage;
    const html = render({ messages: [alert] });

    expect(html).toContain('Safety alert');
    expect(html).not.toContain('You');
  });

  it('labels untagged legacy platform messages as safety alerts', () => {
    const legacy = { ...messages[0], id: 'm2', authoredBy: 'platform', messageClass: null, body: 'Balance low.' } as unknown as AgentOutboundMessage;
    expect(render({ messages: [legacy] })).toContain('Safety alert');
  });

  it('does not label platform reminders as safety alerts', () => {
    const reminder = { ...messages[0], id: 'm2', authoredBy: 'platform', messageClass: 'reminder', subject: 'Session started', body: 'nimble-falcon is now ready for your instructions.' } as unknown as AgentOutboundMessage;
    const html = render({ messages: [reminder] });

    expect(html).toContain('OpenAIdom');
    expect(html).not.toContain('Safety alert');
  });

  it('wraps long unbroken links inside the message bubble', () => {
    const link = { ...messages[0], id: 'm4', body: 'https://staging.openaidom.com/auth/connection-request/callback?token=EkMhFj6xNZG1X0rrvNEHtFURDK7GDD8NhJpiRcB102I' } as unknown as AgentOutboundMessage;
    expect(render({ messages: [link] })).toContain('overflow-wrap:anywhere');
  });

  it('shows the oldest message first', () => {
    const newer = { ...messages[0], id: 'm2', body: 'Second reply.' } as unknown as AgentOutboundMessage;
    const html = render({ messages: [newer, ...messages] });

    expect(html.indexOf('Watching ETH.')).toBeLessThan(html.indexOf('Second reply.'));
  });

  it('places the user\'s messages on the right and the agent\'s on the left', () => {
    const own = { ...messages[0], id: 'm3', authoredBy: 'user', body: 'Buy more ETH.' } as unknown as AgentOutboundMessage;
    const html = render({ messages: [own, ...messages] });

    expect(html).toContain('justify-content:flex-end');
    expect(html).toContain('justify-content:flex-start');
  });

  it('does not label the user\'s own message as a safety alert', () => {
    const own = { ...messages[0], id: 'm3', authoredBy: 'user', body: 'Buy more ETH.' } as unknown as AgentOutboundMessage;
    const html = render({ messages: [own] });

    expect(html).toContain('Buy more ETH.');
    expect(html).not.toContain('Safety alert');
  });

  it('shows the character count against the 4000 limit', () => {
    expect(render({ draft: 'hello' })).toContain('5/4000');
  });

  it('shows the starting notice while the agent is starting', () => {
    expect(render({ isStarting: true, canSend: false })).toContain('Starting your agent');
  });

  it('shows the post-start intro only when the agent can receive messages and it has not been dismissed', () => {
    expect(render({ canSend: true, showIntro: true })).toContain('just like you would a human employee');
    expect(render({ canSend: false, showIntro: true })).not.toContain('just like you would a human employee');
    expect(render({ canSend: true, showIntro: false })).not.toContain('just like you would a human employee');
  });

  it('shows the empty state when there are no messages', () => {
    expect(render({ messages: [] })).toContain('No messages yet.');
  });

  it('shows only the time for messages from today and the date for older ones', () => {
    const format = { formatDate: (value: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', options).format(value) };
    const now = new Date(2026, 9, 23, 18, 0, 0);
    const today = new Date(2026, 9, 23, 9, 30, 0).toISOString();
    const older = new Date(2026, 9, 20, 9, 30, 0).toISOString();
    expect(formatMessageTime(format, today, now)).not.toContain('2026');
    expect(formatMessageTime(format, older, now)).toContain('2026');
  });
});
