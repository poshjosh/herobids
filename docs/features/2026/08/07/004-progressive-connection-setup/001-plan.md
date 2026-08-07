# Plan: Progressive Connection Setup — Intent-First, Not Form-First

**Feature:** Guided Setup UX simplification
**Date:** 2026-08-07
**Status:** Draft

## Summary

The Guided Setup chat currently throws the full `ProviderSetupForm` at users the moment they need a connection. This is overwhelming for new users and unhelpful for everyone — the LLM says "I've opened the form, fill it out" instead of guiding the user.

This plan restructures the connection flow around **progressive disclosure**: start with intent, narrow with simple choices, and only present the form as a last resort. It also introduces a **programmatic connection creation** path that generates wallets server-side with zero user input — no form, no secrets, no crypto knowledge required.

## The Three Personas

| Persona | Knows crypto? | Wants control? | Path |
|---|---|---|---|
| **Newbie** | No — "I just want to trade" | No — "Set it up for me" | Fast Track |
| **Informed, wants simplicity** | Yes — knows the landscape | Some — wants to pick venue | Guided |
| **Expert** | Yes — has API keys, knows venues | Full — "I want Hyperliquid" | Direct |

## Decision Tree

```
Q0: New to crypto, or know what you want?

├─ "I'm new — help me"          → FAST TRACK
│   └─ One question: Bitcoin / Ethereum / Memecoins / Not sure
│       └─ LLM auto-configures: venue + strategy + generated wallet + safe defaults
│           └─ Confirmation → create_agent
│
└─ "I know what I want"
    │
    ├─ User names a venue ("Hyperliquid")
    │   → DIRECT
    │   └─ Q: Existing wallet/API keys, or create one?
    │       ├─ "I have keys"  → request_connection_form (scoped, manual mode)
    │       └─ "Create one"   → create_connection (credentialMode: generated)
    │
    └─ User doesn't name a venue ("let me choose")
        → GUIDED
        ├─ Q1: Solana / EVM / not sure?          → narrows chain
        ├─ Q2: Long-only or long+short?          → narrows venue type
        │   → Venue locked
        └─ Q3: Existing wallet or create one?
            ├─ "I have one"  → request_connection_form (manual, scoped)
            └─ "Create one"  → create_connection (credentialMode: generated)
```

### Position in the Conversation Flow

The progressive connection flow replaces **step 4** of the existing trading-agent conversation flow (see `buildSystemPrompt()` in `apps/api/src/routes/chat.ts`). The rest of the flow is unchanged:

1. Preset selection (unchanged)
2. Capital (unchanged)
3. Cost-saving question (unchanged)
4. **Connections** ← Q0 + decision tree replaces this step
5. Optional preferences (unchanged)
6. Confirmation + create_agent (unchanged)

### Existing Connection Gate (Runs Before Q0)

Before entering the decision tree, the LLM must call `list_compatible_connections` with `preferredCapability: "trading"` (existing behavior). If a compatible active connection exists, **skip the entire decision tree** and reuse it — same as today. Only enter Q0 when no compatible trading connection exists.

## Key Design Decisions

### 1. Q0 is the fork point

One question ("New to crypto?" vs "I know what I want") splits the entire flow. Neither path is presented as superior — they're different starting points for different users.

### 2. The Fast Track asks ONE question

For newbies, the only question is "what asset interests you?" (Bitcoin / Ethereum / Memecoins / Not sure). From that single answer, the LLM infers: venue, strategy preset, and watchlist. All other fields use safe defaults (`style: 'balanced'`, `executionDefaults.mode: 'test'`, `filterTrades: 'scanner_gated'`). The wallet is always generated. Zero forms. Zero secrets.

Fast Track inference table:

| User picks | Venue | Strategy | Why |
|---|---|---|---|
| Bitcoin | Hyperliquid | momentum-position | BTC perps are deep, liquid, good for swing |
| Ethereum | Hyperliquid | momentum-position | Same — major pair, good liquidity |
| Memecoins | Jupiter | scalper | Memecoins live on Solana, move fast |
| Not sure | Jupiter | momentum | DEX spot is simplest, lowest barrier |

### 3. The Guided path asks venue-determining questions, not vague intent questions

We deliberately rejected questions like "Grow my portfolio / Protect my portfolio / Generate passive income" because they don't map to any `CreateAgentSchema` field. The Guided questions instead narrow to a **venue** — the one decision that drives everything else (chain, credential shape, fee structure, available strategies).

- **Q1 (ecosystem)** → Solana → Jupiter; EVM → Hyperliquid or 1inch
- **Q2 (long/short)** → long-only → DEX (Jupiter/1inch); long+short → perps (Hyperliquid)

These two questions deterministically lock a venue. No speculation.

### 4. The Direct path skips everything

If the user says "I want Hyperliquid" or "Connect Jupiter," the LLM skips all narrowing questions and goes straight to the wallet choice (existing vs generated). No unnecessary questions.

### 5. Generated wallets are the default for Fast Track, optional elsewhere

All three trading venues (Hyperliquid, Jupiter, 1inch) already support `credentialMode: 'generated'` via `generateWallet()` in `packages/venues/src/wallet-generation.ts`. The platform generates the private key/API key server-side. The user never types a secret. They just fund the wallet.

The existing-wallet path (`credentialMode: 'manual'`) remains available for all venues as a choice — the form opens pre-scoped to the selected venue with a single-field form (e.g., just a Solana private key for Jupiter).

### 6. New tool: `create_connection`

The chat agent needs a tool to create connections programmatically (bypassing the form). This tool calls `POST /setup/provider-link` with `credentialMode: 'generated'` directly from the chat backend.

