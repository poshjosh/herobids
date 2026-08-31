# Bug Report: agent container PID limit (50) exhausted by orphan agent-browser daemons

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-08-31
- **Summary:** The agent container PID limit of 50 is too low for workflows that use `agent-browser`. Failed attempts to start the CLI leave orphan daemon processes that accumulate, eventually exhausting the PID limit. Once exhausted, all subsequent `execute_shell` and `execute_code` calls fail with exit code 2 (`sh: can't fork: Resource temporarily unavailable`).

## Symptoms

Agent `08451dd4-9659-4408-a509-70b35e055057` experienced a cascade:

1. Multiple failed `agent-browser` invocations each spawned a daemon process that was never cleaned up.
2. Container reached 49/50 PIDs and 400/512 MB memory.
3. All subsequent `execute_shell` commands failed with exit code 2:

```
sh: can't fork: Resource temporarily unavailable
```

Docker stats at the time:
```
PIDS: 49/50    MEM: 400.4MiB / 512MiB (78.20%)
```

Process list showed 3 orphan `agent-browser` daemon processes:
```
root   65627  node .../dist/daemon.js    (spawned at 16:20, root)
1001   67567  node .../dist/daemon.js    (spawned at 16:23, agent)
1001   68237  node .../dist/daemon.js    (spawned at 16:23, agent)
```

## Root Cause

The `free` and `starter` resource profiles set `maxProcesses: 50` (mapped to Docker `PidsLimit`). Each `agent-browser` invocation may spawn a background daemon process. When the CLI fails (e.g. due to the socket directory permission bug — see bug report 002), the daemon process is not cleaned up. The sandbox script (`sandbox-exec.sh`) also creates transient processes for network namespace setup (`ip netns`, `sudo`, `sh`).

With 4 Node.js processes (main agent + 3 orphan daemons) as the baseline, plus the sandbox overhead per command, the 50-PID ceiling is quickly reached.

## Impact

- Once the PID limit is hit, the agent cannot execute any tools that fork processes (`execute_shell`, `execute_code`), effectively bricking the runtime.
- The agent had no way to recover — it could not kill the orphan processes because `sh` itself could not fork.

## Files Involved

- `config/default.yaml` — `sandboxDefaults.maxProcesses` and `resourceProfiles.*.maxProcesses`

## Fix

Raise `maxProcesses` from 50 to 128 for `free` and `starter` tiers, and from 100 to 200 for `pro`. Also raise the `sandboxDefaults` fallback to 128. This provides sufficient headroom for the sandbox network namespace, `agent-browser` daemons, and any subprocesses spawned by agent tools.

## Files Changed

- `config/default.yaml` — `sandboxDefaults.maxProcesses: 50 → 128`, `free.maxProcesses: 50 → 128`, `starter.maxProcesses: 50 → 128`, `pro.maxProcesses: 100 → 200`

## Verification

- `pnpm lint` passes.
