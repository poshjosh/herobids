import { beforeEach, describe, expect, it } from 'vitest';
import {
  saveEditAgentOAuthDraft,
  loadEditAgentOAuthDraft,
  clearEditAgentOAuthDraft,
  applyOAuthReturnToForm,
} from './edit-agent-oauth-draft.js';
import type { AgentFormState } from './agent-form-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSessionStorage() {
  const store = new Map<string, string>();
  const storage: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => {
      const keys = [...store.keys()];
      return keys[index] ?? null;
    },
  };
  // @ts-expect-error — minimal window mock for Node test environment
  globalThis.window = { sessionStorage: storage };
  return store;
}

function makeFormState(overrides: Partial<AgentFormState> = {}): AgentFormState {
  return {
    name: 'Test Agent',
    goal: 'Trade breakouts on BTC.',
    capabilityMode: 'intelligence',
    hybridMode: undefined,
    technicalPreFilterEnabled: false,
    technicalConfig: {
      filters: { venue: '', venueType: '', symbols: [], portfolioMaxPct: '', minLiquidity: '' },
      indicators: { rsi: { enabled: false, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 }, macd: { enabled: false, fast: 12, slow: 26, signal: 9, histogramRising: false, bullishCrossover: false, bearishCrossover: false }, volume: { enabled: false, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 }, choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, confirmBars: 2, rejectOnBearish: false }, supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 }, confidence: { rsiWeight: 0.15, macdCrossoverWeight: 0.2, macdIncreasingWeight: 0.1, volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15, chochBearishPenalty: 0.1, priceActionWeight: 0.1, minConfidence: 0.45, minReasons: 2 } },
      candles: { interval: '15m', limit: 100 },
      signalBias: 'trend-following',
      scanIntervalMs: 60_000,
      scanBatchSize: 5,
    },
    skillIds: ['trading'],
    connectionIds: ['conn-1'],
    executionMode: 'test',
    capital: '1500',
    telegramChatId: '',
    emailDelivery: 'inherit',
    costPreset: 'balanced',
    dailySpendBudgetUsd: '0.5',
    tickIntervalMins: '15',
    dailyMaxLossPct: '5',
    maxDrawdownPct: '15',
    maxSlippageBps: '25',
    maxOpenPositions: '5',
    maxPositionSizePct: '100',
    stopLossPct: '10',
    stopLossCooldownSecs: '300',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    strategyPreset: '',
    platformAssessmentEnabled: false,
    platformAssessmentReviewIntervalHours: '24',
    subscribedSources: ['watch_threshold'],
    pendingFiles: [],
    authorizationMode: 'direct',
    ...overrides,
  };
}

function makeDraft(overrides: Partial<{
  agentId: string;
  form: Partial<AgentFormState>;
  style: 'balanced' | 'bold' | 'careful';
  skillPreset: 'trading' | 'personal-assistant' | 'custom';
  modelOverrideEnabled: boolean;
  modelForm: { provider: string; lightModel: string; heavyModel: string };
}> = {}) {
  const formState = makeFormState(overrides.form ?? {});
  const { pendingFiles: _, ...serializableForm } = formState;
  return {
    agentId: overrides.agentId ?? 'agent-123',
    form: serializableForm,
    style: (overrides.style ?? 'balanced') as 'balanced' | 'bold' | 'careful',
    skillPreset: (overrides.skillPreset ?? 'trading') as 'trading' | 'personal-assistant' | 'custom',
    modelOverrideEnabled: overrides.modelOverrideEnabled ?? false,
    modelForm: overrides.modelForm ?? { provider: '', lightModel: '', heavyModel: '' },
    runtimePolicyOverrides: null,
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

describe('edit-agent-oauth-draft storage', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = mockSessionStorage();
  });

  it('saves and loads a valid draft', () => {
    const draft = makeDraft();
    saveEditAgentOAuthDraft(draft);

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toEqual(draft);
  });

  it('returns null when no draft has been saved', () => {
    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
  });

  it('clears a saved draft', () => {
    saveEditAgentOAuthDraft(makeDraft());
    clearEditAgentOAuthDraft();

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    store.set('edit-agent-oauth-draft-v1', 'not valid json');

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
  });

  it('returns null when agentId is missing', () => {
    const draft = makeDraft();
    const { agentId: _, ...withoutAgentId } = draft;
    store.set('edit-agent-oauth-draft-v1', JSON.stringify(withoutAgentId));

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
  });

  it('returns null when form object is missing', () => {
    store.set('edit-agent-oauth-draft-v1', JSON.stringify({ agentId: 'agent-123' }));

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
  });

  it('returns null when stored value is not an object', () => {
    store.set('edit-agent-oauth-draft-v1', '"just a string"');

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
  });

  it('uses a draft key distinct from create-agent draft', () => {
    const draft = makeDraft({ agentId: 'agent-edit' });
    saveEditAgentOAuthDraft(draft);

    // Simulate a create-agent draft at the same time
    store.set('create-agent-oauth-draft-v1', JSON.stringify({ step: 'intent', intent: {} }));

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toEqual(draft);
  });

  it('handles empty connectionIds in form', () => {
    const draft = makeDraft({ form: { connectionIds: [] } });
    saveEditAgentOAuthDraft(draft);

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded?.form.connectionIds).toEqual([]);
  });

  it('load returns null after clear, even with other keys present', () => {
    store.set('other-key', 'other-value');
    saveEditAgentOAuthDraft(makeDraft({ agentId: 'agent-xyz' }));
    clearEditAgentOAuthDraft();

    const loaded = loadEditAgentOAuthDraft();
    expect(loaded).toBeNull();
    expect(store.get('other-key')).toBe('other-value');
  });
});

