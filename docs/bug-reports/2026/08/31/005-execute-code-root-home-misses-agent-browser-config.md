# Bug Report: execute_code runs as root — agent-browser config not found at /root/.agent-browser/

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-08-31
- **Summary:** The `execute_code` tool runs commands as root (not the `agent` user). When `agent-browser` resolves its config directory from `HOME=/root`, it looks in `/root/.agent-browser/config.json` which does not exist. The entrypoint only writes the CDP config to `/home/agent/.agent-browser/config.json`. The CLI falls back to launching a local Chromium browser, which fails.

## Symptoms

Agent `08451dd4-9659-4408-a509-70b35e055057` used `execute_code` to run `agent-browser` via Python subprocess (after `execute_shell` was blocked by the socket dir permission bug). The daemon spawned as root (PID 65627) and attempted a local browser launch:

```
browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell
```

The daemon looked for config at `/root/.agent-browser/config.json` (root's home) but found nothing — only `econ.sock` and `econ.pid` from the daemon session. The actual CDP config was at `/home/agent/.agent-browser/config.json`.

## Root Cause

1. `execute_code` runs commands as root inside the sandbox: `SANDBOX_SCRIPT sh -lc "..."` (no `sudo -u agent`).
2. Root's HOME is `/root` (from `/etc/passwd`).
3. The entrypoint writes `config.json` only to `/home/agent/.agent-browser/`.
4. The `agent-browser` CLI resolves `~/.agent-browser/config.json` → `/root/.agent-browser/config.json` — file not found.

## Impact

- `agent-browser` invoked through `execute_code` cannot connect to the Browserless pool via CDP.
- The CLI falls back to local browser launch, which fails because Playwright browser binaries are not installed in the agent container.

## Files Involved

- `scripts/agent-entrypoint.sh` — writes config only for `/home/agent/`

## Fix

The entrypoint now also writes the CDP config to `/root/.agent-browser/config.json` so that processes running as root (via `execute_code`) find the same CDP configuration. Combined with bug 004's fix (passing `HOME` through the sandbox env), this provides full coverage for both user contexts.

## Files Changed

- `scripts/agent-entrypoint.sh` — added config write to `/root/.agent-browser/config.json`

## Verification

- `pnpm lint` passes.
