/**
 * Tests for the inline trading-setup escape hatch in the Create Agent flow.
 *
 * When no trading bindings are available while creating an agent that requires
 * trading capability, a "Set up trading now" button appears. On successful
 * completion of the inline setup, the Create Agent flow should:
 *   1. Invalidate the trading bindings query (forces a refetch).
 *   2. Auto-select the newly created binding in the agent intent state.
 *
 * These tests cover:
 *   - Auto-select logic: ProviderSetupResult with tradingBinding → id extracted
 *   - Edge case: result without tradingBinding leaves tradingBindingId unchanged
 *   - Available bindings filter: only bindings with active connection AND binding
 *     status are eligible for selection (mirrors the filter in CreateAgentFlow)
 */

import { describe, expect, it } from 'vitest';
import type { ProviderSetupResult, TradingBindingSummary } from '../../lib/api-client.js';
import { createAgentUsesInheritedModels, resolveCreateAgentModelPayload } from './create-agent-models.js';
import { resolveCreateAgentBindingId } from './agent-payloads.js';
import { resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';

// ---------------------------------------------------------------------------
// Auto-select logic
// ---------------------------------------------------------------------------

describe('Create Agent — inline setup auto-select logic', () => {
  it('returns the trading binding id when the setup result includes one', () => {
    const result: ProviderSetupResult = {
      credential: {
        id: 'cred-1',
        venue: 'hyperliquid',
        label: 'My Cred',
        createdAt: '2026-06-10T00:00:00Z',
      },
      connection: {
        id: 'conn-1',
        provider: 'hyperliquid',
        label: 'My Account',
        status: 'active',
        credentialId: 'cred-1',
        createdAt: '2026-06-10T00:00:00Z',
      },
      tradingBinding: {
        id: 'binding-1',
        connectionId: 'conn-1',
        provider: 'hyperliquid',
        label: 'My Account',
        sourceVenueAccountId: 'va-1',
        status: 'active',
        createdAt: '2026-06-10T00:00:00Z',
      },
    };
    expect(resolveCreateAgentBindingId(result.tradingBinding)).toBe('binding-1');
  });

  it('returns null when the setup result has no trading binding (capability not provisioned)', () => {
    const result: ProviderSetupResult = {
      credential: {
        id: 'cred-1',
        venue: 'hyperliquid',
        label: 'My Cred',
        createdAt: '2026-06-10T00:00:00Z',
      },
      connection: {
        id: 'conn-1',
        provider: 'hyperliquid',
        label: 'My Account',
        status: 'active',
        credentialId: 'cred-1',
        createdAt: '2026-06-10T00:00:00Z',
      },
    };
    expect(resolveCreateAgentBindingId(result.tradingBinding)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Available bindings filter (mirrors CreateAgentFlow)
// ---------------------------------------------------------------------------

describe('Create Agent — available trading bindings filter', () => {
  /**
   * Mirrors the availableTradingBindings derivation in CreateAgentFlow:
   *   (tradingBindingsQuery.data?.bindings ?? []).filter(
   *     (binding) => binding.status === 'active' && binding.connectionStatus === 'active',
   *   )
   *
   * This filter determines whether the "Set up trading now" escape hatch is shown
   * (length === 0) or whether the binding selector is shown (length > 0).
   */
  function filterAvailableBindings(bindings: TradingBindingSummary[]): TradingBindingSummary[] {
    return bindings.filter(
      (binding) => binding.status === 'active' && binding.connectionStatus === 'active',
    );
  }

  function makeBinding(overrides: Partial<TradingBindingSummary> = {}): TradingBindingSummary {
    return {
      bindingId: 'binding-1',
      connectionId: 'conn-1',
      provider: 'hyperliquid',
      label: 'My Account',
      bindingRef: null,
      bindingProfile: null,
      sourceVenueAccountId: null,
      connectionStatus: 'active',
      status: 'active',
      family: 'trading',
      ...overrides,
    };
  }

  it('includes a binding where both status and connectionStatus are active', () => {
    const result = filterAvailableBindings([makeBinding()]);
    expect(result).toHaveLength(1);
  });

  it('excludes a binding whose status is revoked', () => {
    const result = filterAvailableBindings([makeBinding({ status: 'revoked' })]);
    expect(result).toHaveLength(0);
  });

  it('excludes a binding whose connectionStatus is revoked', () => {
    const result = filterAvailableBindings([makeBinding({ connectionStatus: 'revoked' })]);
    expect(result).toHaveLength(0);
  });

  it('returns an empty array when no bindings exist — this is the condition that triggers the escape hatch', () => {
    expect(filterAvailableBindings([])).toHaveLength(0);
  });

  it('keeps only the qualifying binding from a mixed list', () => {
    const bindings = [
      makeBinding({ bindingId: 'b-active', status: 'active', connectionStatus: 'active' }),
      makeBinding({ bindingId: 'b-revoked-binding', status: 'revoked', connectionStatus: 'active' }),
      makeBinding({ bindingId: 'b-revoked-conn', status: 'active', connectionStatus: 'revoked' }),
    ];
    const result = filterAvailableBindings(bindings);
    expect(result).toHaveLength(1);
    expect(result[0]!.bindingId).toBe('b-active');
  });
});

// ---------------------------------------------------------------------------
// Review gate + model summary
// ---------------------------------------------------------------------------

describe('Create Agent — review gate and model summary', () => {
  const availableProviders = [
    {
      provider: 'openrouter',
      isMultiProvider: true,
      models: [
        { id: 'gpt-4o-mini' },
        { id: 'gpt-4o' },
      ],
    },
  ];

  function canProceedToReview(intent: {
    name: string;
    goal: string;
  }): boolean {
    return Boolean(
      intent.name.trim() && intent.goal.trim(),
    );
  }

  function formatModelReview(intent: {
    provider: string;
    lightModel: string;
    heavyModel: string;
    modelInherited: boolean;
  }): string {
    return intent.modelInherited ? 'Inherits your saved model settings' : `${intent.provider}: ${intent.lightModel} / ${intent.heavyModel}`;
  }

  it('blocks review until both name and goal are present', () => {
    expect(canProceedToReview({ name: '', goal: 'Trade BTC' })).toBe(false);
    expect(canProceedToReview({ name: 'market-watch-01', goal: 'Trade BTC' })).toBe(true);
    expect(canProceedToReview({ name: 'market-watch-01', goal: '  ' })).toBe(false);
    expect(canProceedToReview({ name: '  ', goal: 'Trade BTC' })).toBe(false);
  });

  it('formats the review summary with the provider and both model tiers', () => {
    expect(
      formatModelReview({ provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o', modelInherited: false }),
    ).toBe('openai: gpt-4o-mini / gpt-4o');
    expect(formatModelReview({ provider: '', lightModel: '', heavyModel: '', modelInherited: true })).toBe('Inherits your saved model settings');
  });

  it('treats unchanged saved settings as inherited instead of an explicit override', () => {
    expect(createAgentUsesInheritedModels(
      { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    )).toBe(true);
  });

  it('omits model override fields from create payload when the selection still matches saved settings', () => {
    expect(resolveCreateAgentModelPayload(
      { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
      { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    )).toEqual({ inherits: true });
  });

  it('sends explicit override fields when the selection differs from saved settings', () => {
    expect(resolveCreateAgentModelPayload(
      { provider: 'anthropic', lightModel: 'claude-haiku-3-5', heavyModel: 'claude-sonnet-4-5' },
      { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    )).toEqual({
      inherits: false,
      provider: 'anthropic',
      lightModel: 'claude-haiku-3-5',
      heavyModel: 'claude-sonnet-4-5',
    });
  });

  it('keeps create payload inherited when no provider has been explicitly selected yet', () => {
    expect(resolveCreateAgentModelPayload(
      { provider: '', lightModel: '', heavyModel: '' },
      null,
    )).toEqual({ inherits: true });
  });

  it('treats the auto-selected multi-provider default as an explicit override in create flow', () => {
    const defaultSelection = resolveDefaultModelSelection(availableProviders);

    expect(defaultSelection).toEqual({
      provider: 'openrouter',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });

    expect(resolveCreateAgentModelPayload(defaultSelection!, null)).toEqual({
      inherits: false,
      provider: 'openrouter',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });
  });
});
