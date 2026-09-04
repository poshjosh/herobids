import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bots as botsApi, capabilities as capabilitiesApi } from '../../lib/api-client.js';
import type { Bot, ConnectionSummary, PresetFromApi } from '../../lib/api-client.js';
import {
  PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState,
  Button, StatusBadge, RelativeTime, KV, Modal, FieldLabel, ErrorBanner, inputStyle,
} from '../../lib/ui.js';
import { StrategyPresetSelector } from '../../lib/StrategyPresetSelector.js';
import { BotCustomConfigSection, type BotCustomConfigFormState, defaultBotCustomConfig } from './BotCustomConfigSection.js';
import { SWAP_VENUES } from '@herobids/domain';

const STYLE_VALUES = ['economy', 'standard', 'premium'] as const;

const EXECUTION_MODE_VALUES = ['test', 'live'] as const;
type ExecutionModeValue = typeof EXECUTION_MODE_VALUES[number];

function presetToCustomConfig(preset: PresetFromApi): BotCustomConfigFormState {
  const params = (preset.strategy.params ?? {}) as Record<string, unknown>;
  return {
    ...defaultBotCustomConfig,
    strategyType: (preset.strategy.type as BotCustomConfigFormState['strategyType']) ?? 'momentum',
    signalBias: (params['signalBias'] as BotCustomConfigFormState['signalBias']) ?? 'trend-following',
    candleInterval: (params['candleInterval'] as BotCustomConfigFormState['candleInterval']) ?? '15m',
    candleLimit: String(params['candleLimit'] ?? 48),
    stopLossPct: String(params['stopLossPct'] ?? ''),
    takeProfitPct: String(params['takeProfitPct'] ?? ''),
    trailingStopPct: params['trailingStopPct'] != null ? String(params['trailingStopPct']) : '',
    positionSize: String(params['positionSize'] ?? '100'),
    positionSizeMode: (params['positionSizeMode'] as BotCustomConfigFormState['positionSizeMode']) ?? 'percent_equity',
    maxPositionSizePct: preset.risk?.maxPositionSizePct != null ? String(preset.risk.maxPositionSizePct) : '',
    riskStopLossPct: preset.risk?.stopLossPct != null ? String(preset.risk.stopLossPct) : '',
  };
}

function buildCustomBotConfig(
  c: BotCustomConfigFormState,
  executionMode: string,
  venue: string,
  symbol: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    candleInterval: c.candleInterval,
    candleLimit: Number.isFinite(parseInt(c.candleLimit, 10)) ? parseInt(c.candleLimit, 10) : 48,
    signalBias: c.signalBias,
    stopLossPct: Number.isFinite(parseFloat(c.stopLossPct)) ? parseFloat(c.stopLossPct) : null,
    takeProfitPct: Number.isFinite(parseFloat(c.takeProfitPct)) ? parseFloat(c.takeProfitPct) : null,
    trailingStopPct: Number.isFinite(parseFloat(c.trailingStopPct)) ? parseFloat(c.trailingStopPct) : null,
    positionSize: c.positionSize,
    positionSizeMode: c.positionSizeMode,
  };

  const risk: Record<string, unknown> = {};
  const maxPosSizePct = parseFloat(c.maxPositionSizePct);
  if (Number.isFinite(maxPosSizePct)) risk['maxPositionSizePct'] = maxPosSizePct;

  const maxOpen = parseInt(c.maxOpenPositions, 10);
  if (Number.isFinite(maxOpen)) risk['maxOpenPositions'] = maxOpen;

  const dailyLoss = parseFloat(c.dailyMaxLossPct);
  if (Number.isFinite(dailyLoss)) risk['dailyMaxLossPct'] = dailyLoss;

  const maxUnrealized = parseFloat(c.riskStopLossPct);
  if (Number.isFinite(maxUnrealized)) risk['stopLossPct'] = maxUnrealized;

  return {
    strategy: {
      type: c.strategyType,
      decisionMode: c.decisionMode,
      params,
    },
    ...(Object.keys(risk).length > 0 ? { risk } : {}),
    execution: { mode: executionMode },
    venue,
    symbol,
  };
}

