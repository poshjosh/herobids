import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { agents as agentsApi, providerCatalog, type Agent, type AgentPosition, type DecisionApproval } from '../../lib/api-client.js';
import { Button, Card, ErrorState, LoadingRows, SectionLabel } from '../../lib/ui.js';
import { formatPnl } from '../../lib/formatting.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { formatAuthorizationMode, formatExecutionMode } from './agent-display.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';
import { CapabilityAttributes, CapabilityFeeds, type CapabilityAttribute, type CapabilityFeed, type CapabilityPresentationEmphasis } from './CapabilityPresentation.js';

interface TradingCapabilityPresentationProps {
  agentId: string;
  agent: Agent;
  connectionLabel: string | null;
  connectionProvider: string | null;
  isActive: boolean;
}

function pnlEmphasis(value: string): CapabilityPresentationEmphasis {
  const numericValue = Number(value);
  if (numericValue > 0) return 'positive';
  if (numericValue < 0) return 'negative';
  return 'neutral';
}

function proposalAttributes(approval: DecisionApproval): CapabilityAttribute[] {
  return [
    { key: 'instrument', label: 'Instrument', value: approval.instrumentId },
    { key: 'intent', label: 'Intent', value: approval.intent.replace(/_/g, ' ') },
    { key: 'target-size', label: 'Target size', value: approval.targetSize },
    { key: 'price', label: approval.limitPrice ? 'Limit price' : 'Order type', value: approval.limitPrice ?? 'Market' },
    ...(approval.stopLoss ? [{ key: 'stop-loss', label: 'Stop loss', value: approval.stopLoss }] : []),
    ...(approval.takeProfit ? [{ key: 'take-profit', label: 'Take profit', value: approval.takeProfit }] : []),
    ...(approval.confidence ? [{ key: 'confidence', label: 'Confidence', value: approval.confidence }] : []),
  ];
}

function TradingApprovalDetails({ approval }: { approval: DecisionApproval }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '12px' }}>
      <CapabilityAttributes attributes={proposalAttributes(approval)} />
      {approval.rationaleSummary && (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', lineHeight: '1.5', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {approval.rationaleSummary}
        </div>
      )}
    </div>
  );
}

