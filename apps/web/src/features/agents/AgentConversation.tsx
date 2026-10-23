import { useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type AgentOutboundMessage } from '../../lib/api-client.js';
import { Button, Card, SectionLabel } from '../../lib/ui.js';

const RUNNING_STATUSES = ['active', 'starting', 'paused', 'unhealthy'];

export const CONVERSATION_POLL_MS = 3000;

const HINT_STYLE: CSSProperties = { color: 'var(--color-text-muted)', fontSize: '0.8125rem' };

const NOTICE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '10px 12px',
  borderRadius: '8px',
  background: 'var(--color-brand-subtle)',
  fontSize: '0.875rem',
  lineHeight: '1.5',
};

/** Time only for messages from today; date and time for older ones. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatMessageTime(
  format: { formatDate: (value: Date, options: Intl.DateTimeFormatOptions) => string },
  iso: string,
  now: Date = new Date(),
): string {
  const when = new Date(iso);
  const options: Intl.DateTimeFormatOptions = isSameLocalDay(when, now)
    ? { timeStyle: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  return format.formatDate(when, options);
}

export const CONVERSATION_INTRO_STORAGE_PREFIX = 'agent-chat-intro-dismissed:';

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
  isStarting?: boolean;
  showIntro?: boolean;
  onDismissIntro?: () => void;
  draft: string;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

export function AgentConversationView({
  agentName, messages, canSend, isStarting = false, showIntro = false, onDismissIntro, draft, isSending, onDraftChange, onSend,
}: AgentConversationViewProps) {
  const intl = useIntl();
  const trimmed = draft.trim();
  return (
    <Card>
      <div style={{ border: canSend || isStarting ? '1.5px solid var(--color-brand)' : undefined, borderRadius: '10px', padding: '2px' }}>
      <SectionLabel prominent>{intl.formatMessage({ id: 'agentDetail.conversation.title' }, { name: agentName })}</SectionLabel>
      {isStarting && (
        <p role="status" style={{ ...NOTICE_STYLE, margin: '0 0 12px' }}>
          <span>{intl.formatMessage({ id: 'agentDetail.conversation.starting' })}</span>
        </p>
      )}
      {showIntro && canSend && (
        <div role="note" style={{ ...NOTICE_STYLE, margin: '0 0 12px', alignItems: 'flex-start' }}>
          <span>{intl.formatMessage({ id: 'agentDetail.conversation.intro' })}</span>
          {onDismissIntro && (
            <button
              type="button"
              onClick={onDismissIntro}
              aria-label={intl.formatMessage({ id: 'agentDetail.conversation.introClose' })}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                borderRadius: '4px',
                color: 'var(--color-text-muted)',
                fontSize: '1.125rem',
                lineHeight: '1',
                flexShrink: 0,
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}
      {messages.length === 0 ? (
        <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.empty' })}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* API returns newest first */}
          {[...messages].reverse().map((message) => {
            const fromUser = message.authoredBy === 'user';
            return (
              <div key={message.id} style={{ display: 'flex', justifyContent: fromUser ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                  background: fromUser ? 'var(--color-brand-subtle)' : 'var(--color-surface-2)',
                }}>
                  {!fromUser && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '2px' }}>
                      {message.authoredBy === 'agent'
                        ? agentName
                        : intl.formatMessage({ id: 'agentDetail.conversation.fromPlatform' })}
                    </div>
                  )}
                  {message.body}
                  <time
                    dateTime={message.createdAt}
                    title={intl.formatDate(message.createdAt, { dateStyle: 'full', timeStyle: 'medium' })}
                    style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: '4px', textAlign: fromUser ? 'end' : 'start' }}
                  >
                    {formatMessageTime(intl, message.createdAt)}
                  </time>
                </div>
              </div>
            );
          })}
        </div>
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
      </div>
    </Card>
  );
}

export function AgentConversation({ agentId, agentName, status }: { agentId: string; agentName: string; status: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const introKey = `${CONVERSATION_INTRO_STORAGE_PREFIX}${agentId}`;
  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return localStorage.getItem(introKey) === '1';
    } catch {
      return false;
    }
  });
  const messagesQuery = useQuery({
    queryKey: ['agent-conversation', agentId],
    queryFn: () => agentsApi.messages(agentId, 50),
    enabled: agentId.length > 0,
    refetchInterval: isAgentConversable(status) ? CONVERSATION_POLL_MS : false,
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
      isStarting={status === 'starting'}
      showIntro={!introDismissed}
      onDismissIntro={() => {
        try {
          localStorage.setItem(introKey, '1');
        } catch {
          // Storage unavailable: the banner simply reappears next visit.
        }
        setIntroDismissed(true);
      }}
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
