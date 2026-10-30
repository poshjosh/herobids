import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentConversationView,
  bubbleAuthor,
  formatMessageTime,
  isAgentConversable,
  isSendShortcut,
  startingPhase,
} from './AgentConversation.js';
import type { AgentConversationMessage } from '../../lib/api-client.js';

const agentMessage: AgentConversationMessage = {
  id: 'm1',
  senderType: 'agent',
  senderId: 'agent-1',
  channel: 'web',
  subject: null,
  body: 'Watching ETH.',
  messageClass: 'routine',
  deliveryStatus: 'sent',
  createdAt: '2026-10-23T09:30:00.000Z',
};
const messages: AgentConversationMessage[] = [agentMessage];
const userMessage: AgentConversationMessage = {
  ...agentMessage, id: 'u1', senderType: 'user', senderId: 'user-1', messageClass: null, body: 'Buy more ETH.',
};

const englishMessages: Record<string, string> = {
  'agentDetail.conversation.chatWith': 'Chat with {name}',
  'agentDetail.conversation.startToChat': 'Start {name} to chat with it',
  'agentDetail.conversation.send': 'Send',
  'agentDetail.conversation.starting': 'Starting your agent…',
  'agentDetail.conversation.startingSlow': 'Still starting… this usually takes under a minute.',
  'agentDetail.conversation.startingStuck': 'This is taking longer than expected.',
  'agentDetail.conversation.retry': 'Retry',
  'agentDetail.conversation.queuedHint': 'Your message will be delivered as soon as your agent is ready.',
  'agentDetail.conversation.thinking': '{name} is thinking…',
  'agentDetail.conversation.connectionApproved': 'Connection approved. {name} is picking up where you left off…',
  'agentDetail.conversation.intro': 'Tell your agent what to do by chatting with it on Telegram (if configured) or directly here, just like you would a human employee or personal assistant.',
  'agentDetail.conversation.introClose': 'Close',
  'agentDetail.conversation.fromPlatform': 'Safety alert',
  'agentDetail.conversation.fromOpenAIdom': 'OpenAIdom',
  'agentDetail.conversation.fromParentAgent': 'Parent agent',
  'agentDetail.conversation.sending': 'Sending…',
  'agentDetail.conversation.notSent': 'Not sent',
  'agentDetail.conversation.loadEarlier': 'Show earlier messages',
  'agentDetail.conversation.loadError': 'Could not load the conversation.',
  'agentDetail.conversation.attach': 'Attach document',
  'agentDetail.conversation.removeAttachment': 'Remove document',
  'agentDetail.conversation.attachmentTooLarge': 'That file is larger than 10 MB.',
  'agentDetail.conversation.attachmentUnsupported': 'That file type is not supported. Use text, JSON, XML, CSV, PDF or Word (.docx).',
};

