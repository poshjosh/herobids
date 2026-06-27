# Bug Report: pnpm `workspace:*` Resolution Fails with Prerelease Versions

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-06-27
- **Summary:** `pnpm install` fails with `ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE` when workspace packages use prerelease version strings (e.g., `0.0.1-2026.06.26-b`). All `workspace:*` protocol deps are affected.
- **Root Cause:** Per semver, the `*` range does not match prerelease versions. pnpm 10.x enforces this, so `workspace:*` fails to resolve any workspace package with a prerelease version tag.
- **Fix:** Changed all workspace package versions from `0.0.1-2026.06.26-b` to `0.0.1` (non-prerelease). The root `package.json` may use a prerelease version independently.
- **Files Changed:** All 15 workspace `package.json` files (root, apps/*, packages/*, scripts/, tests/*).
- **Verification:** `pnpm install` succeeded, `pnpm build` passed, `scripts/shell/run/reset-and-run.sh` completed successfully with all services healthy.
