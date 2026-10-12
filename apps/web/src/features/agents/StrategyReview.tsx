import { useState, useCallback, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import {
  agents as agentsApi,
  ApiError,
  type PlatformAssessmentReviewTrigger,
} from '../../lib/api-client.js';
import { Button } from '../../lib/ui.js';

// ─── AssessmentFlags (read-only strategy assessment) ───────────────────────

const ASSESSMENT_TH_STYLE: CSSProperties = {
  textAlign: 'left',
  padding: '4px 8px',
  fontSize: '0.6875rem',
  fontWeight: 600,
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1px solid var(--color-border)',
};

const ASSESSMENT_TD_STYLE: CSSProperties = {
  padding: '4px 8px',
  fontSize: '0.75rem',
  color: 'var(--color-text-secondary)',
  borderBottom: '1px solid var(--color-border)',
};

function AssessmentFlags({ results }: { results: PlatformAssessmentReviewTrigger['results'] }) {
  const intl = useIntl();
  const yes = intl.formatMessage({ id: 'agents.strategyReview.assessment.yes' });
  const no = intl.formatMessage({ id: 'agents.strategyReview.assessment.no' });

  return (
    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
        {intl.formatMessage({ id: 'agents.strategyReview.assessment.title' })}
      </div>
      {results.map((r, i) => {
        if (!r.success) {
          return (
            <div key={i} style={{ fontSize: '0.75rem', color: 'var(--color-warning)' }}>
              {intl.formatMessage({ id: 'agents.strategyReview.assessment.failed' }, {
                symbol: r.symbol,
                error: r.error ?? r.errorCode ?? '',
              })}
            </div>
          );
        }
        const currentPreset = r.currentStrategy?.presetKey ?? null;
        const presets = r.presets ?? [];
        return (
          <div key={i} style={{ padding: '10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-1)' }}>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '6px' }}>
              {r.symbol}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={ASSESSMENT_TH_STYLE}>{intl.formatMessage({ id: 'agents.strategyReview.assessment.preset' })}</th>
                  <th style={ASSESSMENT_TH_STYLE}>{intl.formatMessage({ id: 'agents.strategyReview.assessment.evidenceFresh' })}</th>
                  <th style={ASSESSMENT_TH_STYLE}>{intl.formatMessage({ id: 'agents.strategyReview.assessment.regimeMatch' })}</th>
                  <th style={ASSESSMENT_TH_STYLE}>{intl.formatMessage({ id: 'agents.strategyReview.assessment.creatorAllowed' })}</th>
                  <th style={ASSESSMENT_TH_STYLE}>{intl.formatMessage({ id: 'agents.strategyReview.assessment.signalsVsCurrent' })}</th>
                </tr>
              </thead>
              <tbody>
                {presets.map((p) => (
                  <tr key={p.presetKey}>
                    <td style={ASSESSMENT_TD_STYLE}>
                      {p.name}
                      {p.presetKey === currentPreset && (
                        <span style={{ marginLeft: '4px', fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
                          ({intl.formatMessage({ id: 'agents.strategyReview.assessment.current' })})
                        </span>
                      )}
                    </td>
                    <td style={ASSESSMENT_TD_STYLE}>{p.flags.evidenceFresh ? yes : no}</td>
                    <td style={ASSESSMENT_TD_STYLE}>{p.flags.regimeMatch ? yes : no}</td>
                    <td style={ASSESSMENT_TD_STYLE}>{p.flags.creatorAllowed ? yes : no}</td>
                    <td style={ASSESSMENT_TD_STYLE}>{p.flags.signalsVsCurrent ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ─── StrategyReview (main) ─────────────────────────────────────────────────

export function StrategyReview({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const qc = useQueryClient();

  // ── State ──────────────────────────────────────────────────────────────
  const [reviewSymbols, setReviewSymbols] = useState('BTC');
  const [reviewVenueFamily, setReviewVenueFamily] = useState('hyperliquid');
  const [reviewTriggered, setReviewTriggered] = useState(false);

  // ── Strategy review eligibility ─────────────────────────────────────
  const reviewEligibilityQuery = useQuery({
    queryKey: ['agents', agentId, 'platform-assessment-review', 'eligibility'],
    queryFn: () => agentsApi.platformAssessmentReviews.eligibility(agentId),
    staleTime: 30_000,
  });

  // ── Strategy review trigger ─────────────────────────────────────────
  const reviewTriggerMutation = useMutation({
    mutationFn: () => agentsApi.platformAssessmentReviews.trigger(agentId, {
      symbols: reviewSymbols.split(',').map((s) => s.trim()).filter(Boolean),
      venueFamily: reviewVenueFamily,
    }),
    onSuccess: () => {
      setReviewTriggered(true);
      void qc.invalidateQueries({
        queryKey: ['agents', agentId, 'platform-assessment-review', 'eligibility'],
      });
      void qc.invalidateQueries({
        queryKey: ['agents', agentId, 'platform-assessment-review', 'results'],
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 409)) {
        // Already running — handled by the render block
        return;
      }
      throw error;
    },
  });

  // The trigger response carries the per-symbol assessment flags (read-only).
  const reviewTriggerResult = reviewTriggerMutation.data ?? null;

  // ── Strategy review results (data-only artifacts + agent decision) ──
  const reviewResultsQuery = useQuery({
    queryKey: ['agents', agentId, 'platform-assessment-review', 'results'],
    queryFn: () => agentsApi.platformAssessmentReviews.getResults(agentId),
    refetchInterval: 10_000,
  });

  const resultsData = reviewResultsQuery.data ?? null;

  const handleReviewTrigger = useCallback(() => {
    reviewTriggerMutation.mutate();
  }, [reviewTriggerMutation]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px 0', borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={reviewSymbols}
          onChange={(e) => setReviewSymbols(e.target.value)}
          placeholder="BTC, ETH"
          style={{
            padding: '4px 8px',
            fontSize: '0.8125rem',
            borderRadius: '4px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface-1)',
            color: 'var(--color-text-primary)',
            width: '140px',
          }}
        />
        <input
          type="text"
          value={reviewVenueFamily}
          onChange={(e) => setReviewVenueFamily(e.target.value)}
          placeholder="hyperliquid"
          style={{
            padding: '4px 8px',
            fontSize: '0.8125rem',
            borderRadius: '4px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface-1)',
            color: 'var(--color-text-primary)',
            width: '140px',
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleReviewTrigger}
          disabled={
            reviewTriggerMutation.isPending ||
            (reviewEligibilityQuery.isSuccess && !reviewEligibilityQuery.data?.canTrigger)
          }
        >
          {reviewTriggerMutation.isPending
            ? intl.formatMessage({ id: 'agents.strategyReview.running' })
            : intl.formatMessage({ id: 'agents.strategyReview.runReview' })}
        </Button>

        {reviewTriggerMutation.isError && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-danger)' }}>
            {reviewTriggerMutation.error instanceof ApiError
              ? (reviewTriggerMutation.error as ApiError).message
              : intl.formatMessage({ id: 'agents.strategyReview.triggerError' })}
          </span>
        )}
      </div>

      {/* Eligibility hint */}
      {reviewEligibilityQuery.isSuccess &&
        !reviewEligibilityQuery.data.canTrigger && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
            {reviewEligibilityQuery.data.reason ?? intl.formatMessage({ id: 'agents.strategyReview.notAvailable' })}
          </span>
        )}

      {/* Read-only assessment flags (from the trigger response) */}
      {reviewTriggerResult && reviewTriggerResult.results.length > 0 && (
        <AssessmentFlags results={reviewTriggerResult.results} />
      )}

      {/* Agent decision + reason (once the agent acts) */}
      {resultsData && resultsData.changes.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '8px' }}>
            {intl.formatMessage({ id: 'agents.strategyReview.results.title' })}
          </div>
          {resultsData.changes.map((c, i) => {
            const fromPreset = (c.fromStrategy as Record<string, unknown> | null)?.presetKey;
            const toPreset = (c.toStrategy as Record<string, unknown>)?.presetKey;
            const changed = fromPreset !== toPreset;
            return (
              <div key={i} style={{
                marginBottom: '8px',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                background: 'var(--color-surface-1)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '0.75rem' }}>
                  {changed ? (
                    <span style={{ color: 'var(--color-text-primary)' }}>
                      {intl.formatMessage({ id: 'agents.strategyReview.results.agentChanged' }, {
                        from: String(fromPreset ?? '—'),
                        to: String(toPreset ?? '—'),
                      })}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {intl.formatMessage({ id: 'agents.strategyReview.results.agentKept' }, {
                        preset: String(toPreset ?? fromPreset ?? '—'),
                      })}
                    </span>
                  )}
                  <span style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
                    {c.appliedAt ?? c.createdAt}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.strategyReview.results.reason' })}: </span>
                  {c.reason}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* No decision yet */}
      {reviewTriggered && resultsData && resultsData.changes.length === 0 && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '8px' }}>
          {intl.formatMessage({ id: 'agents.strategyReview.results.agentNotified' })}
        </div>
      )}
    </div>
  );
}