function render(props: Partial<Parameters<typeof AgentConversationView>[0]> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={englishMessages}>
      <AgentConversationView
        agentName="Tom"
        agentId="agent-1"
        messages={[]}
        canSend
        draft=""
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

describe('startingPhase', () => {
  it('shows the plain starting message for the first 15 seconds', () => {
    expect(startingPhase(0)).toBe('starting');
    expect(startingPhase(14_999)).toBe('starting');
  });

  it('switches to the slow message at 15 seconds', () => {
    expect(startingPhase(15_000)).toBe('slow');
  });

  it('offers a retry once the agent has been starting for two minutes', () => {
    expect(startingPhase(120_000)).toBe('stuck');
  });
});

describe('AgentConversationView', () => {
  it('disables the composer and prompts the user to start the agent when it cannot receive messages', () => {
    const html = render({ canSend: false });

    expect(html).toContain('disabled');
    expect(html).toContain('placeholder="Start Tom to chat with it"');
  });

  it('renders each message body in the thread', () => {
    const html = render({ messages });

    expect(html).toContain('Watching ETH.');
  });

  it('prompts the user to chat with the agent when it can receive messages', () => {
    expect(render({ canSend: true })).toContain('placeholder="Chat with Tom"');
  });

  it('labels platform safety alerts as safety alerts, never as the user', () => {
    const alert: AgentConversationMessage = { ...agentMessage, id: 'm2', senderType: 'platform', senderId: null, messageClass: 'alert', body: 'Balance low.' };
    const html = render({ messages: [alert] });

    expect(html).toContain('Safety alert');
    expect(html).not.toContain('You');
  });

  it('labels untagged legacy platform messages as safety alerts', () => {
    const legacy: AgentConversationMessage = { ...agentMessage, id: 'm2', senderType: 'platform', senderId: null, messageClass: null, body: 'Balance low.' };
    expect(render({ messages: [legacy] })).toContain('Safety alert');
  });

  it('does not label platform reminders as safety alerts', () => {
    const reminder: AgentConversationMessage = { ...agentMessage, id: 'm2', senderType: 'platform', senderId: null, messageClass: 'reminder', subject: 'Session started', body: 'nimble-falcon is now ready for your instructions.' };
    const html = render({ messages: [reminder] });

    expect(html).toContain('OpenAIdom');
    expect(html).not.toContain('Safety alert');
  });

  it('wraps long unbroken links inside the message bubble', () => {
    const link = { ...agentMessage, id: 'm4', body: 'https://staging.openaidom.com/auth/connection-request/callback?token=EkMhFj6xNZG1X0rrvNEHtFURDK7GDD8NhJpiRcB102I' };
    expect(render({ messages: [link] })).toContain('overflow-wrap:anywhere');
  });

  it('shows the oldest message first', () => {
    const newer = { ...agentMessage, id: 'm2', body: 'Second reply.', createdAt: '2026-10-23T09:31:00.000Z' };
    const html = render({ messages: [agentMessage, newer] });

    expect(html.indexOf('Watching ETH.')).toBeLessThan(html.indexOf('Second reply.'));
  });

  it('places the user\'s messages on the right, the agent\'s on the left and platform messages in the centre', () => {
    const platform: AgentConversationMessage = { ...agentMessage, id: 'p1', senderType: 'platform', senderId: null, messageClass: 'reminder', body: 'Reminder.' };
    const html = render({ messages: [agentMessage, userMessage, platform] });

    expect(html).toMatch(/data-author="agent" style="[^"]*justify-content:flex-start/);
    expect(html).toMatch(/data-author="user" style="[^"]*justify-content:flex-end/);
    expect(html).toMatch(/data-author="platform" style="[^"]*justify-content:center/);
  });

  it('names the agent on its own messages and never labels the user\'s message', () => {
    const html = render({ messages: [agentMessage, userMessage] });

    expect(html).toContain('Tom');
    expect(html).toContain('Buy more ETH.');
    expect(html).not.toContain('Safety alert');
    expect(html).not.toContain('From you');
  });

  it('labels a message written by another agent (a creator) as the parent agent, not as this agent', () => {
    const fromCreator: AgentConversationMessage = { ...agentMessage, id: 'c1', senderId: 'creator-9', body: 'Status update?' };
    const html = render({ messages: [fromCreator] });

    expect(html).toContain('Parent agent');
    expect(html).toContain('data-author="parent"');
    expect(html).not.toContain('>Tom<');
  });

  it('marks a queued message from the user as sending and gives it no retry', () => {
    const html = render({ messages: [{ ...userMessage, deliveryStatus: 'queued' }], onRetryMessage: vi.fn() });

    expect(html).toContain('Sending…');
    expect(html).not.toContain('Not sent');
  });

  it('marks a failed message from the user as not sent and offers a retry', () => {
    const html = render({ messages: [{ ...userMessage, deliveryStatus: 'failed' }], onRetryMessage: vi.fn() });

    expect(html).toContain('Not sent');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Sending…');
  });

  it('marks a stuck queued message from the user as not sent and offers a retry instead of spinning forever', () => {
    const html = render({ messages: [{ ...userMessage, deliveryStatus: 'queued', stuck: true }], onRetryMessage: vi.fn() });

    expect(html).toContain('Not sent');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Sending…');
  });

  it('marks a refused message from the user as not sent without a retry, since the server will not republish it', () => {
    const html = render({ messages: [{ ...userMessage, deliveryStatus: 'refused' }], onRetryMessage: vi.fn() });

    expect(html).toContain('Not sent');
    expect(html).not.toContain('Retry');
  });

  it('shows a delivered or not-applicable user message without a status marker', () => {
    const html = render({ messages: [{ ...userMessage, deliveryStatus: 'sent' }, { ...userMessage, id: 'u2', deliveryStatus: 'not_applicable' }], onRetryMessage: vi.fn() });

    expect(html).not.toContain('Sending…');
    expect(html).not.toContain('Not sent');
  });

  it('does not show a failure marker on an agent message', () => {
    expect(render({ messages: [{ ...agentMessage, deliveryStatus: 'failed' }], onRetryMessage: vi.fn() })).not.toContain('Not sent');
  });

  it('offers to load earlier messages only when there are some, and not for an empty thread', () => {
    expect(render({ messages, onLoadEarlier: vi.fn() })).toContain('Show earlier messages');
    expect(render({ messages })).not.toContain('Show earlier messages');
  });

  it('says so, beside the button, when loading earlier messages fails', () => {
    expect(render({ messages, onLoadEarlier: vi.fn(), loadEarlierFailed: true })).toContain('Could not load the conversation.');
    expect(render({ messages, onLoadEarlier: vi.fn(), loadEarlierFailed: true, isLoadingEarlier: true })).not.toContain('Could not load the conversation.');
    expect(render({ messages, onLoadEarlier: vi.fn() })).not.toContain('Could not load the conversation.');
  });

  it('says the conversation could not be loaded when the first read fails', () => {
    expect(render({ loadFailed: true })).toContain('Could not load the conversation.');
    expect(render({ loadFailed: true, messages })).not.toContain('Could not load the conversation.');
  });

  it('shows the character count against the 4000 limit', () => {
    expect(render({ draft: 'hello' })).toContain('5/4000');
  });

  it('uses the limit the server reports', () => {
    const html = render({ draft: 'hello', maxChars: 1200 });

    expect(html).toContain('5/1200');
    expect(html).toContain('maxLength="1200"');
  });

  it('disables the send button while the draft is blank', () => {
    expect(render({ draft: '   ' })).toMatch(/<button[^>]*disabled[^>]*>Send<\/button>/);
    expect(render({ draft: 'hi' })).not.toMatch(/<button[^>]*disabled[^>]*>Send<\/button>/);
  });

  it('shows the starting notice while the agent is starting', () => {
    expect(render({ isStarting: true, canSend: false })).toContain('Starting your agent');
  });

  it('keeps the composer enabled and says the message will be delivered once the agent is ready', () => {
    const html = render({ isStarting: true, canSend: false, draft: 'Watch BTC' });

    expect(html).toContain('Your message will be delivered as soon as your agent is ready.');
    expect(html).not.toContain('disabled');
  });

  it('shows a typing indicator naming the agent while it works on a message', () => {
    expect(render({ isAwaitingReply: true })).toContain('Tom is thinking…');
  });

  it('does not show a typing indicator when no reply is awaited', () => {
    expect(render()).not.toContain('is thinking');
  });

  it('explains the return from an approved connection while the agent resumes', () => {
    expect(render({ connectionBanner: true })).toContain('Connection approved. Tom is picking up where you left off…');
  });

  it('shows the post-start intro only when the agent can receive messages and it has not been dismissed', () => {
    expect(render({ canSend: true, showIntro: true })).toContain('just like you would a human employee');
    expect(render({ canSend: false, showIntro: true })).not.toContain('just like you would a human employee');
    expect(render({ canSend: true, showIntro: false })).not.toContain('just like you would a human employee');
  });

  it('renders no message rows when there are no messages', () => {
    expect(render({ messages: [] })).not.toContain('data-author=');
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

describe('bubbleAuthor', () => {
  it('tells the user, this agent, another agent and the platform apart', () => {
    expect(bubbleAuthor({ senderType: 'user', senderId: 'user-1' }, 'agent-1')).toBe('user');
    expect(bubbleAuthor({ senderType: 'agent', senderId: 'agent-1' }, 'agent-1')).toBe('agent');
    expect(bubbleAuthor({ senderType: 'agent', senderId: 'other' }, 'agent-1')).toBe('parent');
    expect(bubbleAuthor({ senderType: 'platform', senderId: null }, 'agent-1')).toBe('platform');
  });
});
