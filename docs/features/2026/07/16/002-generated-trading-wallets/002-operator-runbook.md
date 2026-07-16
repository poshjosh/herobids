# Generated Trading Wallets Runbook

## Enablement

Wallet creation is disabled by default. Enable it per provider under `venues.<provider>.walletGeneration.enabled` in operator configuration. Jupiter and 1inch also require the matching operator developer key (`JUPITER_API_KEY` or `ONEINCH_API_KEY`); startup fails if either provider is enabled without its key.

Hyperliquid funding uses the displayed Hyperliquid mainnet EVM address. Jupiter funding uses the displayed Solana mainnet address. 1inch funding uses the configured 1inch chain, shown to the user as the wallet network. Creation does not bridge, sponsor gas, detect deposits, or mark a wallet ready to trade.

## Key Operations

Operator developer keys live only in resolved operator configuration. Rotate them through normal deploy configuration and restart API and worker processes together. Existing manual 1inch credentials remain supported as a temporary fallback when no operator key is configured.

Generated signing keys are encrypted in `user_credentials` and cannot be exported or recovered by this feature. Deleting or revoking a connection only removes platform access; it does not move funds, revoke external chain authority, or recover a wallet. Resolve any funded-wallet custody and recovery policy before enabling this feature in production.