# Plan: Wallet Funding Documentation & Post-Creation Links

**Date**: 2026-08-08
**Status**: Accepted
**Scope**: Wallet funding ONLY. Telegram chat ID aspects are OUT OF SCOPE for this plan.

---

## Summary

Add a public documentation page covering how to fund wallets across all supported trading venues, then link users to it at the right moment in the agent creation experience:

1. **Single funding page** — One markdown page with per-venue sections and anchor links, under the `trading-venues` docs group
2. **Chat flow enhancement** — Add "Learn more about funding" link to the `wallet_created` confirm card in `GuidedSetupActionRenderer`
3. **Agent detail page banner** — Show a dismissible funding reminder on the agent detail page when the agent has trading connections with wallets

Scope covers ALL wallet types: platform-generated direct wallets (Hyperliquid, Jupiter, 1inch) AND user-provided credentials/wallets (Bybit API keys, self-custodied wallets).

---

## Venues & Wallet Types

| Venue | Wallet Generation | Credential-Based | Network | Gas Token | Trading Token |
|---|---|---|---|---|---|
| **Hyperliquid** | Yes (`walletGeneration.enabled: true`) | Yes (API key + secret + walletAddress) | Hyperliquid L1 (Arbitrum bridge) | None (gasless for spot) | USDC |
| **Jupiter** | Yes (`walletGeneration.enabled: true`) | Yes (connect own Solana wallet) | Solana mainnet | SOL | USDC, SOL |
| **1inch** | Yes (`walletGeneration.enabled: true`) | Yes (connect own EVM wallet) | Base (chainId 8453) | ETH (on Base) | USDC, ETH |
| **Bybit** | No | Yes (API key + secret) | N/A (centralized) | N/A | USDT, USDC (deposit to Bybit) |

### Funding Instruction IDs (from `apps/api/src/providers/registry.ts`)

Derived by `getProviderWalletGenerationCapability()`:

- `hyperliquid-mainnet` → "Fund this wallet by sending USDC to the address on Hyperliquid." *(explicit frontend match)*
- `solana-mainnet` → "Fund this wallet by sending SOL or USDC to the address on Solana." *(explicit frontend match)*
- `1inch-8453` (dynamic: `1inch-{chainId}`) → falls through to generic fallback: "Fund this wallet by sending tokens to the address on Base." in `GuidedSetupActionRenderer.tsx:64` — the funding doc fills the gap with ETH+USDC specifics.

---

## Work Items

### A. Public Documentation Page

Add one new markdown file at `apps/web/src/features/public-pages/content/en/docs/trading-venues/funding-wallets.md`.

#### A1. Registry Update (`contentRegistry.ts`)

Add a single entry under the `trading-venues` group:

```typescript
'trading-venues/funding-wallets': { title: 'Funding Your Wallets' },
```

Route auto-generates: `/docs/trading-venues/funding-wallets`. The `MarkdownPage` heading renderer auto-generates `id` attributes from headings — `## Hyperliquid` becomes `#hyperliquid` — so per-venue deep links work without extra code.

#### A2. Content Outline (single page, per-venue sections)

