import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type AgentConversationMessage } from '../../lib/api-client.js';
import { Button, Card, SectionLabel } from '../../lib/ui.js';
import { Linkify } from '../../lib/linkify.js';
import { buildThread, mergeMessages, type PendingSend } from './conversation-thread.js';

const RUNNING_STATUSES = ['active', 'starting', 'paused', 'unhealthy'];

export const CONVERSATION_POLL_MS = 3000;
export const STILL_STARTING_AFTER_MS = 15_000;
export const STARTING_STUCK_AFTER_MS = 120_000;

/** Used until the first page of the thread reports the server's configured limit. */
export const DEFAULT_MESSAGE_MAX_CHARS = 4000;

const HINT_STYLE: CSSProperties = { color: 'var(--color-text-muted)', fontSize: '0.8125rem' };

// Untagged platform messages predate messageClass and were all safety alerts.
function isSafetyAlert(message: AgentConversationMessage): boolean {
  return message.messageClass === null || message.messageClass === undefined || message.messageClass === 'alert';
}

const SPINNER_STYLE: CSSProperties = {
  display: 'inline-block',
  flexShrink: 0,
  width: '14px',
  height: '14px',
  border: '2px solid var(--color-surface-3)',
  borderTopColor: 'var(--color-brand)',
  borderRadius: '50%',
  animation: 'spin 0.7s linear infinite',
};

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

export function startingPhase(elapsedMs: number): 'starting' | 'slow' | 'stuck' {
  if (elapsedMs >= STARTING_STUCK_AFTER_MS) return 'stuck';
  if (elapsedMs >= STILL_STARTING_AFTER_MS) return 'slow';
  return 'starting';
}

/** Seconds since the agent entered `starting`; resets each time it starts again. */
function useStartingElapsed(isStarting: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isStarting) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [isStarting]);
  return elapsed;
}

export type BubbleAuthor = 'user' | 'agent' | 'parent' | 'platform';

/** Who a bubble is from. An agent row written by another agent (a creator messaging its child) is not this agent. */
export function bubbleAuthor(message: Pick<AgentConversationMessage, 'senderType' | 'senderId'>, agentId: string): BubbleAuthor {
  if (message.senderType === 'user') return 'user';
  if (message.senderType === 'platform') return 'platform';
  return message.senderId === null || message.senderId === agentId ? 'agent' : 'parent';
}

export interface AgentConversationViewProps {
  agentId?: string;
  agentName: string;
  /** Oldest first. */
  messages: AgentConversationMessage[];
  canSend: boolean;
  isStarting?: boolean;
  showIntro?: boolean;
  onDismissIntro?: () => void;
  draft: string;
  maxChars?: number;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** Resends a message that was not delivered, under the same id. */
  onRetryMessage?: (messageId: string) => void;
  /** The thread could not be loaded and nothing is shown yet. */
  loadFailed?: boolean;
  /** Loading an older page failed; the Show earlier button retries it. */
  loadEarlierFailed?: boolean;
  onLoadEarlier?: () => void;
  isLoadingEarlier?: boolean;
  /** The agent is working on a message; shows a typing indicator in the thread. */
  isAwaitingReply?: boolean;
  /** Explains a return from an approved connection request while the agent resumes. */
  connectionBanner?: boolean;
  onRetry?: () => void;
}

