export const WALLET_NETWORKS = {
  hyperliquid: 'Hyperliquid',
  jupiter: 'Solana',
} as const;

export type WalletNetworkProvider = keyof typeof WALLET_NETWORKS;

/** The chain a provider's generated trading wallet lives on, or undefined if the provider has none. */
export function walletNetworkForProvider(providerId: string): string | undefined {
  return Object.hasOwn(WALLET_NETWORKS, providerId) ? WALLET_NETWORKS[providerId as WalletNetworkProvider] : undefined;
}
