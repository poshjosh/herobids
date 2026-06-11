- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-11
- **Summary:** `scripts/shell/ops/quick-setup.sh` could reject a valid setup mode when the value arrived with incidental whitespace from the environment or a CLI override.

## Root Cause

The setup script validated `SETUP_MODE` verbatim after sourcing `.env.setup` and applying any `--mode` override. That left it sensitive to trailing or leading whitespace in the loaded value, and the failure message did not show the actual invalid value, which made the issue look like a bad default even when the env file itself was fine.

## Fix

Updated `scripts/shell/ops/quick-setup.sh` to normalize `SETUP_MODE` before validation by trimming surrounding whitespace, then validate the cleaned value against the allowed modes. The invalid-mode error now also includes the quoted value that was seen at runtime, which makes future misconfigurations easier to diagnose.

## Files Changed

- `scripts/shell/ops/quick-setup.sh`
- `docs/bug-reports/2026/06/11/005-setup-mode-whitespace-trim.md`

## Verification

- `bash scripts/shell/ops/quick-setup.sh --dry-run`
- Confirmed the script loads `scripts/shell/ops/.env.setup`, validates successfully, and reaches `Dry-run mode: validation passed, skipping API calls`.