export function AgentConversationView({
  agentId = '', agentName, messages, canSend, isStarting = false, showIntro = false, onDismissIntro, draft, maxChars = DEFAULT_MESSAGE_MAX_CHARS,
  onDraftChange, onSend, onRetryMessage, loadFailed = false, loadEarlierFailed = false, onLoadEarlier, isLoadingEarlier = false,
  isAwaitingReply = false, connectionBanner = false, onRetry,
}: AgentConversationViewProps) {
  const intl = useIntl();
  const trimmed = draft.trim();
  const listRef = useRef<HTMLDivElement>(null);
  const elapsed = useStartingElapsed(isStarting);
  const phase = startingPhase(elapsed);
  // Messages can be queued while the agent starts; the agent picks them up once it is ready.
  const canCompose = canSend || isStarting;
  // Pin the list to the newest message. Loading earlier messages leaves the newest unchanged, so it does not jump.
  const newestId = messages[messages.length - 1]?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [newestId, isAwaitingReply]);
  return (
    <Card className="agent-conversation-card">
      <div style={{ border: canCompose ? '1.5px solid var(--color-brand)' : undefined, borderRadius: '10px', padding: '2px' }}>
      <SectionLabel prominent>{intl.formatMessage({ id: 'agentDetail.conversation.title' }, { name: agentName })}</SectionLabel>
      {connectionBanner && (
        <div role="status" style={{ ...NOTICE_STYLE, margin: '0 0 12px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span aria-hidden="true" style={SPINNER_STYLE} />
            <span>{intl.formatMessage({ id: 'agentDetail.conversation.connectionApproved' }, { name: agentName })}</span>
          </span>
        </div>
      )}
      {isStarting && (
        <div role="status" style={{ ...NOTICE_STYLE, margin: '0 0 12px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span aria-hidden="true" style={SPINNER_STYLE} />
            <span>
              {intl.formatMessage({
                id: phase === 'stuck'
                  ? 'agentDetail.conversation.startingStuck'
                  : phase === 'slow' ? 'agentDetail.conversation.startingSlow' : 'agentDetail.conversation.starting',
              })}
            </span>
          </span>
          {phase === 'stuck' && onRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {intl.formatMessage({ id: 'agentDetail.conversation.retry' })}
            </Button>
          )}
        </div>
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
      {loadFailed && messages.length === 0 ? (
        <p role="alert" style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.loadError' })}</p>
      ) : messages.length === 0 && !isAwaitingReply ? (
        <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.empty' })}</p>
      ) : (
        <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '420px', overflowY: 'auto', overflowX: 'hidden' }}>
          {onLoadEarlier && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              {loadEarlierFailed && !isLoadingEarlier && (
                <span role="alert" style={{ ...HINT_STYLE, alignSelf: 'center', marginRight: '8px' }}>
                  {intl.formatMessage({ id: 'agentDetail.conversation.loadError' })}
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={onLoadEarlier} disabled={isLoadingEarlier}>
                {intl.formatMessage({ id: 'agentDetail.conversation.loadEarlier' })}
              </Button>
            </div>
          )}
          {messages.map((message) => {
            const author = bubbleAuthor(message, agentId);
            const fromUser = author === 'user';
            // A queued row the server marks stuck was never published (the sender's retry re-publishes it): offer Retry, not a spinner.
            const stuck = message.deliveryStatus === 'queued' && message.stuck === true;
            // A refused message is final (the server will not republish it), so it shows "Not sent" without Retry.
            const canRetry = message.deliveryStatus === 'failed' || stuck;
            const notDelivered = fromUser && (canRetry || message.deliveryStatus === 'refused');
            const sending = fromUser && message.deliveryStatus === 'queued' && !stuck;
            return (
              <div
                key={message.id}
                data-author={author}
                style={{ display: 'flex', justifyContent: fromUser ? 'flex-end' : author === 'platform' ? 'center' : 'flex-start' }}
              >
                <div className="agent-message-bubble" style={{
                  padding: '8px 12px',
                  borderRadius: '12px',
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  background: fromUser ? 'var(--color-brand-subtle)' : 'var(--color-surface-2)',
                  opacity: sending ? 0.7 : 1,
                }}>
                  {!fromUser && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '2px' }}>
                      {author === 'agent'
                        ? agentName
                        : author === 'parent'
                          ? intl.formatMessage({ id: 'agentDetail.conversation.fromParentAgent' })
                          : intl.formatMessage({ id: isSafetyAlert(message) ? 'agentDetail.conversation.fromPlatform' : 'agentDetail.conversation.fromOpenAIdom' })}
                    </div>
                  )}
                  <Linkify text={message.body} />
                  <time
                    dateTime={message.createdAt}
                    title={intl.formatDate(message.createdAt, { dateStyle: 'full', timeStyle: 'medium' })}
                    style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: '4px', textAlign: fromUser ? 'end' : 'start' }}
                  >
                    {formatMessageTime(intl, message.createdAt)}
                  </time>
                  {sending && (
                    <div role="status" style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', textAlign: 'end' }}>
                      {intl.formatMessage({ id: 'agentDetail.conversation.sending' })}
                    </div>
                  )}
                  {notDelivered && (
                    <div role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', fontSize: '0.75rem', color: 'var(--color-danger, #c0392b)' }}>
                      <span>{intl.formatMessage({ id: 'agentDetail.conversation.notSent' })}</span>
                      {onRetryMessage && canRetry && (
                        <Button variant="ghost" size="sm" onClick={() => onRetryMessage(message.id)}>
                          {intl.formatMessage({ id: 'agentDetail.conversation.retry' })}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {isAwaitingReply && (
            <div role="status" aria-live="polite" style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                borderRadius: '12px',
                fontSize: '0.875rem',
                color: 'var(--color-text-muted)',
                background: 'var(--color-surface-2)',
              }}>
                <span aria-hidden="true" style={{ display: 'inline-flex', gap: '3px' }}>
                  {[0, 1, 2].map((dot) => (
                    <span key={dot} style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor', animation: `pulse 1.2s ease-in-out ${dot * 0.2}s infinite` }} />
                  ))}
                </span>
                <span>{intl.formatMessage({ id: 'agentDetail.conversation.thinking' }, { name: agentName })}</span>
              </div>
            </div>
          )}
        </div>
      )}
      {isStarting ? <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.queuedHint' })}</p> : null}
      {canSend || isStarting ? null : <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.conversation.notRunning' })}</p>}
      <div
        style={{
          border: '1.5px solid var(--input-border-color)',
          borderRadius: '10px',
          background: 'var(--color-surface-3)',
          overflow: 'hidden',
          opacity: canCompose ? 1 : 0.6,
        }}
      >
        <textarea
          aria-label={intl.formatMessage({ id: 'agentDetail.conversation.placeholder' })}
          placeholder={intl.formatMessage({ id: 'agentDetail.conversation.placeholder' })}
          value={draft}
          disabled={!canCompose}
          maxLength={maxChars}
          rows={3}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (isSendShortcut(event.key, event.shiftKey, event.nativeEvent.isComposing) && canCompose && trimmed.length > 0) {
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
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{draft.length}/{maxChars}</span>
          <Button onClick={onSend} disabled={!canCompose || trimmed.length === 0}>
            {intl.formatMessage({ id: 'agentDetail.conversation.send' })}
          </Button>
        </div>
      </div>
      </div>
    </Card>
  );
}

export function AgentConversation({ agentId, agentName, status, connectionRequestId = null }: {
  agentId: string;
  agentName: string;
  status: string;
  /** Set when returning from an approved connection request; the agent is resuming for it. */
  connectionRequestId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  // Every row fetched so far. The newest page is polled and slides forward, so rows are kept here, not re-derived.
  const [history, setHistory] = useState<AgentConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const introKey = `${CONVERSATION_INTRO_STORAGE_PREFIX}${agentId}`;
  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return localStorage.getItem(introKey) === '1';
    } catch {
      return false;
    }
  });
  const conversable = isAgentConversable(status);
  const threadQuery = useQuery({
    queryKey: ['agent-conversation', agentId],
    queryFn: () => agentsApi.conversation(agentId),
    enabled: agentId.length > 0,
    // Polls only while the agent runs. react-query pauses interval refetches while the tab is hidden.
    refetchInterval: conversable ? CONVERSATION_POLL_MS : false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const latestPage = threadQuery.data;
  useEffect(() => {
    if (latestPage) setHistory((previous) => mergeMessages(previous, latestPage.messages));
  }, [latestPage]);
  // Before any older page is loaded the next older page starts at the newest page's cursor.
  const earlierCursor = olderCursor === undefined ? (latestPage?.nextCursor ?? null) : olderCursor;
  const earlierMutation = useMutation({
    mutationFn: (before: string) => agentsApi.conversation(agentId, { before }),
    onSuccess: (page) => {
      setHistory((previous) => mergeMessages(previous, page.messages));
      setOlderCursor(page.nextCursor);
    },
    // On failure the cursor is unchanged, so the same button retries the same page; the view shows `isError`.
  });
  // Server-derived from the runtime's tick events, so it reflects when the agent actually picks the request up.
  const turnQuery = useQuery({
    queryKey: ['agent-conversation-turn', agentId, connectionRequestId],
    queryFn: () => agentsApi.conversationTurn(agentId, connectionRequestId ?? undefined),
    enabled: agentId.length > 0,
    refetchInterval: conversable ? CONVERSATION_POLL_MS : false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const sendMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => agentsApi.sendMessage(agentId, body, id),
    onSuccess: async (result, { id }) => {
      // Show the stored row at once; the next poll confirms it.
      setHistory((previous) => mergeMessages(previous, [result.message]));
      setPending((previous) => previous.filter((entry) => entry.id !== id));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-conversation', agentId] }),
        queryClient.invalidateQueries({ queryKey: ['agent-conversation-turn', agentId] }),
      ]);
    },
    onError: (_error, { id }) => {
      setPending((previous) => previous.map((entry) => (entry.id === id ? { ...entry, status: 'failed' } : entry)));
      // A failed publish leaves a failed row on the server; fetch it so a reload shows the same state.
      void queryClient.invalidateQueries({ queryKey: ['agent-conversation', agentId] });
    },
  });

  const submit = (id: string, body: string) => {
    setPending((previous) => (
      previous.some((entry) => entry.id === id)
        ? previous.map((entry) => (entry.id === id ? { ...entry, status: 'sending' } : entry))
        : [...previous, { id, body, createdAt: new Date().toISOString(), status: 'sending' }]
    ));
    sendMutation.mutate({ id, body });
  };

  const turn = conversable ? turnQuery.data : undefined;
  const awaitingReply = turn?.message === 'working' || turn?.connection === 'working';
  const connectionPending = connectionRequestId !== null && (turn?.connection === 'queued' || turn?.connection === 'working');
  const thread = buildThread(history, pending);

  return (
    <AgentConversationView
      agentId={agentId}
      agentName={agentName}
      messages={thread}
      maxChars={latestPage?.maxMessageChars ?? DEFAULT_MESSAGE_MAX_CHARS}
      canSend={conversable}
      isStarting={status === 'starting'}
      isAwaitingReply={awaitingReply}
      connectionBanner={connectionPending}
      loadFailed={threadQuery.isError}
      onLoadEarlier={earlierCursor === null ? undefined : () => earlierMutation.mutate(earlierCursor)}
      isLoadingEarlier={earlierMutation.isPending}
      loadEarlierFailed={earlierMutation.isError}
      onRetry={() => {
        void queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
        void queryClient.invalidateQueries({ queryKey: ['agent-conversation', agentId] });
        void queryClient.invalidateQueries({ queryKey: ['agent-conversation-turn', agentId] });
      }}
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
      onDraftChange={setDraft}
      onSend={() => {
        const body = draft.trim();
        if (body.length === 0) return;
        setDraft('');
        submit(crypto.randomUUID(), body);
      }}
      onRetryMessage={(messageId) => {
        const original = thread.find((message) => message.id === messageId);
        if (original) submit(messageId, original.body);
      }}
    />
  );
}
