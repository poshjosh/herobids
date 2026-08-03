# Agent Execution Mode Lifecycle Functional Tests — Provider Link 500

**Date**: 2026-08-03
**Severity**: MEDIUM (functional test only; may indicate a real API issue with `/setup/provider-link`)
**Found during**: test-and-fix validation run

## Summary

Two functional tests in `apps/api/src/__tests__/functional/agents.functional.test.ts` fail at the connection creation step — `POST /setup/provider-link` returns 500 instead of 201:
- "resolves paper mode to shadow after granting a connection"
- "transitions from paper to live without mode leak"

## Details

Both tests:
1. Create an agent with `executionDefaults: { mode: 'paper' }` — succeeds (201)
2. Create a Hyperliquid connection via `POST /setup/provider-link` — fails (500)

The agent creation step now works correctly after updating the payload from `executionMode: 'paper'` to `executionDefaults: { mode: 'paper' }`.

## Investigation Needed

The `/setup/provider-link` endpoint may have changed its expected payload format or has a dependency not available in the test environment (e.g., a queue worker for credential encryption, or a missing provider configuration). The 500 is likely an unhandled exception in the route handler.

## Workaround

The tests that don't require connection creation (basic CRUD, cascade-deletes, notification policy) all pass now.
