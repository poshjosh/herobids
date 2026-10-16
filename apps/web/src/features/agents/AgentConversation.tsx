import { useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type AgentOutboundMessage } from '../../lib/api-client.js';
import { Button, Card, SectionLabel } from '../../lib/ui.js';

const RUNNING_STATUSES = ['active', 'starting', 'paused', 'unhealthy'];

const HINT_STYLE: CSSProperties = { color: 'var(--color-text-muted)', fontSize: '0.8125rem' };

export function isAgentConversable(status: string): boolean {
  return RUNNING_STATUSES.includes(status);
}

/** Enter sends; Shift+Enter adds a line; Enter during IME composition does not send. */
export function isSendShortcut(key: string, shiftKey: boolean, isComposing: boolean): boolean {
  return key === 'Enter' && !shiftKey && !isComposing;
}

export interface AgentConversationViewProps {
  agentName: string;
  messages: AgentOutboundMessage[];
  canSend: boolean;
  draft: string;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

export function AgentConversationView({ agentName, messages, canSend, draft, isSending, onDraftChange, onSend }: AgentConversationViewProps) {
  const intl = useIntl();
  const trimmed = draft.trim();
  return (
    <Card>
      <SectionLabel prominent>{intl.formatMessage({ id: 'agentDetail.conversation.title' }, { name: agentName })}</SectionLabel>
      {messages.length === 0 ? (
        <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.empty' })}</p>
      ) : (
        <ul>
          {/* API returns newest first */}
          {[...messages].reverse().map((message) => (
            <li key={message.id}>
              <strong>{message.authoredBy === 'agent'
                ? intl.formatMessage({ id: 'agentDetail.conversation.fromAgent' })
                : intl.formatMessage({ id: 'agentDetail.conversation.fromPlatform' })}</strong>
              {' '}
              {message.body}
            </li>
          ))}
        </ul>
      )}
      {canSend ? null : <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.notRunning' })}</p>}
      <div
        style={{
          border: '1.5px solid var(--input-border-color)',
          borderRadius: '10px',
          background: 'var(--color-surface-3)',
          overflow: 'hidden',
          opacity: canSend ? 1 : 0.6,
        }}
      >
        <textarea
          aria-label={intl.formatMessage({ id: 'agentDetail.conversation.placeholder' })}
          placeholder={intl.formatMessage({ id: 'agentDetail.conversation.placeholder' })}
          value={draft}
          disabled={!canSend || isSending}
          maxLength={4000}
          rows={3}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (isSendShortcut(event.key, event.shiftKey, event.nativeEvent.isComposing) && canSend && !isSending && trimmed.length > 0) {
              event.preventDefault();
              onSend();
            }
          }}
          style={{
            width: '100%',
            minHeight: '72px',
            padding: '12px 14px',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-primary)',
            fontSize: '0.9375rem',
            outline: 'none',
            resize: 'vertical',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
            lineHeight: '1.6',
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '6px 12px',
            borderTop: '1px solid var(--color-border-subtle)',
          }}
        >
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{draft.length}/4000</span>
          <Button onClick={onSend} disabled={!canSend || isSending || trimmed.length === 0}>
            {intl.formatMessage({ id: 'agentDetail.conversation.send' })}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AgentConversation({ agentId, agentName, status }: { agentId: string; agentName: string; status: string }) {
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
      agentName={agentName}
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
