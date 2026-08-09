import { useState, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { blueprints, connections as connectionsApi, type BlueprintSummary } from '../../lib/api-client.js';
import type {
  BlueprintInstantiatePreviewResponse,
  EffectiveRiskProfile,
  BlueprintBinding,
} from '../../lib/blueprint-types.js';
import {
  Modal, Button, SectionLabel, KV, FieldLabel, ErrorBanner,
  inputStyle, LoadingRows,
} from '../../lib/ui.js';

// ── Types ──────────────────────────────────────────────────────────────

type FlowStep = 'loading' | 'preview' | 'edit' | 'confirm' | 'success' | 'error';

interface EditsState {
  name: string;
  riskOverrides: Record<string, string>; // key -> string value for form inputs
}

// ── Component ──────────────────────────────────────────────────────────

interface BlueprintInstantiateFlowProps {
  blueprint: BlueprintSummary;
  onClose: () => void;
  onCreated?: (actorId: string) => void;
}

export function BlueprintInstantiateFlow({
  blueprint,
  onClose,
  onCreated,
}: BlueprintInstantiateFlowProps) {
  const [step, setStep] = useState<FlowStep>('loading');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BlueprintInstantiatePreviewResponse | null>(null);
  const [edits, setEdits] = useState<EditsState>({ name: blueprint.name, riskOverrides: {} });
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>([]);
  const [createdActorId, setCreatedActorId] = useState<string | null>(null);
  const [requestedMode, setRequestedMode] = useState<'paper' | 'shadow' | 'live' | undefined>(undefined);

  // Generate a stable idempotency key for this flow instance
  const [idempotencyKey] = useState(() => `web-${crypto.randomUUID()}`);

  // ── Fetch preview on mount ────────────────────────────────────────
  const previewQuery = useQuery({
    queryKey: ['blueprints', 'instantiate', 'preview', blueprint.id],
    queryFn: async () => {
      const result = await blueprints.previewInstantiation(blueprint.id, {});
      return result;
    },
    enabled: true,
    retry: false,
  });

  // Side-effect: when preview loads, move to preview step
  if (previewQuery.isSuccess && step === 'loading' && preview === null) {
    setPreview(previewQuery.data);
    setStep('preview');
  }

  if (previewQuery.isError && step === 'loading') {
    if (step === 'loading') {
      setError((previewQuery.error as Error).message);
      setStep('error');
    }
  }

  // ── Fetch connections for binding ──────────────────────────────────
  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: async () => {
      const result = await connectionsApi.list();
      return result.connections.filter((c) => c.status === 'active');
    },
    enabled: true,
  });

  // ── Instantiate mutation ───────────────────────────────────────────
  const instantiateMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('No preview data');

      const binding: BlueprintBinding | undefined = selectedConnectionIds.length > 0
        ? { kind: 'agent', connectionIds: selectedConnectionIds }
        : undefined;

      const editsPayload: Record<string, unknown> = {};
      if (edits.name !== blueprint.name || edits.name !== (preview.rawPayload.name as string | undefined)) {
        editsPayload.name = edits.name;
      }
      if (Object.keys(edits.riskOverrides).length > 0) {
        const riskEdits: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(edits.riskOverrides)) {
          const num = parseFloat(val);
          if (!Number.isNaN(num)) riskEdits[key] = num;
        }
        if (Object.keys(riskEdits).length > 0) {
          editsPayload.risk = riskEdits;
        }
      }
      // The backend discriminated union schema requires `kind` to discriminate
      // between agent and bot partial payloads.
      if (Object.keys(editsPayload).length > 0) {
        editsPayload.kind = preview.kind;
      }

      return blueprints.instantiate(
        blueprint.id,
        {
          revisionId: preview.revisionId,
          ...(Object.keys(editsPayload).length > 0 ? { edits: editsPayload } : {}),
          ...(binding ? { bindings: binding } : {}),
          ...(requestedMode ? { requestedMode } : {}),
          expectedMode: (preview.selectedResolvedMode as 'paper' | 'shadow' | 'live' | null) ?? null,
        },
        idempotencyKey,
      );
    },
    onSuccess: (data) => {
      setCreatedActorId(data.actorId);
      setStep('success');
      onCreated?.(data.actorId);
    },
    onError: (err: Error) => {
      setError(err.message);
      setStep('error');
    },
  });

  // ── Risk field helpers ─────────────────────────────────────────────
  const editableRiskFields = preview
    ? Object.entries(preview.effectiveRisk).filter(([, field]) => field.mutable)
    : [];

  const handleRiskChange = useCallback((key: string, value: string) => {
    setEdits((prev) => ({
      ...prev,
      riskOverrides: { ...prev.riskOverrides, [key]: value },
    }));
  }, []);

  const handleEdit = () => setStep('edit');
  const handleBackToPreview = () => setStep('preview');
  const handleConfirm = () => {
    setStep('confirm');
    // If trading-capable, auto-set requestedMode to the resolved mode
    if (preview?.selectedResolvedMode && !requestedMode) {
      setRequestedMode(preview.selectedResolvedMode as 'paper' | 'shadow' | 'live');
    }
  };
  const handleInstantiate = () => instantiateMutation.mutate();

  // ── Render error ────────────────────────────────────────────────────
  if (step === 'loading' || previewQuery.isLoading) {
    return (
      <Modal title="Loading blueprint..." onClose={onClose}>
        <LoadingRows count={4} />
      </Modal>
    );
  }

  if (step === 'error' || previewQuery.isError) {
    return (
      <Modal title="Error" onClose={onClose}>
        <ErrorBanner message={error ?? 'Failed to load blueprint preview.'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => { setStep('loading'); void previewQuery.refetch(); }}>
            Retry
          </Button>
        </div>
      </Modal>
    );
  }

  if (step === 'success') {
    return (
      <Modal title="Agent created!" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
            Your agent <strong>{edits.name || blueprint.name}</strong> has been created and is in <strong>stopped</strong> status.
          </div>
          {createdActorId && (
            <KV label="Agent ID" value={createdActorId} />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Modal>
    );
  }

  if (!preview) return null;

  // ── Render preview ──────────────────────────────────────────────────
  if (step === 'preview') {
    const isTrading = preview.compatibleExecutionModes.length > 0;
    return (
      <Modal
        title={`${blueprint.name} — Preview`}
        onClose={onClose}
        placement="top"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '560px' }}>
          {/* Basic info */}
          <SectionLabel>Blueprint</SectionLabel>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <KV label="Kind" value={preview.kind} />
            {preview.rawPayload.strategyType != null ? <KV label="Strategy" value={String(preview.rawPayload.strategyType)} /> : null}
            {preview.rawPayload.style != null ? <KV label="Style" value={String(preview.rawPayload.style)} /> : null}
          </div>

          {/* Description */}
          {preview.rawPayload.description != null && (
            <div>
              <SectionLabel>Description</SectionLabel>
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                {String(preview.rawPayload.description)}
              </div>
            </div>
          )}

          {/* Execution mode */}
          {isTrading && (
            <>
              <SectionLabel>Execution</SectionLabel>
              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                <KV label="Resolved mode" value={preview.selectedResolvedMode ?? '—'} />
                <KV label="Compatible modes" value={preview.compatibleExecutionModes.join(', ') || 'none'} />
              </div>
            </>
          )}

          {/* Risk: raw vs effective */}
          {preview.rawRisk && (
            <>
              <SectionLabel>Risk Profile</SectionLabel>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                Shows the blueprint author's raw risk values and the effective values after applying defaults and operator ceilings.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.8125rem' }}>
                <div style={{ fontWeight: '600', color: 'var(--color-text-muted)' }}>Field</div>
                <div style={{ fontWeight: '600', color: 'var(--color-text-muted)' }}>Raw → Effective</div>
                {renderRiskRows(preview.effectiveRisk, preview.rawRisk)}
              </div>
            </>
          )}

          {/* Required inputs */}
          {preview.requiredPrivateInputs.length > 0 && (
            <>
              <SectionLabel>Required</SectionLabel>
              <div style={{ color: 'var(--color-warning)', fontSize: '0.8125rem' }}>
                {preview.requiredPrivateInputs.join('; ')}
              </div>
            </>
          )}

          {/* Warnings */}
          {preview.validationWarnings.filter((w) => w.length > 0).length > 0 && (
            <>
              <SectionLabel>Warnings</SectionLabel>
              {preview.validationWarnings.filter((w) => w.length > 0).map((w, i) => (
                <div key={i} style={{ color: 'var(--color-warning)', fontSize: '0.75rem' }}>⚠ {w}</div>
              ))}
            </>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '8px' }}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" onClick={handleEdit}>Edit…</Button>
              <Button variant="primary" onClick={handleConfirm}>Continue</Button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Render edit ─────────────────────────────────────────────────────
  if (step === 'edit') {
    const isTrading = preview.compatibleExecutionModes.length > 0;
    const connections = connectionsQuery.data ?? [];
    return (
      <Modal
        title="Customize agent"
        onClose={onClose}
        placement="top"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '560px' }}>
          {/* Name */}
          <FieldLabel>Name</FieldLabel>
          <input
            value={edits.name}
            onChange={(e) => setEdits((prev) => ({ ...prev, name: e.target.value }))}
            style={inputStyle}
            placeholder="Agent name"
          />

          {/* Risk overrides */}
          {editableRiskFields.length > 0 && (
            <>
              <SectionLabel>Risk overrides</SectionLabel>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                Only mutable fields are shown. Operator ceilings are enforced.
              </div>
              {editableRiskFields.map(([key, field]) => (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                    <span style={{ color: 'var(--color-text-secondary)', fontWeight: '500' }}>
                      {formatRiskFieldLabel(key)}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      Default: {field.effectiveValue ?? '—'}
                      {field.operatorCeiling != null ? ` (max: ${field.operatorCeiling})` : ''}
                    </span>
                  </div>
                  <input
                    value={edits.riskOverrides[key] ?? ''}
                    onChange={(e) => handleRiskChange(key, e.target.value)}
                    style={{ ...inputStyle, maxWidth: '200px' }}
                    placeholder={String(field.effectiveValue ?? '')}
                    type="number"
                    step="any"
                  />
                </div>
              ))}
            </>
          )}

          {/* Connection selection (trading agents only) */}
          {isTrading && preview.kind === 'agent' && (
            <>
              <SectionLabel>Trading connections</SectionLabel>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                Select active connections for this agent to trade through.
              </div>
              {connectionsQuery.isLoading && <LoadingRows count={2} />}
              {connectionsQuery.isError && (
                <ErrorBanner message={(connectionsQuery.error as Error).message} />
              )}
              {connectionsQuery.isSuccess && connections.length === 0 && (
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                  No active connections available. Set up a connection first.
                </div>
              )}
              {connectionsQuery.isSuccess && connections.map((conn) => (
                <label
                  key={conn.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    background: 'var(--color-surface-2)',
                    borderRadius: '7px',
                    cursor: 'pointer',
                    fontSize: '0.8125rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedConnectionIds.includes(conn.id)}
                    onChange={() => {
                      setSelectedConnectionIds((prev) =>
                        prev.includes(conn.id)
                          ? prev.filter((id) => id !== conn.id)
                          : [...prev, conn.id],
                      );
                    }}
                  />
                  <span style={{ fontWeight: '500' }}>{conn.label}</span>
                  <span style={{ color: 'var(--color-text-muted)', fontSize: '0.6875rem' }}>({conn.provider})</span>
                </label>
              ))}
            </>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '8px' }}>
            <Button variant="secondary" onClick={handleBackToPreview}>Back</Button>
            <Button variant="primary" onClick={handleConfirm}>Review</Button>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Render confirm ──────────────────────────────────────────────────
  if (step === 'confirm') {
    const isTrading = preview.compatibleExecutionModes.length > 0;
    return (
      <Modal
        title="Confirm instantiation"
        onClose={onClose}
        placement="top"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '560px' }}>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            Review the configuration below. This will create a <strong>stopped</strong> agent. You can review and start it from the Agents page.
          </div>

          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <KV label="Name" value={edits.name || blueprint.name} />
            <KV label="Kind" value="Agent" />
            {preview.selectedResolvedMode && <KV label="Mode" value={preview.selectedResolvedMode} />}
          </div>

          {selectedConnectionIds.length > 0 && (
            <>
              <SectionLabel>Connections</SectionLabel>
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-primary)' }}>
                {selectedConnectionIds.length} connection(s) selected
              </div>
            </>
          )}

          {Object.keys(edits.riskOverrides).length > 0 && (
            <>
              <SectionLabel>Risk overrides</SectionLabel>
              {Object.entries(edits.riskOverrides).map(([key, val]) => (
                <KV key={key} label={formatRiskFieldLabel(key)} value={val} />
              ))}
            </>
          )}

          {isTrading && selectedConnectionIds.length === 0 && (
            <div style={{ color: 'var(--color-warning)', fontSize: '0.75rem' }}>
              ⚠ No trading connections selected. The agent will be created but may need connections to trade.
            </div>
          )}

          {instantiateMutation.isError && (
            <ErrorBanner message={error ?? 'Instantiation failed.'} />
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '8px' }}>
            <Button variant="secondary" onClick={handleEdit} disabled={instantiateMutation.isPending}>Back to edit</Button>
            <Button
              variant="primary"
              onClick={handleInstantiate}
              disabled={instantiateMutation.isPending}
            >
              {instantiateMutation.isPending ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatRiskFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    maxOpenPositions: 'Max open positions',
    maxPositionSizePct: 'Max position size %',
    stopLossPct: 'Stop loss %',
    stopLossCooldownMs: 'Stop loss cooldown (ms)',
    maxDrawdownPct: 'Max drawdown %',
    dailyMaxLossPct: 'Daily max loss %',
    maxNewPositionsPerDay: 'Max new positions/day',
    avoidParabolicMovePct: 'Avoid parabolic move %',
    maxOrderNotional: 'Max order notional',
  };
  return labels[key] ?? key;
}

function renderRiskRows(
  effective: EffectiveRiskProfile,
  raw: Record<string, unknown> | null,
): React.ReactNode[] {
  const keys = Object.keys(effective) as Array<keyof EffectiveRiskProfile>;
  return keys.map((key) => {
    const field = effective[key];
    const rawVal = raw?.[key] ?? null;
    const rawDisplay = rawVal !== null && rawVal !== undefined ? String(rawVal) : '—';
    const effDisplay = field.effectiveValue !== null && field.effectiveValue !== undefined
      ? String(field.effectiveValue)
      : '—';
    const mutableMark = field.mutable ? '' : ' 🔒';
    return (
      <>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem' }}>
          {formatRiskFieldLabel(key)}{mutableMark}
        </div>
        <div style={{ fontSize: '0.75rem' }}>
          <span style={{ color: 'var(--color-text-muted)' }}>{rawDisplay}</span>
          {' → '}
          <span style={{ color: 'var(--color-text-primary)', fontWeight: '500' }}>{effDisplay}</span>
        </div>
      </>
    );
  });
}