// ---------------------------------------------------------------------------
// BotsPage
// ---------------------------------------------------------------------------
export function BotsPage() {
  const intl = useIntl();
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['bots'],
    queryFn: () => botsApi.list(),
  });

  const items: Bot[] = query.data?.bots ?? [];

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'bots.title' })}
        subtitle={intl.formatMessage({ id: 'bots.subtitle' })}
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>{intl.formatMessage({ id: 'bots.createBot' })}</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && (
        <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />
      )}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'bots.empty.title' })}
          message={intl.formatMessage({ id: 'bots.empty.message' })}
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>{intl.formatMessage({ id: 'bots.createBot' })}</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((bot) => (
            <Card key={bot.id}>
              <div
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/bots/${bot.id}`)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontWeight: '600', fontSize: '0.9375rem', fontFamily: 'monospace' }}>
                      {bot.id.slice(0, 8)}
                    </span>
                    <StatusBadge status={bot.status} />
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                    {bot.creatorType === 'agent'
                      ? intl.formatMessage({ id: 'bots.creatorAgent' }, { id: bot.creatorId.slice(0, 8) })
                      : intl.formatMessage({ id: 'bots.creatorUser' })}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                  <KV
                    label={intl.formatMessage({ id: 'bots.kv.strategy' })}
                    value={String((bot.config['strategy'] as Record<string, unknown> | undefined)?.['type'] ?? '—')}
                  />
                  <KV
                    label={intl.formatMessage({ id: 'bots.kv.mode' })}
                    value={String((bot.config['execution'] as Record<string, unknown> | undefined)?.['mode'] ?? 'paper')}
                  />
                  <KV label={intl.formatMessage({ id: 'bots.kv.created' })} value={<RelativeTime timestamp={bot.createdAt} />} />
                  {bot.startedAt && <KV label={intl.formatMessage({ id: 'bots.kv.started' })} value={<RelativeTime timestamp={bot.startedAt} />} />}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateBotModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['bots'] });
          }}
        />
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// CreateBotModal
// ---------------------------------------------------------------------------
interface CreateBotForm {
  connectionId: string;
  strategyPreset: string;
  executionMode: ExecutionModeValue;
  symbol: string;
  customConfig: BotCustomConfigFormState;
}

function CreateBotModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const intl = useIntl();
  const [form, setForm] = useState<CreateBotForm>({
    connectionId: '',
    strategyPreset: 'momentum',
    executionMode: 'test',
    symbol: '',
    customConfig: defaultBotCustomConfig,
  });
  const [selectedStyle, setSelectedStyle] = useState<string>('standard');

  const tradingConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
  });
  const tradingConnections: ConnectionSummary[] = (tradingConnectionsQuery.data?.connections ?? []).filter(
    (c) => c.status === 'active',
  );
  const selectedConnection = tradingConnections.find((c) => c.connectionId === form.connectionId) ?? null;
  const isSwapVenue = selectedConnection != null && (SWAP_VENUES as readonly string[]).includes(selectedConnection.provider);

  const presetsQuery = useQuery({
    queryKey: ['blueprintPresets', selectedStyle],
    queryFn: () => botsApi.getPresets(selectedStyle),
  });
  const fetchedPresets: PresetFromApi[] = presetsQuery.data?.presets ?? [];

  const mutation = useMutation({
    mutationFn: () => {
      const venue = selectedConnection?.provider;
      if (!venue) throw new Error(intl.formatMessage({ id: 'bots.modal.errorNoConnection' }));

      let config: Record<string, unknown>;

      if (form.strategyPreset === 'custom') {
        config = buildCustomBotConfig(form.customConfig, form.executionMode, venue, form.symbol);
      } else {
        const preset = fetchedPresets.find((p) => p.key === form.strategyPreset);
        if (!preset) throw new Error(intl.formatMessage({ id: 'bots.modal.errorPresetNotFound' }));
        config = {
          strategy: preset.strategy,
          ...(preset.risk ? { risk: preset.risk } : {}),
          execution: { mode: form.executionMode },
          venue,
          symbol: form.symbol,
        };
      }

      return botsApi.create({ connectionId: form.connectionId, venue, symbol: form.symbol, config });
    },
    onSuccess: onCreated,
  });

  return (
    <Modal title={intl.formatMessage({ id: 'bots.modal.title' })} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Platform link */}
        <div>
          <FieldLabel>{intl.formatMessage({ id: 'bots.modal.platformLink' })}</FieldLabel>
          <select
            value={form.connectionId}
            onChange={(e) => setForm((s) => ({ ...s, connectionId: e.target.value }))}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">{intl.formatMessage({ id: 'bots.modal.platformLinkPlaceholder' })}</option>
            {tradingConnections.map((c) => (
              <option key={c.connectionId} value={c.connectionId}>{c.label} ({c.provider})</option>
            ))}
          </select>
        </div>

        {/* Symbol */}
        <div>
          <FieldLabel>{isSwapVenue ? intl.formatMessage({ id: 'bots.modal.symbolSwap' }) : intl.formatMessage({ id: 'bots.modal.symbolPerp' })}</FieldLabel>
          <input
            type="text"
            style={inputStyle}
            value={form.symbol}
            onChange={(e) => setForm((s) => ({ ...s, symbol: e.target.value }))}
            placeholder={intl.formatMessage({ id: isSwapVenue ? 'bots.modal.symbolSwapPlaceholder' : 'bots.modal.symbolPerpPlaceholder' })}
          />
        </div>

        {/* Style tier — hidden in custom mode, since the style only controls preset tier */}
        {form.strategyPreset !== 'custom' && (
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'bots.modal.strategyStyle' })}</FieldLabel>
            <select
              value={selectedStyle}
              onChange={(e) => {
                setSelectedStyle(e.target.value);
                setForm((s) => ({ ...s, strategyPreset: '' }));
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {STYLE_VALUES.map((v) => (
                <option key={v} value={v}>
                  {intl.formatMessage({ id: `bots.modal.style.${v}.label` })} — {intl.formatMessage({ id: `bots.modal.style.${v}.description` })}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Strategy preset */}
        <StrategyPresetSelector
          value={form.strategyPreset}
          onChange={(key) => {
            if (key === 'custom') {
              const seed = fetchedPresets[0];
              setForm((s) => ({
                ...s,
                strategyPreset: 'custom',
                customConfig: seed ? presetToCustomConfig(seed) : defaultBotCustomConfig,
              }));
            } else {
              setForm((s) => ({ ...s, strategyPreset: key, customConfig: defaultBotCustomConfig }));
            }
          }}
          presets={fetchedPresets}
          loading={presetsQuery.isLoading}
        />

        {form.strategyPreset === 'custom' && (
          <BotCustomConfigSection
            value={form.customConfig}
            onChange={(patch) => setForm((s) => ({ ...s, customConfig: { ...s.customConfig, ...patch } }))}
            isSwapVenue={isSwapVenue}
          />
        )}

        {/* Execution mode */}
        <div>
          <FieldLabel>{intl.formatMessage({ id: 'bots.modal.executionMode' })}</FieldLabel>
          <select
            value={form.executionMode}
            onChange={(e) => setForm((s) => ({ ...s, executionMode: e.target.value as ExecutionModeValue }))}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {EXECUTION_MODE_VALUES.map((v) => (
              <option key={v} value={v}>
                {intl.formatMessage({ id: `bots.modal.executionMode.${v}.label` })} — {intl.formatMessage({ id: `bots.modal.executionMode.${v}.description` })}
              </option>
            ))}
          </select>
        </div>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'bots.modal.cancel' })}</Button>
          <Button
            variant="primary"
            type="button"
            disabled={
              mutation.isPending
              || presetsQuery.isLoading
              || !form.connectionId
              || !form.symbol.trim()
              || (form.strategyPreset !== 'custom' && !form.strategyPreset)
              || (form.strategyPreset === 'custom' && (
                !form.customConfig.stopLossPct
                || !form.customConfig.takeProfitPct
                || !form.customConfig.positionSize
              ))
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? intl.formatMessage({ id: 'bots.modal.creating' }) : intl.formatMessage({ id: 'bots.createBot' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