```
# Funding Your Wallets

## Hyperliquid
### Platform-generated wallet (OpenAIdom creates it)
- What to send: USDC via Arbitrum bridge
- Where to find the address: Settings → Connections, or the wallet-created card in chat
- Confirmation: ~2-5 min after Arbitrum finality
- Minimum recommended: $50 USDC

### User-provided API keys
- Fund your Hyperliquid account via the standard Arbitrum bridge or exchange withdrawal
- See [Hyperliquid](/docs/trading-venues/hyperliquid) for connection setup

### Gas & fees
- Hyperliquid is gasless for spot USDC transfers
- Trading fees: maker/taker (see hyperliquid.xyz)

## Jupiter
### Platform-generated wallet (OpenAIdom creates it)
- What to send: SOL (for gas) + USDC (for trading)
- Where to send from: any Solana wallet or exchange
- Confirmation: ~1-2 seconds (Solana)
- Minimum recommended: 0.05 SOL + $20 USDC

### User-provided wallet
- Ensure your connected Solana wallet holds SOL + USDC
- See [Jupiter](/docs/trading-venues/jupiter) for connection setup

### Gas & fees
- SOL for transaction fees (~0.000005 SOL per tx)
- Jupiter aggregates routes for best swap prices

## 1inch
### Platform-generated wallet (OpenAIdom creates it)
- What to send: ETH (for gas on Base) + USDC (for trading)
- Where to bridge from: Ethereum mainnet via Base Bridge, or send from exchange
- Confirmation: ~2-3 min (Base L2)
- Minimum recommended: 0.01 ETH + $20 USDC

### User-provided wallet
- Ensure your EVM wallet on Base holds ETH + USDC
- See [1inch](/docs/trading-venues/1inch) for connection setup

### Gas & fees
- ETH on Base for transaction fees
- 1inch aggregates across DEXs for best rates

## Bybit
- Bybit uses API keys only — no platform-generated wallets
- Fund your Bybit account via Bybit's standard deposit flow (USDT or USDC)
- See [Bybit](/docs/trading-venues/bybit) for connection setup
```

#### A3. Cross-link from existing venue pages

Add a short "See also: [Funding Your Wallets](/docs/trading-venues/funding-wallets)" line at the bottom of each existing venue doc (`hyperliquid.md`, `jupiter.md`, `1inch.md`, `bybit.md`).

Also add a reference from `trading-venues/index.md`.

---

### B. Chat Flow Enhancement (`GuidedSetupActionRenderer.tsx`)

**File**: `apps/web/src/features/chat/GuidedSetupActionRenderer.tsx`

**Current state**: The `wallet_created` confirm card shows address, network, and a one-line funding instruction. No link to documentation.

**Change**: Add a "Learn more →" link at the bottom of the `wallet_created` card that points to the funding page with the correct venue anchor.

#### Implementation:

```typescript
// Resolve funding doc URL from fundingInstructionId or provider name.
// Uses prefix matching for 1inch (ID is dynamic: 1inch-8453, 1inch-42161, etc.).
function resolveFundingDocUrl(fundingId: string, provider: string): string {
  const BASE = '/docs/trading-venues/funding-wallets';
  if (fundingId === 'hyperliquid-mainnet') return `${BASE}#hyperliquid`;
  if (fundingId === 'solana-mainnet') return `${BASE}#jupiter`;
  if (fundingId.startsWith('1inch-') || provider === '1inch') return `${BASE}#1inch`;
  return BASE;
}
```

Then add the link after the existing funding instruction text:

```tsx
<a
  href={resolveFundingDocUrl(fundingId, providerName)}
  target="_blank"
  rel="noopener noreferrer"
  style={{ fontSize: 13, color: 'var(--color-primary)', marginTop: 8, display: 'inline-block' }}
>
  Learn more about funding {displayName} wallets →
