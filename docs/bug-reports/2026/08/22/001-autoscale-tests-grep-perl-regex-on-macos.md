# Bug Report: Autoscale test scripts fail on macOS due to grep -P (Perl regex)

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-08-22
- **Summary:** Both autoscale test scripts use `grep -oP` (GNU Perl-compatible regex) to parse capacity output, but macOS ships BSD grep which does not support the `-P` flag, causing all parsing to fail silently and cascading into 5 test failures.

## Root Cause

The scripts parse `key=value` output from `check-nomad-capacity.sh` using
`grep -oP 'free_slots=\K[0-9]+'`. The `-P` flag enables Perl-compatible
regular expressions, which is a GNU grep extension. macOS provides BSD grep,
which does not support `-P`. When BSD grep encounters `-P`, it prints a usage
error to stderr and exits with a non-zero status. The `|| echo "0"` fallback
catches the error but produces `0` for every parsed value, so:

- `free_slots` parses as `0` instead of the actual value (29)
- `scale_out_slot_threshold` parses as `0` instead of the configured threshold
- Downstream checks (`free_slots > 0`, `threshold > 0`, `free < threshold`)
  all fail because both operands are `0`
- The autoscaler never triggers because the dummy job count is calculated as
  `0 - 0 + 1 = 1`, which is insufficient to actually consume capacity

The same pattern appeared in the job status parsing (`Status\s+=\s+\K\w+`) and
the post-load capacity check.

## Fix

Replaced all `grep -oP 'key=\K[0-9]+'` calls with POSIX-portable
`sed -n 's/.*key=\([0-9][0-9]*\).*/\1/p' | head -1` and a `${VAR:-0}` default
fallback. The remote job-status parsing was also made portable using
`[[:space:]]` and `[a-zA-Z_]` character classes instead of `\s` and `\w`.

## Files Changed

- `scripts/shell/tests/autoscale-capacity-trigger-test.sh` — 4 occurrences replaced
- `scripts/shell/tests/autoscale-agent-trigger-test.sh` — 2 occurrences replaced

## Verification

- `grep -oP` no longer appears in either script (confirmed by repository search)
- The `sed` replacements correctly extract values from `key=value` formatted
  output on both BSD (macOS) and GNU (Linux) sed
- The fix is parse-only; no runtime, deployment, or autoscale behaviour changes