export function TradingCapabilityPresentation({ agentId, agent, connectionLabel, connectionProvider, isActive }: TradingCapabilityPresentationProps) {
  const intl = useIntl();
  const [fundingBannerDismissed, setFundingBannerDismissed] = useState(() => {
    return localStorage.getItem(`funding-banner-dismissed-${agentId}`) === '1';
  });
  const providerCatalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalog.get(),
    staleTime: 5 * 60_000,
  });
  const outcomesQuery = useQuery({
    queryKey: ['agents', 'outcomes'],
    queryFn: () => agentsApi.outcomes(),
  });
  const positionsQuery = useQuery({
    queryKey: ['agents', agentId, 'trading-positions'],
    queryFn: () => agentsApi.tradingPositions(agentId, { limit: 50 }),
    refetchInterval: isActive ? 30_000 : false,
  });
  const decisionsQuery = useQuery({
    queryKey: ['agents', agentId, 'decisions'],
    queryFn: () => agentsApi.decisions(agentId, 20),
    refetchInterval: isActive ? 15_000 : false,
  });

  const venueHasWalletGeneration = connectionProvider
    ? providerCatalogQuery.data?.providers.some((provider) => provider.id === connectionProvider && provider.walletGeneration?.available === true)
    : false;
  const showFundingBanner = venueHasWalletGeneration === true && !fundingBannerDismissed;
  const fundingDocUrl = (() => {
    const base = '/docs/trading-venues/funding-wallets';
    if (connectionProvider === 'hyperliquid') return `${base}#hyperliquid`;
    if (connectionProvider === 'jupiter') return `${base}#jupiter`;
    if (connectionProvider === '1inch') return `${base}#1inch`;
    return base;
  })();

  const dismissFundingBanner = () => {
    localStorage.setItem(`funding-banner-dismissed-${agentId}`, '1');
    setFundingBannerDismissed(true);
  };

  if (providerCatalogQuery.isLoading || outcomesQuery.isLoading || positionsQuery.isLoading || decisionsQuery.isLoading) {
    return <Card><LoadingRows count={3} /></Card>;
  }

  const error = providerCatalogQuery.error ?? outcomesQuery.error ?? positionsQuery.error ?? decisionsQuery.error;
  if (error) {
    return <Card><ErrorState message={localizeApiError(intl, error, 'common.errorTitle')} onRetry={() => {
      void providerCatalogQuery.refetch();
      void outcomesQuery.refetch();
      void positionsQuery.refetch();
      void decisionsQuery.refetch();
    }} /></Card>;
  }

  const outcome = outcomesQuery.data?.outcomes.find((entry) => entry.agentId === agentId)?.outcomes.trading;
  const attributes: CapabilityAttribute[] = [
    { key: 'connection', label: 'Connection', value: connectionLabel ?? 'Not assigned', emphasis: connectionLabel ? 'neutral' : 'warning' },
    { key: 'execution-mode', label: 'Execution mode', value: formatExecutionMode(agent.executionMode, intl) },
    { key: 'authorization-mode', label: 'Authorization', value: formatAuthorizationMode(agent.authorizationMode, intl) },
    ...(agent.strategyPresetName ? [{ key: 'strategy', label: 'Strategy', value: agent.strategyPresetName }] : []),
    ...(outcome ? [
      { key: 'realized-pnl', label: 'Realized P&L', value: formatPnl(outcome.totalRealizedPnl), emphasis: pnlEmphasis(outcome.totalRealizedPnl) },
      { key: 'closed-positions', label: 'Closed positions', value: String(outcome.closedPositionCount) },
      ...(outcome.closedPositionCount > 0 ? [{ key: 'win-rate', label: 'Win rate', value: `${Math.round((outcome.winningClosedCount / outcome.closedPositionCount) * 100)}%` }] : []),
    ] : []),
  ];

  const positionFeed: CapabilityFeed = {
    key: 'positions',
    label: 'Positions',
    items: (positionsQuery.data?.items ?? []).map((position: AgentPosition) => ({
      id: position.id,
      title: `${position.symbol} · ${position.status}`,
      detail: `${position.venue} · ${position.size} · ${formatPnl(position.realizedPnl)}`,
      occurredAt: position.closedAt ?? position.openedAt,
      emphasis: pnlEmphasis(position.realizedPnl),
    })),
  };
  const decisionFeed: CapabilityFeed = {
    key: 'decisions',
    label: 'Decisions',
    items: (decisionsQuery.data as Array<{ id: string; intent: string; createdAt: string }>).map((decision) => ({
      id: decision.id,
      title: decision.intent.replace(/_/g, ' '),
      occurredAt: decision.createdAt,
    })),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
      {showFundingBanner && (
        <div style={{
          padding: '12px 16px',
          background: 'var(--color-brand-subtle)',
          border: '1px solid var(--color-brand-dim)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          fontSize: '0.8125rem',
          color: 'var(--color-text-primary)',
        }}>
          <span>
            {intl.formatMessage({ id: 'agents.detail.fundingBanner.text' })}{' '}
            <a href={fundingDocUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-brand)' }}>
              {intl.formatMessage({ id: 'agents.detail.fundingBanner.learnMore' })}
            </a>
          </span>
          <Button variant="ghost" size="sm" onClick={dismissFundingBanner}>Dismiss</Button>
        </div>
      )}
      <Card>
        <SectionLabel>Trading details</SectionLabel>
        <CapabilityAttributes attributes={attributes} />
      </Card>
      <Card>
        <CapabilityFeeds feeds={[positionFeed, decisionFeed]} />
      </Card>
      <ApprovalsPanel agentId={agentId} renderProposalDetails={(approval) => <TradingApprovalDetails approval={approval} />} />
    </div>
  );
}