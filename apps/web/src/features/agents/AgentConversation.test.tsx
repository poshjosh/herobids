import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it, vi } from 'vitest';
import { AgentConversationView, isAgentConversable } from './AgentConversation.js';
import type { AgentOutboundMessage } from '../../lib/api-client.js';

const messages: AgentOutboundMessage[] = [{
  id: 'm1',
  agentId: 'agent-1',
  sessionId: null,
  authoredBy: 'agent',
  subject: null,
  body: 'Watching ETH.',
  contextRef: null,
  messageClass: 'routine',
  deliveryStatus: 'sent',
  emailDeliveryStatus: 'feed_only',
} as unknown as AgentOutboundMessage];

const englishMessages: Record<string, string> = {
  'agentDetail.conversation.title': 'Talk to your agent',
  'agentDetail.conversation.placeholder': 'Message your agent',
  'agentDetail.conversation.send': 'Send',
  'agentDetail.conversation.empty': 'No messages yet.',
  'agentDetail.conversation.notRunning': 'Start your agent to talk to it.',
  'agentDetail.conversation.fromAgent': 'Agent',
  'agentDetail.conversation.fromYou': 'You',
};

function render(props: Partial<Parameters<typeof AgentConversationView>[0]> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={englishMessages}>
      <AgentConversationView
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

  it('shows the empty state when there are no messages', () => {
    expect(render({ messages: [] })).toContain('No messages yet.');
  });
});
