import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import {
  agents as agentsApi,
  ApiError,
} from '../../lib/api-client.js';
import {
  Card,
  Button,
  StatusBadge,
  RelativeTime,
  ErrorState,
  EmptyState,
  LoadingRows,
} from '../../lib/ui.js';
import { AgentEvaluationReport } from './AgentEvaluationReport.js';
import type {
  EvaluationRunRecord,
  EvaluationFinding,
  EvaluationScope,
} from '@herobids/domain';

// ─── Helpers ───────────────────────────────────────────────────────────────

const SCORE_COLORS = {
  green: { bg: 'var(--color-success-subtle)', text: 'var(--color-success)' },
  yellow: { bg: 'var(--color-warning-subtle)', text: 'var(--color-warning)' },
  red: { bg: 'var(--color-danger-subtle)', text: 'var(--color-danger)' },
};

function scoreColor(score: number): { bg: string; text: string } {
  if (score >= 80) return SCORE_COLORS.green;
  if (score >= 50) return SCORE_COLORS.yellow;
  return SCORE_COLORS.red;
}

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};

function formatScopeType(type: string): string {
  const map: Record<string, string> = {
    latestSession: 'Latest session',
    session: 'Session',
    timeRange: 'Time range',
    allTime: 'All time',
  };
  return map[type] ?? type;
}

// ─── ScoreGauge ─────────────────────────────────────────────────────────────

