Herobids has already cleared the biggest architectural reasons you started it: it supports perps and multi-venue trading in concrete code, and the packaged momentum strategy can go both long and short in momentum.ts. It also already covers a lot of old platform surface that is not a gap anymore: OAuth/auth in auth.ts, WebSocket events in events.ts, backtests in backtests.ts, analytics in analytics.ts, exports in exports.ts, generic encrypted credentials in credentials.ts, and concrete venue adapters in packages/venues/src.

The real gaps versus `aitradingbot` are narrower and more practical.

- Done - DEX token-safety and canonical asset guardrails
- Done - Always-on discovery/coordinator/monitor loop


| Gap | What I found | Effort | Bang for buck | Take |
|---|---|---:|---:|---|
| Rich strategy-stack parity | Old repo had a full strategy layer around mechanical, hybrid, regime, sentiment, and playbook validation in mechanical-engine.ts, hybrid-engine.ts, sentiment.ts, and regime.ts. Herobids currently exports only `MomentumStrategy` and `LlmStrategy` in index.ts. | M-L | Very high | This is the biggest product gap if you want profitability beyond “LLM decides” and simple momentum. |
| DEX token-safety and canonical asset guardrails | Old repo had explicit token safety, canonical token promotion, age/liquidity/volume gates, and force-override flow in token-safety.ts. Herobids token search in token-search.ts is much thinner: liquidity filter, optional network filter, sort, dedupe. | S-M | Very high | If memecoins and DEX are core, this is one of the fastest high-value upgrades. |
| Always-on discovery/coordinator/monitor loop | Old repo actually booted a `MarketDataCoordinator` and `MarketMonitor` from server.ts. Herobids has good discovery primitives in discovery.ts and a strong registry in provider-registry.ts, but I did not find an equivalent always-on orchestration service. | M | High | Important if agents should discover opportunities continuously rather than only when explicitly prompted. |
| Wallet/self-custody UX for spot DEX flows | Old repo had wallet generation/import and wallet CRUD as a first-class surface, including `generate-wallet` in its README and wallet modules under `/src/wallet` and `/src/wallets`. In herobids I found generic credentials and trading bindings, but I did not find an equivalent wallet module or bootstrap flow. | M | Medium | This matters if Solana/Base spot remains strategic, less so if the center of gravity is perps/CEX. |
| Binding-first startup/restart cleanup | This is a herobids-native gap, but it matters for parity in operational robustness. Your own pending plan 025-trading-binding-native-bot-startup-follow-through.md says startup is still partly `venueAccountId`-first in the worker path. | M | Medium-High | Less flashy than strategy work, but directly improves runtime reliability and migration cleanliness. |
| Deployment/runtime parity with old operator modes | Old repo had Docker, PM2, and ECS-facing operator surfaces in architecture.md and deployment.md. Herobids has Docker-first runtime code in docker-agent-manager.ts and a high-level system note in docs/tech/architecture/README.md, but I did not find ECS manager code or PM2-style deployment parity. | L-XL | Low-Medium | Worth doing for scale/ops, but not the best next product investment unless infra is your immediate bottleneck. |

If I rank these by priority, I’d do them in this order:

1. DEX token-safety and canonical search guardrails.
2. Rich strategy-stack parity, especially hybrid/mechanical plus sentiment-aware filtering.
3. Always-on discovery/coordinator/monitor orchestration.
4. Binding-first startup cleanup.
5. Wallet/self-custody UX for spot.
6. ECS/PM2 deployment parity.

The reason for that order is simple: `aitradingbot`’s missing short side is already fixed in herobids, so the biggest remaining commercial upside is not infrastructure. It is better opportunity selection and safer DEX execution. Herobids already has the raw pieces for that: regime evaluation in regime.ts, discovery in discovery.ts, and multiple venue adapters in packages/venues/src. What it has not yet rebuilt is the old repo’s opinionated layer that turns those primitives into repeatable edge.