```typescript
{
  name: 'create_connection',
  description: 'Create a provider connection with auto-generated credentials. Use for the simplified path when the user has agreed to a specific venue and wants a generated wallet. Do NOT use if the user wants to provide their own API keys — use request_connection_form instead.',
  inputSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider ID: hyperliquid, jupiter, 1inch.' },
      label: { type: 'string', description: 'Human-readable label for this connection.' },
      capability: { type: 'string', enum: ['trading'] },
      credentialMode: { type: 'string', enum: ['generated'] },
    },
    required: ['provider', 'label', 'capability', 'credentialMode'],
  },
}
```

### 7. System prompt restructuring

The `buildSystemPrompt()` function in `apps/api/src/routes/chat.ts` needs a new **Progressive Disclosure** section that encodes the decision tree, the Q0 fork, the existing-connection gate, and the rule that `request_connection_form` is a **last resort** — never the first response to a connection need.

## Edge Cases & Unresolvable Combinations

### Guided path: unresolvable venue combinations

Q1 (ecosystem) paired with Q2 (long/short) produces four combinations. Three map to a venue, one does not:

| Q1 | Q2 | Venue | Status |
|---|---|---|---|
| Solana | long-only | Jupiter | ✅ |
| Solana | long+short | — | ❌ No Solana perps venue exists |
| EVM | long-only | 1inch | ✅ |
| EVM | long+short | Hyperliquid | ✅ |

When Q1=Solana and Q2=long+short, the LLM must explain the constraint and offer the nearest alternative:

> "Perps trading with leverage isn't available on Solana. Hyperliquid (EVM-compatible) supports BTC/ETH perps with up to 50x leverage — the best option for shorting. Would Hyperliquid work for you?"

### Guided path: "not sure" defaults

When the user picks "not sure" at Q1:

| Q1 | Q2 | Venue | Rationale |
|---|---|---|---|
| Not sure | long-only | Jupiter | Safest default — spot DEX, no leverage confusion, lowest fees |
| Not sure | long+short | Hyperliquid | Only perps venue available; no choice to make |

### Fast Track: "Not sure" default

When the user picks "Not sure" for asset interest → Jupiter + momentum. Jupiter is chosen as the default because it's the simplest venue (spot DEX, no leverage, lowest barrier) — safest for newbies.

### Programmatic create_connection: resume behavior

When `create_connection` succeeds (server-side wallet generation), the connection is created synchronously within the LLM tool call. Unlike `request_connection_form`, there is no redirect, no form, and no `OnboardingResumeEvent`. The tool returns the `connectionId` directly. The LLM continues the conversation turn immediately — no resume infrastructure needed.

## What Already Exists (No New Infrastructure Needed)

| Capability | Location |
|---|---|
| `credentialMode: 'generated'` wallet creation | `apps/api/src/routes/setup.ts:63-83` |
| `generateWallet()` for Jupiter, Hyperliquid, 1inch | `packages/venues/src/wallet-generation.ts:38` |
| `request_connection_form` tool with provider hints | `apps/api/src/routes/chat.ts:290-305` |
| `search_app_docs` tool (venue lookup) | `apps/api/src/routes/chat.ts:240-250` |
| `quick_replies` action type for choice questions | `chat.ts:88-98` (greeting pattern) |
| `ProviderSetupForm` inline rendering | `apps/web/src/features/chat/GuidedSetupActionRenderer.tsx` |

## What's Missing

| Item | Priority |
|---|---|
| `create_connection` chat tool (calls `/setup/provider-link` with generated mode) | HIGH |
| Updated `buildSystemPrompt()` with Progressive Disclosure section + Q0 fork | HIGH |
| Platform docs entry explaining generated wallets to the LLM | MEDIUM |
| Post-creation summary showing generated wallet address + funding instructions | MEDIUM |

## When the Connection Form Appears (Conditional Summary)

| Path | Shows the form? | When? |
|---|---|---|
| **Fast Track** | ❌ Never | `create_connection({ credentialMode: 'generated' })` always |
| **Direct** — "I have API keys" | ✅ Once | Form opens pre-scoped to named venue, manual mode |
| **Direct** — "Create one for me" | ❌ Never | `create_connection({ credentialMode: 'generated' })` |
| **Guided** — "I have a wallet" at Q3 | ✅ Once | Form opens pre-scoped to determined venue, manual mode |
| **Guided** — "Create one for me" at Q3 | ❌ Never | `create_connection({ credentialMode: 'generated' })` |

The form is never shown as a blank "pick a provider" dropdown. It always opens pre-scoped to a specific venue with a single-field form (e.g., "Solana private key" for Jupiter, "API key + secret + wallet address" for Hyperliquid).

### Fallback: when `create_connection` fails

If wallet generation is disabled for a provider (`wallet_generation.disabled`), `create_connection` returns an error. The LLM must catch this and fall back to the form:

```
create_connection fails → "I can't auto-create a wallet for Hyperliquid right now.
                           Would you like to provide your own API keys instead?"
                       → request_connection_form({ preferredProvider: 'hyperliquid' })
```

## Implementation Order

1. **Add `create_connection` tool** to `CHAT_TOOLS` and implement its handler
2. **Update `buildSystemPrompt()`** with the Progressive Disclosure section and decision tree
3. **Test the three paths** end-to-end: Fast Track, Guided, Direct
4. **Add platform docs** page explaining generated wallets so the LLM can use `search_app_docs` to explain them to users

## Relationship to Existing Work

This plan extends `docs/features/2026/08/05/002-guided-setup-inline-connection-form/001-plan.md` — that plan connected the inline form to the LLM. This plan adds the **progressive questioning** that happens before the form is ever opened, and the **programmatic path** that avoids the form entirely.
