# Bug Report: agent-browser socket directory owned by root — agent user cannot create sockets

- **Status:** FIXED
- **Severity:** Critical
- **Date:** 2026-08-31
- **Summary:** The agent container entrypoint creates `/home/agent/.agent-browser/` as root, making the directory unwritable by the `agent` user. The `agent-browser` CLI requires a writable socket directory to create session sockets (`.sock`) and PID files — it fails before reading any config, including the CDP endpoint.

## Symptoms

Agent `08451dd4-9659-4408-a509-70b35e055057` (personal assistant, flight search task) repeatedly failed when invoking `agent-browser` via `execute_shell`:

```
✗ Socket directory '/home/agent/.agent-browser' is not writable: Permission denied (os error 13)
```

Every `execute_shell` invocation of `agent-browser` failed with this error. The agent spent ~10 minutes across 15+ tool calls trying to fix the permissions (`mkdir -p`, `chmod`, `rm -rf`, `chown`) but could not because `execute_shell` runs as the non-root `agent` user (uid 1001) via `sudo -u agent sh -lc '...'`.

## Root Cause

The entrypoint script (`scripts/agent-entrypoint.sh`) runs as root (the container's default user) and creates the directory and config file:

```sh
mkdir -p /home/agent/.agent-browser
printf '{"cdp":"%s"}\n' "$AGENT_BROWSER_CDP_URL" > /home/agent/.agent-browser/config.json
```

Result: `drwxr-sr-x root:agent` — the `agent` user can read but cannot write.

The `agent-browser` native CLI (Rust binary) checks socket directory writability as its first operation — before reading `config.json`, before connecting to the daemon. When the check fails, it exits immediately with the error above.

## Impact

- The `execute_shell` path for `agent-browser` is completely blocked for all agents at `standard` permission level (the default). This is the intended primary path for browser automation via external skills like `google-flights`.
- The `browse_interactive` tool (platform-provided) is unaffected since it runs in the worker process, not the agent container.

## Files Involved

- `scripts/agent-entrypoint.sh` — creates the directory as root without chown

## Fix

Add `chown -R agent:agent /home/agent/.agent-browser` after creating the directory in the entrypoint:

```sh
if [ -n "${AGENT_BROWSER_CDP_URL:-}" ]; then
  mkdir -p /home/agent/.agent-browser
  printf '{"cdp":"%s"}\n' "$AGENT_BROWSER_CDP_URL" > /home/agent/.agent-browser/config.json
  chown -R agent:agent /home/agent/.agent-browser
  export AGENT_BROWSER_CONFIG="/home/agent/.agent-browser/config.json"
fi
```

## Files Changed

- `scripts/agent-entrypoint.sh` — added `chown -R agent:agent /home/agent/.agent-browser`

## Verification

- `pnpm lint` passes.
- Rebuilt agent image and verified directory ownership is `agent:agent` after entrypoint runs.
