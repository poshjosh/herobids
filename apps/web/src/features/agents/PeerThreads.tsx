import { useEffect, useState, type CSSProperties } from 'react';
import { useIntl } from 'react-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { agents as agentsApi, type PeerMessage, type PeerThreadSummary } from '../../lib/api-client.js';
import { Button, Card, SectionLabel } from '../../lib/ui.js';
import { Linkify } from '../../lib/linkify.js';
import { CONVERSATION_POLL_MS, formatMessageTime } from './AgentConversation.js';
import { mergePeerMessages, peerMessageSide, refusalReasonKey } from './peer-thread.js';

const HINT_STYLE: CSSProperties = { color: 'var(--color-text-muted)', fontSize: '0.8125rem' };
const LABEL_STYLE: CSSProperties = {
  fontSize: '0.6875rem',
  padding: '1px 6px',
  borderRadius: '999px',
  background: 'var(--color-surface-3)',
  color: 'var(--color-text-muted)',
  whiteSpace: 'nowrap',
};

interface PeerThreadsProps {
  agentId: string;
  agentName: string;
}

export function PeerThreads({ agentId, agentName }: PeerThreadsProps) {
  const intl = useIntl();
  const [openPeerId, setOpenPeerId] = useState<string | null>(null);
  const threadsQuery = useQuery({
    queryKey: ['agent-peer-threads', agentId],
    queryFn: () => agentsApi.peerThreads(agentId),
    enabled: agentId.length > 0,
    refetchInterval: CONVERSATION_POLL_MS,
  });
  const threads = threadsQuery.data?.threads ?? [];
  if (threads.length === 0) return null;

  const openThread = threads.find((thread) => thread.peerAgentId === openPeerId) ?? null;
  const peerName = (thread: PeerThreadSummary) =>
    thread.peerAgentName ?? intl.formatMessage({ id: 'agentDetail.peerThreads.unknownAgent' });

  return (
    <Card>
      <SectionLabel prominent>{intl.formatMessage({ id: 'agentDetail.peerThreads.title' })}</SectionLabel>
      <p style={{ ...HINT_STYLE, margin: '0 0 12px' }}>
        {intl.formatMessage({ id: 'agentDetail.peerThreads.description' }, { name: agentName })}
      </p>
      {openThread ? (
        <PeerThreadView
          key={openThread.peerAgentId}
          agentId={agentId}
          agentName={agentName}
          peerAgentId={openThread.peerAgentId}
          peerName={peerName(openThread)}
          onBack={() => setOpenPeerId(null)}
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {threads.map((thread) => (
            <li key={thread.peerAgentId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.875rem', fontWeight: 500, overflowWrap: 'anywhere' }}>{peerName(thread)}</span>
                  <span style={LABEL_STYLE}>{intl.formatMessage({ id: 'agentDetail.peerThreads.label' })}</span>
                </div>
                <div style={HINT_STYLE}>
                  {thread.lastMessageAt
                    ? intl.formatMessage({ id: 'agentDetail.peerThreads.lastMessage' }, { time: formatMessageTime(intl, thread.lastMessageAt) })
                    : intl.formatMessage({ id: 'agentDetail.peerThreads.noMessages' })}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOpenPeerId(thread.peerAgentId)}>
                {intl.formatMessage({ id: 'agentDetail.peerThreads.open' })}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface PeerThreadViewProps extends PeerThreadsProps {
  peerAgentId: string;
  peerName: string;
  onBack: () => void;
}

function PeerThreadView({ agentId, agentName, peerAgentId, peerName, onBack }: PeerThreadViewProps) {
  const intl = useIntl();
  const [history, setHistory] = useState<PeerMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const pageQuery = useQuery({
    queryKey: ['agent-peer-thread', agentId, peerAgentId],
    queryFn: () => agentsApi.peerThread(agentId, peerAgentId),
    refetchInterval: CONVERSATION_POLL_MS,
    refetchOnMount: 'always',
  });
  const latestPage = pageQuery.data;
  useEffect(() => {
    if (latestPage) setHistory((previous) => mergePeerMessages(previous, latestPage.messages));
  }, [latestPage]);
  // Until an older page is loaded, the next older page starts at the newest page's cursor.
  const earlierCursor = olderCursor === undefined ? (latestPage?.nextCursor ?? null) : olderCursor;
  const earlierMutation = useMutation({
    mutationFn: (before: string) => agentsApi.peerThread(agentId, peerAgentId, { before }),
    onSuccess: (page) => {
      setHistory((previous) => mergePeerMessages(previous, page.messages));
      setOlderCursor(page.nextCursor);
    },
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>
            {intl.formatMessage({ id: 'agentDetail.peerThreads.threadTitle' }, { name: agentName, peer: peerName })}
          </span>
          <span style={LABEL_STYLE}>{intl.formatMessage({ id: 'agentDetail.peerThreads.label' })}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {intl.formatMessage({ id: 'agentDetail.peerThreads.back' })}
        </Button>
      </div>
      {pageQuery.isError && history.length === 0 ? (
        <p role="alert" style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.peerThreads.loadError' })}</p>
      ) : history.length === 0 && !pageQuery.isPending ? (
        <p style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.peerThreads.empty' })}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '420px', overflowY: 'auto', overflowX: 'hidden' }}>
          {earlierCursor !== null && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
              {earlierMutation.isError && !earlierMutation.isPending && (
                <span role="alert" style={HINT_STYLE}>{intl.formatMessage({ id: 'agentDetail.peerThreads.loadError' })}</span>
              )}
              <Button variant="ghost" size="sm" onClick={() => earlierMutation.mutate(earlierCursor)} disabled={earlierMutation.isPending}>
                {intl.formatMessage({ id: 'agentDetail.peerThreads.loadEarlier' })}
              </Button>
            </div>
          )}
          {history.map((message) => {
            const fromSelf = peerMessageSide(message, agentId) === 'self';
            const refused = message.deliveryStatus === 'refused';
            return (
              <div key={message.id} data-side={fromSelf ? 'self' : 'peer'} style={{ display: 'flex', justifyContent: fromSelf ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  padding: '8px 12px',
                  borderRadius: '12px',
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  maxWidth: '85%',
                  background: fromSelf ? 'var(--color-brand-subtle)' : 'var(--color-surface-2)',
                }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '2px' }}>
                    {fromSelf ? agentName : peerName}
                  </div>
                  <Linkify text={message.body} />
                  <time
                    dateTime={message.createdAt}
                    title={intl.formatDate(message.createdAt, { dateStyle: 'full', timeStyle: 'medium' })}
                    style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: '4px' }}
                  >
                    {formatMessageTime(intl, message.createdAt)}
                  </time>
                  {refused && (
                    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px', fontSize: '0.75rem', color: 'var(--color-danger, #c0392b)' }}>
                      <strong>{intl.formatMessage({ id: 'agentDetail.peerThreads.refused' })}</strong>
                      <span>{intl.formatMessage({ id: refusalReasonKey(message.refusalReason) })}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
