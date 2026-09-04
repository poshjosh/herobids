# Bug Report: strategy-presets smoke test aborts after first assertion under `set -e`

- **Status:** FIXED
- **Severity:** Medium (false-negative CI failure; masks real preset regressions)
- **Date:** 2026-09-04
- **Discovered By:** `scripts/shell/tests/run-all-tests.sh --e2e` reported `FAIL  API smoke (strategy-presets)` while the API was healthy and serving all presets.
- **Summary:** `scripts/shell/tests/test-presets.sh` runs under `set -euo pipefail` and used bash post-increment arithmetic (`(( PASS++ ))`) to count passing assertions. When `PASS` is `0`, the expression `PASS++` evaluates to `0` (the pre-increment value), and a `(( expr ))` command whose value is `0` returns exit status `1`. Under `set -e` that non-zero status aborts the script immediately — right after the very first `[OK]` line is printed. The suite therefore always failed on its first successful assertion, regardless of whether the presets were actually correct.

---

## Symptoms (as observed)

Running the smoke test against a healthy API:

```
[INFO]  Authenticating as preset-test@local.test ...
[OK]    Authenticated
[OK]    [economy] momentum — present
exit=1
```

The script exits `1` immediately after the first `[OK]`, with no `MISSING` line and no summary. The `run-all-tests.sh` summary shows `FAIL  API smoke (strategy-presets)`.

---

## Root Cause

`scripts/shell/tests/test-presets.sh` counted results with:

```bash
set -euo pipefail
...
PASS=0
FAIL=0
...
      log_ok   "[$style] $key — present"
      (( PASS++ ))          # <-- with PASS=0, evaluates to 0 → exit status 1 → set -e aborts
```

Bash arithmetic command semantics: `(( expr ))` returns exit status `0` when `expr` is non-zero and status `1` when `expr` is `0`. Post-increment `PASS++` yields the *old* value, so the first increment (from `0`) yields `0` and returns status `1`. Combined with `set -e`, the script dies on the first counted pass.

The presets, the loader (`packages/domain/src/config/presets-loader.ts`), and the endpoint (`GET /blueprints/presets`) were all correct — verified that `listPresets()` returns all 7 keys (`momentum`, `momentum-position`, `dca`, `range`, `swing`, `scalper`, `contrarian`) for every style tier (economy, standard, premium).

---

## Fix

Replace the `(( var++ ))` / `(( var += n ))` arithmetic commands with `$(( ... ))` assignments, which always return exit status `0`:

```bash
PASS=$(( PASS + 1 ))
FAIL=$(( FAIL + 1 ))
FAIL=$(( FAIL + ${#EXPECTED_KEYS[@]} ))
```

After the fix the smoke test runs all 21 assertions and reports `Preset checks: all 21 passed.`

---

## Verification

- `API_BASE_URL=http://localhost:3000 scripts/shell/tests/test-presets.sh` → all 21 checks pass, exit `0`.

---

## Lessons / Follow-up

- Prefer `var=$((var + 1))` over `(( var++ ))` in scripts running under `set -e`. The post-increment idiom is a well-known `set -e` foot-gun whenever the counter can be `0`.
- Consider a lint rule or shell review checklist item for `(( ... ))` arithmetic commands in `set -e` scripts.
