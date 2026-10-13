import { describe, expect, it } from 'vitest';
import { listProvidersTool, projectProviders } from './connections.js';
import type { ToolContext } from '@herobids/domain';

describe('list_providers', () => {
  it('hides trading providers without a trading skill or explicit filter', () => {
    expect(projectProviders([], undefined, false).map((provider) => provider.provider)).toEqual(['gmail']);
    expect(projectProviders([], 'trading', false).map((provider) => provider.provider)).toEqual([
      'hyperliquid', 'bybit', '1inch', 'jupiter',
    ]);
    expect(projectProviders([], 'email', true).map((provider) => provider.provider)).toEqual(['gmail']);
  });

  it('distinguishes an active owner connection from an agent grant', () => {
    const providers = projectProviders([
      { provider: 'gmail', connectionId: 'owner-connection', granted: false },
      { provider: 'hyperliquid', connectionId: 'agent-connection', granted: true },
    ], undefined, true);
    expect(providers.find((provider) => provider.provider === 'gmail')).toMatchObject({
      hasActiveConnection: true, grantedToThisAgent: false, authMethod: 'oauth',
    });
    expect(providers.find((provider) => provider.provider === 'hyperliquid')).toMatchObject({
      hasActiveConnection: true, grantedToThisAgent: true,
    });
    expect(providers.find((provider) => provider.provider === 'bybit')).toMatchObject({
      hasActiveConnection: false, grantedToThisAgent: false,
    });
  });

  it('only advertises generated wallets when enabled by the operator', () => {
    expect(projectProviders([], 'trading', false).find((provider) => provider.provider === 'hyperliquid')?.authMethod).toBe('api_key');
    expect(projectProviders([], 'trading', false, ['hyperliquid']).find((provider) => provider.provider === 'hyperliquid')?.authMethod).toBe('generated_wallet');
  });

  it('does not imply that an unavailable database means no connections', async () => {
    const result = await listProvidersTool.execute({}, { agentId: 'agent-1' } as ToolContext);
    expect(result).toMatchObject({ success: false, errorCode: 'precondition.not_ready' });
  });
});