</a>
```

#### Edge cases:
- Unknown `fundingInstructionId` + unknown provider → link to `/docs/trading-venues/funding-wallets` (no anchor)
- `target="_blank"` preserves chat state mid-flow

---

### C. Agent Detail Page Banner (`AgentDetailPage.tsx`)

**File**: `apps/web/src/features/agents/AgentDetailPage.tsx`

**Goal**: After agent creation, show a dismissible funding reminder when the agent has trading connections with wallets.

#### Detection approach

**Option 1 — Provider catalog check.** Fetch `providerCatalogApi.get()`, check `walletGeneration.available` for the agent's venue. Conservative but simple — may show banner for user-provided wallets too, which is acceptable as a helpful reminder. Banner wording covers both cases.

#### Venue resolution

Primary: `agent.executionVenue`. Fallback: query `connectionsApi.list()` and match by `tradingCapability.connectionId` to find the provider. If neither works, link to the funding page without an anchor.

#### Implementation:

1. Add `providerCatalogQuery` to `AgentDetailPage`
2. Derive `showFundingBanner`:
   ```typescript
   const venueHasWalletGeneration = (venue: string): boolean => {
     const provider = providerCatalogQuery.data?.providers.find(p => p.id === venue);
     return provider?.walletGeneration?.available === true;
   };

   const showFundingBanner = hasTradingCapability
     && tradingCapability?.connectionId != null
     && venueHasWalletGeneration(resolvedVenue);
   ```
3. Dismissible per-agent via `localStorage` key `funding-banner-dismissed-${agentId}`
4. Render after `runtimeAlert` / `lifecycleError` banners:
   ```tsx
   {showFundingBanner && !fundingBannerDismissed && (
     <Card style={{ padding: '12px 16px', background: 'var(--color-surface-info)', border: '1px solid var(--color-info)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
       <span style={{ fontSize: 13 }}>
         💳 Your trading wallet may need funding before live trading.{' '}
         <a href={fundingDocUrl} target="_blank" rel="noopener noreferrer">
           Learn how to fund →
         </a>
       </span>
       <Button variant="ghost" size="sm" onClick={() => dismiss()}>Dismiss</Button>
     </Card>
   )}
   ```

---

### D. Post-Creation from Form Flow (No changes needed)

The form-based `CreateAgentFlow` does NOT create wallets during agent creation. The agent detail page banner (Work Item C) catches users post-creation.

---

## Files to Change

| File | Change |
|---|---|
| `apps/web/src/features/public-pages/content/en/docs/trading-venues/funding-wallets.md` | **NEW** — single funding page |
| `apps/web/src/features/public-pages/contentRegistry.ts` | Add 1 entry: `trading-venues/funding-wallets` |
| `apps/web/src/features/public-pages/content/en/docs/trading-venues/hyperliquid.md` | Add "See also" link |
| `apps/web/src/features/public-pages/content/en/docs/trading-venues/jupiter.md` | Add "See also" link |
| `apps/web/src/features/public-pages/content/en/docs/trading-venues/1inch.md` | Add "See also" link |
| `apps/web/src/features/public-pages/content/en/docs/trading-venues/bybit.md` | Add "See also" link |
| `apps/web/src/features/public-pages/content/en/docs/trading-venues/index.md` | Add funding guide reference |
| `apps/web/src/features/chat/GuidedSetupActionRenderer.tsx` | Add "Learn more" link to `wallet_created` card |
| `apps/web/src/features/agents/AgentDetailPage.tsx` | Add funding reminder banner |

---

## Out of Scope

- Telegram chat ID documentation
- Telegram chat ID auto-fill in create-agent flow
- Post-creation Telegram setup links
- Form-flow post-creation step (covered by agent detail banner)
- Backend API changes to expose wallet custody info

---

## Resolved Questions

1. **Funding instruction IDs** — Confirmed in `apps/api/src/providers/registry.ts` (`getProviderWalletGenerationCapability`): Hyperliquid = `hyperliquid-mainnet` (static), Jupiter = `solana-mainnet` (static), 1inch = `1inch-{chainId}` (dynamic, `1inch-8453` for default Base config).

2. **Funding text** — Confirmed in `GuidedSetupActionRenderer.tsx:58-64`. Hyperliquid and Jupiter have explicit matches; 1inch falls through to generic "Fund this wallet by sending tokens..." fallback. The funding doc fills the ETH+USDC gap.

3. **Bybit funding** — No separate page. A brief section in the single funding-wallets page and a note in the existing Bybit venue page suffice.

4. **Venue detection on agent detail page** — Use `agent.executionVenue` as primary, fall back to `connectionsApi.list()` matching by `connectionId`.

5. **Banner dismissal scope** — Per-agent via `localStorage` key `funding-banner-dismissed-${agentId}`.

6. **`wallet_created` card link target** — `target="_blank"` to preserve chat state.

