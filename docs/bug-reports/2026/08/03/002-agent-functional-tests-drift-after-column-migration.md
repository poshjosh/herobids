- **Status:** OPEN
- **Severity:** Medium
- **Date:** 2026-08-03
- **Summary:** Three agent functional tests fail due to drift from the agent table column migration (2026-08-02). The `executionMode` column was moved to `executionDefaults` JSONB, but tests still reference the old field name and validation rules.

- **Root Cause:** The Aug 2 migration (see `docs/bug-reports/2026/08/02/001-agent-table-columns-removed-jsonb-migration-type-errors.md`) renamed `executionMode` → `executionDefaults`, `dailyLossLimit` → `risk.dailyMaxLossPct`, etc. The functional tests were not updated to reflect the new schema and validation logic.

- **Test failures:**

  1. **`POST /agents rejects explicit execution mode for a non-trading agent`**
     - Test sends `executionMode: 'paper'` (old field), expects 400 rejection
     - New code silently accepts unknown fields (Zod strips them), returns 201
     - Fix: Update test to send `executionDefaults: { mode: 'paper' }` and update assertion to match new validation logic (non-trading agents can have execution defaults without error)

  2. **`cascade-deletes dependent rows`**
     - Test inserts `marketAssessmentRequests` with `billingAccountId: 'ba-cascade-test'` but no billing account is seeded
     - FK constraint `market_assessment_requests_billing_account_id_billing_accounts_` fails
     - Fix: Seed a `billingAccounts` row with `id: 'ba-cascade-test'` before the `marketAssessmentRequests` insert

  3. **`transitions from paper to live without mode leak`**
     - Test sends old field names in the payload, expects 201, gets 400
     - Fix: Update payload to use `executionDefaults: { mode: 'paper' }` and related JSONB fields

- **Affected files:**
  - `apps/api/src/__tests__/functional/agents.functional.test.ts`

- **Reproduction:** Run `scripts/shell/tests/run-all-tests.sh --e2e`.
