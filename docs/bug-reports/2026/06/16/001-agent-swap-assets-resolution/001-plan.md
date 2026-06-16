# Plan: Agent Swap Assets Resolution

**Date:** 2026-06-16  
**Status:** Draft  

## Problem

Agent `t1inch` (`a13136ae`) crashes on startup because the worker's swap binding check requires `swapAssets` (baseAsset, quoteAsset, baseDecimals, quoteDecimals) in the `binding_profile` for any non-paper mode. The 1inch binding created via `POST /setup/provider-link` only contains `{ "provider": "1inch" }` — no `swapAssets`.

**Root cause:** The provisioner (`trading-provisioner.ts`) always writes `bindingProfile: { provider }` and never collects or writes `swapAssets`. The worker startup check (`apps/worker/src/index.ts:500`) does not distinguish between agents (who decide tokens dynamically) and bots (which are pre-configured with a token pair).

**Impact:** Every 1inch agent created through the normal setup flow crashes immediately. Zero trades, zero decisions.

## Design Decision

Per user discussion: **Agents do not need `swapAssets` at setup time.** They decide what to trade dynamically via `submit_decision`. The system resolves decimals on-demand at decision time (on-chain fetch or registry lookup). Bots still require `swapAssets` at creation since they are pre-configured with a predetermined token pair.

## Changes Required

### 1. Worker startup — relax swapAssets check for agents

**File:** `apps/worker/src/index.ts` (~line 498)

Current:
```ts
if (venueType === 'swap') {
  resolvedSwapAssets = resolveSwapAssetsFromBinding(binding);
  if (!resolvedSwapAssets && mode !== 'paper') {
    throw new Error(`Swap binding ${binding.id} missing swapAssets metadata ...`);
  }
}
```

Change: Allow agents to start without `swapAssets`. Only enforce for bots.

```ts
if (venueType === 'swap') {
  resolvedSwapAssets = resolveSwapAssetsFromBinding(binding);
  // Agents can proceed without swapAssets — decimals are resolved at decision time.
  // Bots must have swapAssets pre-configured.
  if (!resolvedSwapAssets && mode !== 'paper' && actorType === 'bot') {
    throw new Error(`Swap binding ${binding.id} missing swapAssets metadata ...`);
  }
}
```

Also pass `swapAssets: resolvedSwapAssets ?? undefined` to the actor constructor (it already handles undefined).

### 2. Bot creation API — require swapAssets for swap venues

**File:** `apps/api/src/routes/bots.ts` (or wherever bots are created)

Add validation in the bot config schema: when `venueType === 'swap'`, `swapAssets` is required in the config payload. This catches the problem at setup time, not at runtime.

### 3. Decision-time resolution — resolve decimals on-demand

**File:** New or extend existing venue adapter logic

When an agent submits a decision to trade a token that isn't in the binding's `swapAssets`:
1. Look up the token address from the agent's connection/credential context (already known)
2. Fetch decimals via on-chain ERC-20 `decimals()` call or well-known registry
3. Fail loudly if unknown (per AGENTS.md rule: "never assume, always fetch")

This is a **deferred** change — not needed to unblock the current crash since the existing 1inch binding already has baseAsset/quoteAsset from the connection context. The immediate fix is just step 1 above.

### 4. Existing binding — no patch needed

The current 1inch binding (`5bc9b541`) doesn't need a DB patch. After step 1, it's valid for agent use. The crash was because the worker check didn't distinguish agent vs bot context.

## Implementation Order

1. **Step 1** — Unblocks all existing agents immediately (3-line change)
2. **Step 2** — Prevents future broken bot configs (validation guard)
3. **Step 3** — Enables dynamic token resolution for agents (deferred, enables richer UX)

## Testing

- Start an agent with a swap binding that has no `swapAssets` → should succeed
- Start a bot with a swap binding that has no `swapAssets` → should fail at creation time (step 2)
- Existing agents with swap bindings → should continue to work
- Agent trading flow with dynamic token resolution → verify decimals are fetched correctly

## Files Modified

| File | Change |
|------|--------|
| `apps/worker/src/index.ts` | Relax swapAssets check for agents |
| `apps/api/src/routes/bots.ts` (or schema) | Require swapAssets for swap bots |
| *(deferred)* Decision-time resolution logic | On-chain/registry lookup |
