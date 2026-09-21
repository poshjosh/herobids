import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { agents as agentsApi, providerCatalog, type DecisionApproval } from '../../lib/api-client.js';
import { Button, Card, ErrorState, LoadingRows, SectionLabel } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';
import { CapabilityAttributes, CapabilityFeeds, type CapabilityAttribute } from './CapabilityPresentation.js';

interface TradingCapabilityPresentationProps {
  agentId: string;
  connectionProvider: string | null;
  isActive: boolean;
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

export function TradingCapabilityPresentation({ agentId, connectionProvider, isActive }: TradingCapabilityPresentationProps) {
  const intl = useIntl();
  const [fundingBannerDismissed, setFundingBannerDismissed] = useState(() => {
    return localStorage.getItem(`funding-banner-dismissed-${agentId}`) === '1';
  });
  // Retained solely for the platform funding banner; all trading data flows through the presentation endpoint.
  const providerCatalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalog.get(),
    staleTime: 5 * 60_000,
  });
  const presentationQuery = useQuery({
    queryKey: ['agents', agentId, 'capabilities', 'trading', 'presentation'],
    queryFn: () => agentsApi.presentation(agentId, 'trading'),
    refetchInterval: isActive ? 30_000 : false,
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

  if (presentationQuery.isLoading) {
    return <Card><LoadingRows count={3} /></Card>;
  }

  if (presentationQuery.error) {
    return <Card><ErrorState message={localizeApiError(intl, presentationQuery.error, 'common.errorTitle')} onRetry={() => {
      void presentationQuery.refetch();
    }} /></Card>;
  }

  const presentation = presentationQuery.data;

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
        <CapabilityAttributes attributes={presentation?.attributes ?? []} />
      </Card>
      <Card>
        <CapabilityFeeds feeds={presentation?.feeds ?? []} />
      </Card>
      <ApprovalsPanel agentId={agentId} renderProposalDetails={(approval) => <TradingApprovalDetails approval={approval} />} />
    </div>
  );
}