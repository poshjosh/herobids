# Bug Report: agent-browser CDP connection fails inside sandbox due to DNS override

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-31
- **Summary:** The `agent-browser` CLI cannot connect to the browser-pool service when invoked through `execute_shell` because the sandbox network namespace replaces Docker's DNS resolver with public DNS (8.8.8.8), making the Docker hostname `browser-pool` unresolvable.

## Symptoms

An agent (ID `60720679-f4a5-49de-a51b-76c597e27cf5`) with the `programming` skill and the external `skillhq/flight-search/google-flights` skill attempted to use `agent-browser` via `execute_shell`. The call failed with exit code 1:

```
✗ Failed to connect via CDP to ws://browser-pool:3000.
  Make sure the remote browser is accessible and the URL is correct.
```

Running the same command outside the sandbox (directly in the container shell) succeeds — confirming the issue is specific to the sandbox environment.

## Root Cause

The sandbox script (`scripts/sandbox-exec.sh`) creates an isolated network namespace for `execute_shell` and `execute_code` commands. As part of its isolation:

1. It replaces the container's DNS resolver with public nameservers (8.8.8.8, 8.8.4.4) to prevent DNS-based discovery of internal services.
2. It blocks all RFC 1918 traffic via iptables, with an allowlist (`SANDBOX_ALLOWED_HOSTS`) for specific IPs that should remain reachable.

The worker correctly resolves `browser-pool` to its Docker IP (`172.18.0.4`) and passes it via `SANDBOX_ALLOWED_HOSTS`, so the iptables allowlist is correctly configured. However, the `AGENT_BROWSER_CDP_URL` environment variable is set to `ws://browser-pool:3000` — a Docker hostname. Inside the sandbox namespace, DNS queries go to 8.8.8.8 which cannot resolve Docker-internal hostnames. The CLI never reaches the iptables allowlist because DNS resolution fails before any TCP connection is attempted.

**In short:** the IP is allowed, but the hostname is unresolvable.

### Evidence chain

| Check | Value |
|---|---|
| `AGENT_BROWSER_CDP_URL` | `ws://browser-pool:3000` (Docker hostname) |
| `SANDBOX_ALLOWED_HOSTS` | `172.18.0.4` (resolved IP — correct) |
| Sandbox DNS | `8.8.8.8`, `8.8.4.4` (public — cannot resolve `browser-pool`) |
| Direct exec (no sandbox) | ✓ Connects and navigates successfully |
| Via `sandbox-exec.sh` | ✗ `Failed to connect via CDP to ws://browser-pool:3000` |

### Relevant code path

1. `apps/worker/src/agents/runtime-lifecycle.ts` (lines ~165–180) — constructs `AGENT_BROWSER_CDP_URL` from `config.browserPoolUrl` using the Docker hostname, and sets `SANDBOX_ALLOWED_HOSTS` to the pre-resolved IP.
2. `scripts/agent-entrypoint.sh` — writes the CDP URL (still hostname-based) to `/home/agent/.agent-browser/config.json`.
3. `scripts/sandbox-exec.sh` (lines ~78–80) — overrides DNS with public nameservers inside the namespace.
4. `agent-browser` binary — reads CDP URL from config, attempts DNS resolution → fails.

## Impact

- Any agent skill that uses `agent-browser` through `execute_shell` (the intended path when the `browser` skill is removed) cannot browse. The CLI is installed, configured, and allowlisted, but DNS prevents it from connecting.
- The agent fell back to attempting direct HTTP requests via `urllib`/`wget`/`curl`, all of which also failed due to the same sandbox DNS restriction (expected for arbitrary external hosts, but it meant the agent had no working path to complete its browser-based task).
- The `browse_interactive` tool (used via the `browser` skill) is not affected — it runs in the worker process, not in the sandbox.

## Files Involved

- `scripts/sandbox-exec.sh` — sandbox DNS override
- `apps/worker/src/agents/runtime-lifecycle.ts` — sets `AGENT_BROWSER_CDP_URL` (hostname) and `SANDBOX_ALLOWED_HOSTS` (IP)
- `scripts/agent-entrypoint.sh` — writes CDP config from hostname-based env var

## Reproduction

```sh
# Inside the agent container:

# Works (no sandbox):
AGENT_BROWSER_CONFIG=/home/agent/.agent-browser/config.json \
  agent-browser --session test open "https://example.com"
# ✓ Connects and navigates

# Fails (through sandbox):
SANDBOX_ALLOWED_HOSTS=172.18.0.4 \
AGENT_BROWSER_CONFIG=/home/agent/.agent-browser/config.json \
  /usr/local/bin/sandbox-exec.sh agent-browser --session test open "https://example.com"
# ✗ Failed to connect via CDP to ws://browser-pool:3000
```


## Fix

The `AGENT_BROWSER_CDP_URL` was constructed from the Docker hostname
(`ws://browser-pool:3000`) while `SANDBOX_ALLOWED_HOSTS` already used the
pre-resolved IP. The fix reuses the same resolved IP for the CDP URL so both
variables are consistent and the CLI can connect inside the sandbox.

The bug existed in two code paths that independently built the CDP URL:

1. `buildAgentEnv()` in `runtime-lifecycle.ts` — used by the port-based
   runtime launcher.
2. The inline env builder in `DockerAgentManager.startContainer()` — used by
   the Docker-based launcher.

Both now derive `sandboxHost` first (from `browserPoolResolvedHost` or the URL
hostname as fallback), then construct the CDP URL as
`ws://${sandboxHost}:${port}` instead of `ws://${browserUrl.host}`.

## Files Changed

- `apps/worker/src/agents/runtime-lifecycle.ts` — construct CDP URL from resolved IP
- `apps/worker/src/agents/docker-agent-manager.ts` — same fix in Docker launcher path
- `apps/worker/src/agents/runtime-lifecycle.test.ts` — updated assertions: CDP URL now uses resolved IP when `browserPoolResolvedHost` is provided; added comments clarifying hostname fallback cases

## Verification

- `pnpm lint` passes with zero errors.
