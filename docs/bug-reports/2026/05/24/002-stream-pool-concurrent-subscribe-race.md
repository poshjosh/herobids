# BUG-002: PublicStreamPool Concurrent Subscribe Race Condition

**Status:** CLOSED

**Severity:** Medium

**Date:** 2026-05-24

## Summary

When two actors subscribe to the same venue simultaneously during worker startup, both observe `connected === false` and race into separate `connect()` calls on the same connector. If the first connect rejects, the orphaned subscriber stays registered but the caller never receives a `PoolSubscription` to clean it up.

## Root Cause

- `PublicStreamPool.subscribe()` checked `!conn.connected` without guarding against an in-flight connect
- Multiple concurrent callers could each trigger `conn.connector.connect()` independently
- On connect failure, the subscriber entry was already registered in the map with no rollback

## Fix

Added a `connectingPromise` field to `VenueConnection`:
1. The first caller creates the promise and awaits it
2. Subsequent callers detect the existing promise and await the same one
3. On connect failure, the subscriber entry is rolled back and the venue entry is cleaned up if no subscribers remain

## Files Changed

- `packages/venues/src/stream-pool.ts`

## Regression Test

- `packages/venues/src/stream-pool.test.ts` — tests concurrent subscribe, connect failure rollback
