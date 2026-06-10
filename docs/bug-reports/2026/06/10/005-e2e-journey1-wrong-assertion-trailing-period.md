# Bug Report 005 — Journey 1: Wrong Assertion Text (Trailing Period)

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-10
- **Summary:** E2E Journey 1 failed at `expect(page.getByText(/No capability setup required\./i))` because the agent detail page renders "No capability setup required" without a trailing period.

## Root Cause

The test regex `/No capability setup required\./i` requires a literal period at the end (`\.`). The actual UI text is "No capability setup required" (no period).

## Fix

Changed the test assertion to `/No capability setup required/i` (removed `\.`).

## Files Changed

- `tests/e2e/journeys/01-signup-create-agent.spec.ts`

## Verification

Journey 1 passes end-to-end.