// ---------------------------------------------------------------------------
// applyOAuthReturnToForm
// ---------------------------------------------------------------------------

describe('applyOAuthReturnToForm', () => {
  it('returns null when draft is null', () => {
    const current = makeFormState();
    const result = applyOAuthReturnToForm(current, null, 'new-conn', 'agent-123');
    expect(result).toBeNull();
  });

  it('returns null when draft agentId does not match', () => {
    const current = makeFormState();
    const draft = makeDraft({ agentId: 'agent-other' });
    const result = applyOAuthReturnToForm(current, draft, 'new-conn', 'agent-123');
    expect(result).toBeNull();
  });

  it('restores full form state from draft', () => {
    const current = makeFormState({
      name: 'Untouched',
      goal: '',
      capital: '',
      dailyMaxLossPct: '',
    });
    const draft = makeDraft({
      form: {
        name: 'Edited Name',
        goal: 'Edited goal text.',
        capital: '2000',
        dailyMaxLossPct: '3',
        connectionIds: ['conn-1'],
      },
    });

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result).not.toBeNull();
    expect(result!.form.name).toBe('Edited Name');
    expect(result!.form.goal).toBe('Edited goal text.');
    expect(result!.form.capital).toBe('2000');
    expect(result!.form.dailyMaxLossPct).toBe('3');
    expect(result!.form.connectionIds).toEqual(['conn-1']);
  });

  it('merges new connectionId from URL into restored draft connections', () => {
    const current = makeFormState();
    const draft = makeDraft({ form: { connectionIds: ['conn-1', 'conn-2'] } });

    const result = applyOAuthReturnToForm(current, draft, 'conn-3', 'agent-123');
    expect(result!.form.connectionIds).toEqual(['conn-1', 'conn-2', 'conn-3']);
  });

  it('deduplicates when new connectionId is already in draft', () => {
    const current = makeFormState();
    const draft = makeDraft({ form: { connectionIds: ['conn-1'] } });

    const result = applyOAuthReturnToForm(current, draft, 'conn-1', 'agent-123');
    expect(result!.form.connectionIds).toEqual(['conn-1']);
  });

  it('preserves current pendingFiles (typically empty)', () => {
    const current = makeFormState({ pendingFiles: [] });
    const draft = makeDraft();

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result!.form.pendingFiles).toEqual([]);
  });

  it('restores style from draft', () => {
    const current = makeFormState();
    const draft = makeDraft({ style: 'bold' });

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result!.style).toBe('bold');
  });

  it('restores skillPreset from draft', () => {
    const current = makeFormState();
    const draft = makeDraft({ skillPreset: 'personal-assistant' });

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result!.skillPreset).toBe('personal-assistant');
  });

  it('restores modelOverrideEnabled and modelForm from draft', () => {
    const current = makeFormState();
    const draft = makeDraft({
      modelOverrideEnabled: true,
      modelForm: { provider: 'openrouter', lightModel: 'flash', heavyModel: 'pro' },
    });

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result!.modelOverrideEnabled).toBe(true);
    expect(result!.modelForm).toEqual({ provider: 'openrouter', lightModel: 'flash', heavyModel: 'pro' });
  });

  it('uses draft connectionIds when no new connectionId is provided', () => {
    const current = makeFormState();
    const draft = makeDraft({ form: { connectionIds: ['conn-a', 'conn-b'] } });

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result!.form.connectionIds).toEqual(['conn-a', 'conn-b']);
  });

  it('uses empty array when draft has no connectionIds and no new connectionId', () => {
    const current = makeFormState({ connectionIds: ['existing'] });
    const draft = makeDraft({ form: { connectionIds: undefined } });

    const result = applyOAuthReturnToForm(current, draft, null, 'agent-123');
    expect(result!.form.connectionIds).toEqual([]);
  });
});
