# BUG-010: Stream Pool Races With Connector-Managed Reconnects

**Status:** CLOSED

**Severity:** Medium

**Date:** 2026-05-24

## Summary

When a new subscriber calls `pool.subscribe()` during a connector's internal reconnection window (stream disconnected, connector auto-reconnecting), the pool incorrectly attempts to call `connector.connect()` again. This races with the connector's own reconnection logic, potentially creating duplicate WebSocket connections or conflicting state.

## Root Cause

In `packages/venues/src/stream-pool.ts`, the connect condition was:

```typescript
if (!conn.connected && !conn.connectingPromise) {
  conn.connectingPromise = conn.connector.connect(...)
}
```

When a connector is internally reconnecting (after a `close` event), `conn.connected = false` and `conn.connectingPromise = undefined`. A new subscriber arriving at this moment triggers a fresh `connect()` call that races with the connector's internal `attemptReconnect()` timer.

The connector's `HyperliquidPublicStream.attemptReconnect()` manages its own WebSocket lifecycle independently. A second `connect()` call from the pool creates a separate WebSocket, leading to:
- Duplicate message delivery
- State confusion about which connection is primary
- Potential double-subscriptions on the venue

## Fix

Track whether a venue connection was newly created (`isNewConnection` flag) vs already existing. Only call `connector.connect()` for genuinely new connections. For existing connections that are disconnected, the connector manages its own reconnection — the new subscriber just registers its symbols (which will be picked up on the next reconnect).

```typescript
let isNewConnection = false;
if (!conn) {
  // ... create new connection ...
  isNewConnection = true;
}

// Only connect for new connections — existing ones self-reconnect
if (!conn.connected && !conn.connectingPromise && isNewConnection) {
  conn.connectingPromise = conn.connector.connect(...);
}
```

Also updated the "already connected" branch to explicitly check `conn.connected` before subscribing new symbols.

## Files Changed

- `packages/venues/src/stream-pool.ts` (subscribe method)

## Verification

- 167 tests pass, 0 failures
- TypeScript compiles cleanly
