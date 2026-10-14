import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type AgentOutboundMessage } from '../../lib/api-client.js';
import { Button, Card, SectionLabel } from '../../lib/ui.js';

const RUNNING_STATUSES = ['active', 'starting', 'paused', 'unhealthy'];

export function isAgentConversable(status: string): boolean {
  return RUNNING_STATUSES.includes(status);
}

export interface AgentConversationViewProps {
  messages: AgentOutboundMessage[];
  canSend: boolean;
  draft: string;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

export function AgentConversationView({ messages, canSend, draft, isSending, onDraftChange, onSend }: AgentConversationViewProps) {
  const intl = useIntl();
  const trimmed = draft.trim();
  return (
    <Card>
      <SectionLabel>{intl.formatMessage({ id: 'agentDetail.conversation.title' })}</SectionLabel>
      {messages.length === 0 ? (
        <p>{intl.formatMessage({ id: 'agentDetail.conversation.empty' })}</p>
      ) : (
        <ul>
          {messages.map((message) => (
            <li key={message.id}>
              <strong>{message.authoredBy === 'agent'
                ? intl.formatMessage({ id: 'agentDetail.conversation.fromAgent' })
                : intl.formatMessage({ id: 'agentDetail.conversation.fromYou' })}</strong>
              {' '}
              {message.body}
            </li>
          ))}
        </ul>
      )}
      {canSend ? null : <p>{intl.formatMessage({ id: 'agentDetail.conversation.notRunning' })}</p>}
      <textarea
        aria-label={intl.formatMessage({ id: 'agentDetail.conversation.placeholder' })}
        placeholder={intl.formatMessage({ id: 'agentDetail.conversation.placeholder' })}
        value={draft}
        disabled={!canSend || isSending}
        maxLength={4000}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <Button onClick={onSend} disabled={!canSend || isSending || trimmed.length === 0}>
        {intl.formatMessage({ id: 'agentDetail.conversation.send' })}
      </Button>
    </Card>
  );
}

export function AgentConversation({ agentId, status }: { agentId: string; status: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const messagesQuery = useQuery({
    queryKey: ['agent-conversation', agentId],
    queryFn: () => agentsApi.messages(agentId, 50),
    enabled: agentId.length > 0,
  });
  const sendMutation = useMutation({
    mutationFn: (message: string) => agentsApi.sendMessage(agentId, message),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['agent-conversation', agentId] });
    },
  });

  return (
    <AgentConversationView
      messages={messagesQuery.data ?? []}
      canSend={isAgentConversable(status)}
      draft={draft}
      isSending={sendMutation.isPending}
      onDraftChange={setDraft}
      onSend={() => {
        const message = draft.trim();
        if (message.length > 0) sendMutation.mutate(message);
      }}
    />
  );
}