function ScoreGauge({ score, size = 'lg' }: { score: number; size?: 'sm' | 'lg' }) {
  const colors = scoreColor(score);
  const dim = size === 'sm' ? 48 : 72;
  const fontSize = size === 'sm' ? '14px' : '22px';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      <div
        style={{
          width: dim,
          height: dim,
          borderRadius: '50%',
          background: `conic-gradient(${colors.text} ${(score / 100) * 360}deg, var(--color-surface-2) 0deg)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: dim * 0.7,
            height: dim * 0.7,
            borderRadius: '50%',
            background: 'var(--color-surface-1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ fontSize, fontWeight: 700, color: colors.text }}>
            {Math.round(score)}
          </span>
        </div>
      </div>
      {size === 'lg' && (
        <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          out of 100
        </span>
      )}
    </div>
  );
}

// ─── FindingRow ─────────────────────────────────────────────────────────────

function FindingRow({ finding }: { finding: EvaluationFinding }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: '6px',
        background: 'var(--color-surface-2)',
        fontSize: '13px',
        cursor: 'pointer',
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span>{SEVERITY_ICONS[finding.severity] ?? '⚪'}</span>
        <code style={{ fontSize: '11px', color: 'var(--color-text-muted)', background: 'var(--color-surface-3)', padding: '1px 5px', borderRadius: '4px' }}>
          {finding.code}
        </code>
        <span style={{ fontWeight: 500 }}>{finding.title}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: '6px', paddingLeft: '22px', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
          {finding.detail}
          {finding.evidence && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--color-text-muted)' }}>
              Evidence: {finding.evidence}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RunDetail ──────────────────────────────────────────────────────────────

function RunDetail({
  run,
  onDownloadArtifact,
  onViewReport,
}: {
  run: EvaluationRunRecord;
  onDownloadArtifact: (artifactName: string) => void;
  onViewReport: () => void;
}) {
  const intl = useIntl();

  if (!run.result) {
    return (
      <div style={{ padding: '16px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
        {run.status === 'queued' || run.status === 'running'
          ? intl.formatMessage({ id: 'common.pleaseWait' })
          : run.status === 'failed'
            ? intl.formatMessage({ id: 'agents.evaluations.failedMessage' })
            : run.status === 'timed_out'
              ? intl.formatMessage({ id: 'agents.evaluations.timedOutMessage' })
              : intl.formatMessage({ id: 'common.loading' })}
      </div>
    );
  }

  const { scorecard } = run.result;

  return (
    <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Overall score */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' }}>
        <ScoreGauge score={scorecard.overallScore} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            {intl.formatMessage({ id: 'agents.evaluations.overallScore' })}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            {intl.formatMessage(
              { id: 'agents.evaluations.findings' },
              { count: run.result.summary.totalFindings },
            )}
            {' · '}
            {run.result.summary.criticalCount > 0 &&
              intl.formatMessage(
                { id: 'agents.evaluations.critical' },
                { count: run.result.summary.criticalCount },
              ) + ' · '}
            {run.result.summary.highCount > 0 &&
              intl.formatMessage(
                { id: 'agents.evaluations.high' },
                { count: run.result.summary.highCount },
              )}
          </div>
        </div>
      </div>

      {/* Section scores */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Sections
        </div>
        {scorecard.sections.map((section) => {
          if (!section.applicable) return null;
          const sColors = scoreColor(section.score);
          return (
            <div
              key={section.section}
              style={{
                padding: '10px 12px',
                borderRadius: '6px',
                background: 'var(--color-surface-2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: section.findings.length > 0 ? '6px' : '0' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, textTransform: 'capitalize' }}>
                  {section.section.replace(/_/g, ' ')}
                </span>
                <span
                  style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: sColors.text,
                  }}
                >
                  {Math.round(section.score)}
                </span>
              </div>
              {section.findings.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {section.findings.map((f, i) => (
                    <FindingRow key={`${f.code}-${i}`} finding={f} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Non-applicable sections */}
        {scorecard.sections.filter((s) => !s.applicable).length > 0 && (
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic', marginTop: '4px' }}>
            {intl.formatMessage({ id: 'agents.evaluations.sectionNotApplicable' })}:{' '}
            {scorecard.sections
              .filter((s) => !s.applicable)
              .map((s) => s.section.replace(/_/g, ' '))
              .join(', ')}
          </div>
        )}
      </div>

      {/* Findings summary if no findings */}
      {run.result.summary.totalFindings === 0 && (
        <div style={{ padding: '12px', background: 'var(--color-success-subtle)', borderRadius: '6px', fontSize: '13px', color: 'var(--color-success)' }}>
          {intl.formatMessage({ id: 'agents.evaluations.noFindings' })}
        </div>
      )}

      {/* Artifacts & Report */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" onClick={onViewReport}>
          {intl.formatMessage({ id: 'agents.evaluations.viewReport' })}
        </Button>
        {run.result.artifactManifest.map((a) => (
          <Button
            key={a.name}
            variant="ghost"
            size="sm"
            onClick={() => onDownloadArtifact(a.name)}
          >
            {intl.formatMessage(
              { id: 'agents.evaluations.downloadArtifact' },
              { name: a.name },
            )}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ─── RunList ────────────────────────────────────────────────────────────────

function RunList({
  runs,
  selectedRunId,
  onSelect,
  hasMore,
  onLoadMore,
}: {
  runs: EvaluationRunRecord[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const intl = useIntl();

  if (runs.length === 0) {
    return (
      <EmptyState
        title={intl.formatMessage({ id: 'agents.evaluations.title' })}
        message={intl.formatMessage({ id: 'agents.evaluations.noEvaluations' })}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '100px 80px 100px 1fr',
          gap: '8px',
          padding: '6px 10px',
          fontSize: '11px',
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span>{intl.formatMessage({ id: 'common.status' })}</span>
        <span>{intl.formatMessage({ id: 'agents.evaluations.overallScore' })}</span>
        <span>{intl.formatMessage({ id: 'agents.evaluations.scope' })}</span>
        <span>{intl.formatMessage({ id: 'agents.evaluations.triggeredAt' })}</span>
      </div>

      {runs.map((run) => {
        const isSelected = run.id === selectedRunId;
        const isTerminal = ['succeeded', 'failed', 'timed_out'].includes(run.status);
        const hasResult = run.status === 'succeeded' && run.result;

        return (
          <div
            key={run.id}
            onClick={() => isTerminal ? onSelect(run.id) : undefined}
            style={{
              display: 'grid',
              gridTemplateColumns: '100px 80px 100px 1fr',
              gap: '8px',
              padding: '10px',
              borderRadius: '6px',
              background: isSelected ? 'var(--color-surface-2)' : 'transparent',
              border: isSelected ? '1px solid var(--color-border)' : '1px solid transparent',
              cursor: isTerminal ? 'pointer' : 'default',
              transition: 'background 0.15s',
              alignItems: 'center',
              fontSize: '13px',
            }}
          >
            <StatusBadge status={run.status} />
            <span style={{ fontWeight: 600, color: hasResult ? scoreColor(run.result!.scorecard.overallScore).text : 'var(--color-text-muted)' }}>
              {hasResult ? Math.round(run.result!.scorecard.overallScore) : '—'}
            </span>
            <span style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>
              {formatScopeType(run.requestedScope.type)}
            </span>
            <RelativeTime timestamp={run.requestedAt as unknown as string} />
          </div>
        );
      })}

      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: '8px' }}>
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            {intl.formatMessage({ id: 'agents.evaluations.loadMore' })}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── AgentEvaluations (main) ────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const PAGE_SIZE = 50;

export function AgentEvaluations({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const qc = useQueryClient();

  // ── State ──────────────────────────────────────────────────────────────
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  // ── List query ─────────────────────────────────────────────────────────
  const listQuery = useQuery({
    queryKey: ['agents', agentId, 'evaluations', offset],
    queryFn: () => agentsApi.evaluations.list(agentId, { limit: PAGE_SIZE, offset }),
    refetchInterval: (query) => {
      // Poll while any run is in progress
      const data = query.state.data;
      if (!data) return false;
      const hasInProgress = data.some(
        (r) => r.status === 'queued' || r.status === 'running',
      );
      return hasInProgress ? POLL_INTERVAL_MS : false;
    },
  });

  const runs = listQuery.data ?? [];
  const hasMore = runs.length >= PAGE_SIZE;

  // ── Detail query (lazy, on row click) ──────────────────────────────────
  const detailQuery = useQuery({
    queryKey: ['agents', agentId, 'evaluations', selectedRunId],
    queryFn: () => agentsApi.evaluations.get(agentId, selectedRunId!),
    enabled: !!selectedRunId,
  });

  const selectedRun = detailQuery.data ?? null;

  // ── Trigger mutation ───────────────────────────────────────────────────
  const triggerMutation = useMutation({
    mutationFn: (scope?: EvaluationScope) =>
      agentsApi.evaluations.trigger(agentId, scope),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['agents', agentId, 'evaluations'],
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 409)) {
        // Already running — handled by the toast in the component
        return;
      }
      throw error;
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleTrigger = useCallback(() => {
    triggerMutation.mutate(undefined);
  }, [triggerMutation]);

  const handleSelectRun = useCallback((runId: string) => {
    setSelectedRunId((prev) => (prev === runId ? null : runId));
    setShowReport(false);
    setReportContent(null);
    setReportError(null);
  }, []);

  const handleDownloadArtifact = useCallback(
    (artifactName: string) => {
      if (!selectedRunId) return;
      const url = agentsApi.evaluations.getArtifactUrl(
        agentId,
        selectedRunId,
        artifactName,
      );
      window.open(url, '_blank');
    },
    [agentId, selectedRunId],
  );

  const handleViewReport = useCallback(async () => {
    if (!selectedRunId) return;

    if (reportContent) {
      setShowReport(!showReport);
      return;
    }

    setShowReport(true);
    setReportLoading(true);
    setReportError(null);

    try {
      const url = agentsApi.evaluations.getArtifactUrl(
        agentId,
        selectedRunId,
        'REPORT.md',
      );
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('herobids_token') ?? ''}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to load report: ${response.status}`);
      }
      const text = await response.text();
      setReportContent(text);
    } catch (err) {
      setReportError(
        err instanceof Error ? err.message : 'Failed to load report',
      );
    } finally {
      setReportLoading(false);
    }
  }, [agentId, selectedRunId, reportContent, showReport]);

  const handleLoadMore = useCallback(() => {
    setOffset((prev) => prev + PAGE_SIZE);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Card>
      <details>
        <summary
          style={{
            fontSize: '11px',
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {intl.formatMessage({ id: 'agents.evaluations.title' })}
        </summary>

        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Trigger button + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleTrigger}
              disabled={triggerMutation.isPending}
            >
              {triggerMutation.isPending
                ? intl.formatMessage({ id: 'agents.evaluations.running' })
                : intl.formatMessage({ id: 'agents.evaluations.runNow' })}
            </Button>

            {triggerMutation.isError && (
              <span style={{ fontSize: '12px', color: 'var(--color-danger)' }}>
                {triggerMutation.error instanceof ApiError && (triggerMutation.error as ApiError).status === 409
                  ? intl.formatMessage({ id: 'agents.evaluations.alreadyRunning' })
                  : intl.formatMessage({ id: 'agents.evaluations.triggerError' })}
              </span>
            )}

            {triggerMutation.isSuccess && (
              <span style={{ fontSize: '12px', color: 'var(--color-success)' }}>
                {intl.formatMessage({ id: 'agents.evaluations.triggerSuccess' })}
              </span>
            )}
          </div>

          {/* Error state */}
          {listQuery.isError && (
            <ErrorState
              message={intl.formatMessage({ id: 'agents.evaluations.fetchError' })}
              onRetry={() => void listQuery.refetch()}
            />
          )}

          {/* Loading state */}
          {listQuery.isLoading && <LoadingRows count={3} />}

          {/* Run list */}
          {listQuery.isSuccess && (
            <RunList
              runs={runs}
              selectedRunId={selectedRunId}
              onSelect={handleSelectRun}
              hasMore={hasMore}
              onLoadMore={handleLoadMore}
            />
          )}

          {/* Selected run detail */}
          {selectedRunId && (
            <div
              style={{
                marginTop: '8px',
                padding: '16px',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                background: 'var(--color-surface-1)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  Run {selectedRunId.slice(0, 8)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedRunId(null)}
                >
                  ✕
                </Button>
              </div>

              {detailQuery.isLoading && <LoadingRows count={2} />}

              {detailQuery.isError && (
                <ErrorState
                  message={intl.formatMessage({ id: 'agents.evaluations.fetchError' })}
                  onRetry={() => void detailQuery.refetch()}
                />
              )}

              {detailQuery.isSuccess && selectedRun && (
                <RunDetail
                  run={selectedRun}
                  onDownloadArtifact={handleDownloadArtifact}
                  onViewReport={handleViewReport}
                />
              )}

              {/* Report viewer */}
              {showReport && (
                <div style={{ marginTop: '12px' }}>
                  {reportLoading && <LoadingRows count={2} />}
                  {reportError && (
                    <ErrorState
                      message={reportError}
                      onRetry={() => {
                        setReportContent(null);
                        void handleViewReport();
                      }}
                    />
                  )}
                  {reportContent && (
                    <AgentEvaluationReport content={reportContent} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}
