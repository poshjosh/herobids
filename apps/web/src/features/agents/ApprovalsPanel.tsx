import { useState, useCallback, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, type DecisionApproval } from '../../lib/api-client.js';
import { Card, Button, LoadingRows, ErrorState, SectionLabel } from '../../lib/ui.js';

interface ApprovalsPanelProps {
  agentId: string;
  renderProposalDetails: (approval: DecisionApproval) => ReactNode;
}

export function ApprovalsPanel({ agentId, renderProposalDetails }: ApprovalsPanelProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [resolved, setResolved] = useState<Map<string, { action: 'approved' | 'rejected'; executionStatus: string | null }>>(new Map());

  const approvalsQuery = useQuery({
    queryKey: ['agents', agentId, 'approvals'],
    queryFn: () => agentsApi.approvals.list(agentId, 'pending'),
    refetchInterval: 30_000,
  });

  const approveMutation = useMutation({
    mutationFn: (approvalId: string) => agentsApi.approvals.approve(agentId, approvalId),
    onSuccess: (data, approvalId) => {
      setResolved((prev) => new Map(prev).set(approvalId, { action: 'approved', executionStatus: data.executionStatus }));
      void qc.invalidateQueries({ queryKey: ['agents', agentId, 'approvals'] });
      void qc.invalidateQueries({ queryKey: ['agents', agentId, 'activity-feed'] });
    },
    onError: (error: Error, approvalId) => {
      setActionErrors((prev) => ({ ...prev, [approvalId]: error.message }));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (approvalId: string) => agentsApi.approvals.reject(agentId, approvalId),
    onSuccess: (data, approvalId) => {
      setResolved((prev) => new Map(prev).set(approvalId, { action: 'rejected', executionStatus: data.executionStatus }));
      void qc.invalidateQueries({ queryKey: ['agents', agentId, 'approvals'] });
    },
    onError: (error: Error, approvalId) => {
      setActionErrors((prev) => ({ ...prev, [approvalId]: error.message }));
    },
  });

  const clearActionError = useCallback((approvalId: string) => {
    setActionErrors((prev) => {
      if (!(approvalId in prev)) return prev;
      const next = { ...prev };
      delete next[approvalId];
      return next;
    });
  }, []);

  const formatExpiry = (expiresAt: string): string => {
    return intl.formatDate(expiresAt, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  };

  const pendingApprovals = (approvalsQuery.data?.approvals ?? []).filter(
    (a) => a.status === 'pending' && !resolved.has(a.id),
  );

  if (approvalsQuery.isLoading) {
    return (
      <Card>
        <SectionLabel>{intl.formatMessage({ id: 'agents.approvals.title' })}</SectionLabel>
        <LoadingRows count={3} />
      </Card>
    );
  }

  if (approvalsQuery.isError) {
    return (
      <Card>
        <SectionLabel>{intl.formatMessage({ id: 'agents.approvals.title' })}</SectionLabel>
        <ErrorState
          message={intl.formatMessage({ id: 'agents.approvals.loadError' })}
          onRetry={() => void approvalsQuery.refetch()}
        />
      </Card>
    );
  }

  if (pendingApprovals.length === 0) {
    return (
      <Card>
        <SectionLabel>{intl.formatMessage({ id: 'agents.approvals.title' })}</SectionLabel>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 }}>
          {intl.formatMessage({ id: 'agents.approvals.empty' })}
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionLabel>{intl.formatMessage({ id: 'agents.approvals.title' })}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {pendingApprovals.map((approval) => {
          const isApproving = approveMutation.isPending && approveMutation.variables === approval.id;
          const isRejecting = rejectMutation.isPending && rejectMutation.variables === approval.id;
          const error = actionErrors[approval.id];
          const resolvedData = resolved.get(approval.id);
          const isResolved = !!resolvedData;

          return (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              isApproving={isApproving}
              isRejecting={isRejecting}
              isResolved={isResolved}
              resolvedAction={resolvedData?.action ?? null}
              resolvedExecutionStatus={resolvedData?.executionStatus ?? null}
              error={error}
              onApprove={() => {
                clearActionError(approval.id);
                approveMutation.mutate(approval.id);
              }}
              onReject={() => {
                clearActionError(approval.id);
                rejectMutation.mutate(approval.id);
              }}
              proposalDetails={renderProposalDetails(approval)}
              formatExpiry={formatExpiry}
              intl={intl}
            />
          );
        })}
      </div>
    </Card>
  );
}

interface ApprovalCardProps {
  approval: DecisionApproval;
  isApproving: boolean;
  isRejecting: boolean;
  isResolved: boolean;
  resolvedAction: 'approved' | 'rejected' | null;
  resolvedExecutionStatus: string | null;
  error: string | undefined;
  onApprove: () => void;
  onReject: () => void;
  proposalDetails: ReactNode;
  formatExpiry: (expiresAt: string) => string;
  intl: ReturnType<typeof useIntl>;
}

function ApprovalCard({
  approval,
  isApproving,
  isRejecting,
  isResolved,
  resolvedAction,
  resolvedExecutionStatus,
  error,
  onApprove,
  onReject,
  proposalDetails,
  formatExpiry,
  intl,
}: ApprovalCardProps) {
  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '8px',
        border: '1px solid var(--color-border)',
        background: isResolved ? 'var(--color-success-subtle)' : 'var(--color-surface-1)',
        opacity: isResolved ? 0.7 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      {/* Short code + expiry header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
        }}
      >
        <span
          style={{
            fontSize: '0.875rem',
            fontWeight: '700',
            fontFamily: 'monospace',
            color: 'var(--color-brand)',
            background: 'var(--color-brand-subtle, rgba(99,102,241,0.1))',
            padding: '4px 10px',
            borderRadius: '6px',
            letterSpacing: '0.08em',
          }}
        >
          {approval.shortCode}
        </span>
        <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
          {intl.formatMessage({ id: 'agents.approvals.expires' }, { time: formatExpiry(approval.expiresAt) })}
        </span>
      </div>

      {proposalDetails}

      {/* Telegram hint */}
      <div
        style={{
          fontSize: '0.6875rem',
          color: 'var(--color-text-muted)',
          marginBottom: '12px',
          padding: '6px 10px',
          borderRadius: '4px',
          background: 'var(--color-surface-2)',
          fontFamily: 'monospace',
        }}
      >
        {intl.formatMessage({ id: 'agents.approvals.telegramHint' }, { code: approval.shortCode })}
      </div>

      {/* Action buttons */}
      {!isResolved && (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            variant="primary"
            size="sm"
            disabled={isApproving || isRejecting}
            onClick={onApprove}
          >
            {isApproving
              ? intl.formatMessage({ id: 'agents.approvals.approving' })
              : intl.formatMessage({ id: 'agents.approvals.approve' })}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={isApproving || isRejecting}
            onClick={onReject}
          >
            {isRejecting
              ? intl.formatMessage({ id: 'agents.approvals.rejecting' })
              : intl.formatMessage({ id: 'agents.approvals.reject' })}
          </Button>
        </div>
      )}

      {/* Success state */}
      {isResolved && !error && (
        <div
          style={{
            fontSize: '0.75rem',
            padding: '6px 10px',
            borderRadius: '4px',
            background: resolvedAction === 'rejected'
              ? 'var(--color-surface-2)'
              : 'var(--color-success-subtle)',
            color: resolvedAction === 'rejected'
              ? 'var(--color-text-secondary)'
              : 'var(--color-success)',
            fontWeight: '500',
          }}
        >
          {resolvedAction === 'rejected'
            ? intl.formatMessage({ id: 'agents.approvals.rejected' })
            : resolvedExecutionStatus === 'accepted'
              ? intl.formatMessage({ id: 'agents.approvals.executionAccepted' })
              : resolvedExecutionStatus === 'rejected'
                ? intl.formatMessage({ id: 'agents.approvals.executionRejected' })
                : resolvedExecutionStatus === 'error'
                  ? intl.formatMessage({ id: 'agents.approvals.executionError' })
                  : intl.formatMessage({ id: 'agents.approvals.executionAwaiting' })}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          style={{
            fontSize: '0.75rem',
            padding: '6px 10px',
            borderRadius: '4px',
            background: 'var(--color-danger-subtle)',
            color: 'var(--color-danger)',
            marginTop: isResolved ? '0' : '8px',
          }}
        >
          {intl.formatMessage({ id: 'agents.approvals.actionError' }, { message: error })}
        </div>
      )}
    </div>
  );
}
