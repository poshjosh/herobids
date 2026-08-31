# Bug Report: sandbox environment stripping removes agent-browser config variables

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-31
- **Summary:** Both `execute_shell` and `execute_code` replace the full process environment with a minimal `{PATH, TIMEOUT}` object when the sandbox is active. This strips `AGENT_BROWSER_CONFIG`, `HOME`, and all other environment variables, preventing the `agent-browser` CLI from discovering its CDP configuration file.

## Symptoms

Even after fixing the socket directory ownership (bug 002), `agent-browser` inside the sandbox cannot find its config because:

1. `AGENT_BROWSER_CONFIG` (set by the entrypoint to `/home/agent/.agent-browser/config.json`) is not present in the sandbox environment.
2. `HOME` is not set, so the CLI falls back to `os.homedir()` which resolves from `/etc/passwd`. When running as root (via `execute_code`), this resolves to `/root` — where no config exists.

The CLI falls back to launching a local Chromium browser instead of connecting via CDP to the remote Browserless pool.

## Root Cause

Both `apps/worker/src/tools/shell.ts` (line 148) and `apps/worker/src/tools/code.ts` (line 150) set:

```typescript
env: hasSandbox
  ? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TIMEOUT: String(Math.ceil(TIMEOUT_MS / 1000)) }
  : process.env,
```

This is an intentional security measure — the sandbox restricts the child process environment to prevent leaking secrets. However, `AGENT_BROWSER_CONFIG` and `HOME` are not secrets and are required for the `agent-browser` CLI to function correctly inside the sandbox.

## Impact

- The `agent-browser` CLI cannot discover its CDP configuration when run through `execute_shell` or `execute_code`, even when the config file exists and is readable.
- Without CDP config, the CLI attempts a local Chromium launch, which fails because the agent container does not include Playwright browser binaries.

## Files Involved

- `apps/worker/src/tools/shell.ts` — sandbox environment construction
- `apps/worker/src/tools/code.ts` — sandbox environment construction

## Fix

Add `HOME`, `AGENT_BROWSER_CONFIG`, and `SANDBOX_ALLOWED_HOSTS` to the sandbox environment allowlist in both `shell.ts` and `code.ts`. These are safe to pass through — `HOME` is a standard POSIX variable, `AGENT_BROWSER_CONFIG` is a file path, and `SANDBOX_ALLOWED_HOSTS` contains operator-configured IP addresses for the sandbox firewall (not secrets).

## Files Changed

- `apps/worker/src/tools/shell.ts` — added `HOME`, `AGENT_BROWSER_CONFIG`, and `SANDBOX_ALLOWED_HOSTS` to sandbox env
- `apps/worker/src/tools/code.ts` — added `HOME`, `AGENT_BROWSER_CONFIG`, and `SANDBOX_ALLOWED_HOSTS` to sandbox env

## Verification

- `pnpm lint` passes.
