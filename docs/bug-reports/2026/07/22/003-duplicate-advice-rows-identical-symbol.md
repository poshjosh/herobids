# Bug Report: Review Runner Loads Duplicate Candidates — All Advice Rows Identical

**Date:** 2026-07-22  
**Severity:** HIGH (advice data is meaningless — all rows identical)  
**Status:** FIXED

## Summary

When the forced strategy review runs, all 20 advice rows are identical — same symbol (`LIT`), same outcome (`advised`), same preset (`momentum`). The review reports "20 symbols have advice" but it's actually 20 copies of the same symbol. The scanner has 17 unique symbols with diverse data, but the review runner only loads duplicate LIT entries.

## Root Cause

**File:** `apps/worker/src/market-intelligence/assessment-review-runner.ts:297`

The candidate query in `runPreCheck()` orders by `candidateRank` alone:

```typescript
.orderBy(agentScanCandidates.candidateRank)  // ← BUG
.limit(this.config.scannerCandidateLimit);    // 20
```

LIT consistently ranks #1 (`candidateRank = 1`) in every scan cycle. When the query orders only by rank, all 244 LIT entries (one per scan cycle) appear before any rank-2 symbol. The `LIMIT 20` picks the first 20 rows — all LIT, all identical.

The query should order by `scannedAt DESC` first (most recent scan), then `candidateRank` (top candidates within that scan):

```typescript
.orderBy(desc(agentScanCandidates.scannedAt), agentScanCandidates.candidateRank)  // ← FIXED
```

## Evidence

```
Scanner candidates (diverse):
  LIT: 244, XMR: 243, LTC: 130, ONDO: 125, BTC: 113, SUI: 97, XRP: 97, SOL: 95, ENA: 92, DOGE: 89, AAVE: 76, ETH: 75, PUMP: 65, KAITO: 57, NEAR: 50, ZEC: 36, GRAM: 17

Review advice (all identical):
  20 rows, all: symbol=LIT, outcome=advised, preset=momentum
```

## Fix

Changed line 297 in `assessment-review-runner.ts` from:
```typescript
.orderBy(agentScanCandidates.candidateRank)
```
to:
```typescript
.orderBy(desc(agentScanCandidates.scannedAt), agentScanCandidates.candidateRank)
```

This ensures the runner loads the top-ranked candidates from the **most recent scan cycle**, rather than loading rank-1 candidates from all scan cycles.

## Files Changed

- `apps/worker/src/market-intelligence/assessment-review-runner.ts:297` — fixed ORDER BY clause

## Verification

- `pnpm lint` passes
- After redeploy, trigger a manual review — advice rows should show diverse symbols with meaningful ranks
