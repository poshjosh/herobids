# Stage C Verification Run Report

**Date:** 2026-05-31 09:55 UTC  
**Script:** `./scripts/shell/rollout/rollout-stage-c-runner.sh --shadow`  
**Instance:** `93a2c7bd-d10d-4946-aacc-13460bf039f2` (shadow mode)  
**Credential:** `99361dcf-f1f2-4856-9d76-15bbcbbf952e`  
**Verdict:** **PASS** (shadow mode — `credential.used` is N/A)

---

## Final Results

| Test | Result | Notes |
|------|--------|-------|
| TEST 1: Actor restart & recovery | PASS | Reconciliation ran at 09:55:36 post-restart, shadow mode resumed |
| TEST 2: Resolving linked credential | PASS | Credential resolved via venueAccount `ba37d594-523e-46db-becd-eaa3d197d92f` |
| TEST 3: Credential rotation | PASS | Status=rotated, no restartErrorCode, instance in dependents + restarted lists |
| TEST 4: Post-rotation readiness | PASS | Reconciliation resumed at 09:56:47, instance running in shadow mode |
| TEST 5: Post-rotation audit evidence | PASS | `credential.rotated` + `credential.decrypted` events found |
| TEST 6: Reconciliation evidence | PASS | 10 events, latest: drift_detected at 09:56:47 |
| TEST 7: Slippage monitoring | PASS | No slippage alerts |

**Checks passed: 11**

---

## Infrastructure Steps

| Step | Status | Duration |
|------|--------|----------|
| 1. Install & build | OK | ~5s (cached) |
| 2. Docker infrastructure | OK | Already running |
| 3. Database migrations | OK | Applied (no-op) |
| 4. Start API + worker | OK | — |
| 5. API readiness | OK | 12s |
| 6. Discover/start instance | OK | Started stopped shadow instance |
| 7. Stage C verification | OK | ~75s total |

---

## Issues Fixed During Run

Three issues were discovered and fixed during the run:

### 1. `packages/backtesting/package.json` — incorrect exports

**Symptom:** `ERR_MODULE_NOT_FOUND: Cannot find module .../packages/backtesting/src/simulated-clock.js`  
**Cause:** `"main": "./src/index.ts"` pointed Node.js to TypeScript source (which has `.js` extension imports) instead of compiled output.  
**Fix:** Replaced `main`/`types` with proper `exports` field pointing to `./dist/index.js` + `./dist/index.d.ts`.

### 2. Unique constraint on `venue_account_id` blocking start

**Symptom:** 500 from `POST /instances/:id/start` — partial unique index `uq_trading_instances_active_venue_account` violated by existing crashed instance sharing the same venue account.  
**Cause:** Runner tried to set status=running on an instance while another non-stopped instance held the same `venue_account_id`.  
**Fix (during run):** Added pre-start cleanup in runner: stop all crashed instances before attempting to start a stopped one.  
**Superseded by:** Proper API-level fix in `POST /instances/:id/start` — blocker detection, crashed auto-clear, and unique constraint catch. Runner workaround removed. See bug report 003.

### 3. Restart-after-rotation crashes with empty config

**Symptom:** Worker logs: `Invalid config for instance: strategy: Required; venue: Required; symbol: Required`  
**Cause:** Rotation route enqueues `{ command: 'restart', tradingInstanceId }` with NO config. Worker's restart case used `config ?? {}` — an empty object fails Zod validation.  
**Fix:** Modified `apps/worker/src/runtime.ts` restart case to load config from DB via `instanceLoader()` when not provided in job payload.

---

## Script Fixes Applied

- `rollout-stage-c-runner.sh`: Fixed migration command (`db:migrate` not `migrate`), added `.env` sourcing, added crashed-instance cleanup, fixed `curl` error handling under `set -e`.
