# Agent Execution Mode Lifecycle Functional Tests — Provider Link 500

**Date**: 2026-08-03
**Severity**: MEDIUM (functional test only — missing env var)
**Status**: FIXED
**Found during**: test-and-fix validation run

## Summary

Two functional tests in `apps/api/src/__tests__/functional/agents.functional.test.ts` failed at the connection creation step — `POST /setup/provider-link` returned 500 instead of 201.

## Root Cause

`buildApp()` in the functional test helpers did not set `CREDENTIAL_ENCRYPTION_KEY`. When `POST /setup/provider-link` called `getEncryptionKey()`, it threw an unhandled exception → Fastify returned 500. No other functional test exercised credential creation, so the gap was never hit until the agents execution-mode lifecycle tests were added.

## Fix

Added a dummy 64-char hex `CREDENTIAL_ENCRYPTION_KEY` in `buildApp()`, following the same save/set/restore pattern already used for LLM API keys.

## Files Changed

- `apps/api/src/__tests__/functional/helpers.ts`: save, set dummy key, restore in `buildApp()`.
