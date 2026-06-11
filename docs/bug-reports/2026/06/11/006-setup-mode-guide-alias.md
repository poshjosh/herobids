- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-11
- **Summary:** `scripts/shell/ops/quick-setup.sh --mode guide` rejected a user-friendly shorthand even though the script already documented guided setup flow.

## Root Cause

The setup script only accepted `auto`, `guided`, and `advanced` as mode values. The CLI help text documented the guided flow, but the parser did not normalize the common shorthand `guide`, so the command failed validation before it could run the guided path.

## Fix

Updated `scripts/shell/ops/quick-setup.sh` to normalize `guide` to `guided` after loading configuration and before validation. The CLI help text now also mentions the alias so users can discover it from the built-in usage output.

## Files Changed

- `scripts/shell/ops/quick-setup.sh`
- `docs/bug-reports/2026/06/11/006-setup-mode-guide-alias.md`

## Verification

- `bash scripts/shell/ops/quick-setup.sh --mode guide --dry-run`
- Confirmed the script now reports `Using guided flow.` and completes validation successfully.
