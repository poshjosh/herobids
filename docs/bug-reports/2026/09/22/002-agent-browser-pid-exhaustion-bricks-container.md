# Bug Report: agent-browser daemons leak threads and exhaust the container PID budget, bricking the agent

- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-09-22
- **Summary:** A `standard`-level agent (`pa`, ID `3a15d738-8870-448c-9a9e-5cbf6e85d4d1`) running the `google-flights` external skill drove `agent-browser` through `execute_shell` repeatedly. Each invocation spawned a persistent `agent-browser` daemon that was never closed; the orphaned daemons (plus their tokio threadpools and the `sudo`/`sh`/`ip`/`iptables` forks from `sandbox-exec.sh`) accumulated until the container hit its `PidsLimit` of 128. Once exhausted, every subsequent `execute_shell`/`execute_code` failed with `sh: can't fork: Resource temporarily unavailable`, bricking the agent's tool runtime. The `agent-browser`/CDP/DNS/sandbox stack itself is healthy — this is a process-leak problem, not a browser/network problem.

## Symptoms

The agent's `execute_shell` call returned:

```
execute_shell failed with exit code 1: Command failed: /usr/local/bin/sandbox-exec.sh sudo -u agent sh -lc "/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-arm64 --session s1 open \"https://www.google.com\" 2>&1; echo \"-
```

Re-running the exact command inside the container surfaced the real cause:

```
/usr/local/bin/sandbox-exec.sh: line 36: can't fork: Resource temporarily unavailable
```

Line 36 of `sandbox-exec.sh` is `ip netns add "$NS"` — the sandbox cannot even fork the `ip` process to build its network namespace.

## Root Cause

1. **`agent-browser` uses a client–daemon architecture** (see `docs/features/2026/08/31/002-agent-browser-cli/000-notes.md`). The first CLI invocation starts a background daemon that holds the CDP connection and persists across calls.
2. **`execute_shell` runs each command in a fresh, short-lived shell** (`sudo -u agent sh -lc "…"`, wrapped by `sandbox-exec.sh`). When the shell exits, the daemon it spawned is re-parented to PID 1 and lives on.
3. **The daemon's Rust (tokio) threadpool contributes many threads**, and Docker's `PidsLimit` counts *tasks* (threads), not just processes. A handful of orphan daemons + their threadpools + the per-invocation `sudo`/`sh`/`ip`/`iptables` forks quickly consumes the 128-PID budget.
4. **Nothing closes the sessions.** The `google-flights` skill drives `--session <name>` opens repeatedly without a matching `agent-browser close`, and the platform has no teardown hook that kills orphaned daemons when an `execute_shell` call (or the agent session) ends.

This is the same failure class as `2026/08/31/003-agent-container-pid-limit-exhaustion.md` (raised `maxProcesses` 50 → 128). That fix was a band-aid: it only raised the ceiling; it did not stop the leak. The `pa` agent exhausted the raised 128 limit in ~1 hour.

### Evidence

| Check | Value |
|---|---|
| `pids.current` / `pids.max` (`pa`) | `126 / 128` |
| `pids.current` (3 sibling agents) | `13 / 128` each |
| Visible processes (`ps -e`) | ~28 |
| Implied threads (126 − 28) | ~98 (orphan daemons + tokio threadpools + sudo/sh/ip forks) |
| `ps -e -o pid,ppid,comm` | many `node`/`sudo` with `PPID=1` (re-parented orphans) |
| `agent-browser open` (no sandbox) | `✓ Example Domain` — works |
| `agent-browser open --cdp ws://172.18.0.5:3000` | `✓ Example Domain` — works |
| Config file `{"cdp":"ws://172.18.0.5:3000"}` | correct, IP-based (DNS/CDP fixes intact) |
| `browser-pool` (`172.18.0.5:3000/json/version`) | healthy, reachable |

The 2026-08-31 sandbox/CDP/DNS/socket fixes (bug reports 001–006) are all still intact; `agent-browser` connects correctly. Only the PID budget is exhausted.

## Impact

- Any long-running agent that exercises `agent-browser` (or any tool that repeatedly forks) will eventually exhaust the PID budget and lose *all* tool execution (`execute_shell`, `execute_code`), effectively bricking the session — the agent cannot even run a `kill` to self-recover because `sh` itself cannot fork.
- The failure is invisible as a process leak until the container is already bricked; the only observable signal is a generic `exit code 1` / `can't fork` message.
- Affects `standard` and `full` permission levels alike (both wrap `execute_shell` in `sandbox-exec.sh`).

## Proposed Solutions

### Option 1 (primary) — kill the process group when `execute_shell` exits

Run each `execute_shell` command in its own process group and tear it down on exit so the `agent-browser` daemon cannot orphan. In `apps/worker/src/tools/shell.ts`, wrap the inner command with `setsid` and kill the group in the `finally`/teardown path:

```sh
setsid sh -lc '<command>' & pid=$!; wait "$pid" || true; kill -- -"$pid" 2>/dev/null || true
```

(adapted to the sandbox invocation; `sandbox-exec.sh` must forward the group kill, or the group-kill must be applied outside the sandbox wrapper). This addresses the leak at its source: the daemon dies with its caller.

- **Trade-off:** kills any intentionally-backgrounded work the agent started (`&`). Acceptable given the sandbox is already a disposable per-command namespace; and it matches the intent that agent work is tick-scoped.

### Option 2 — explicit `agent-browser close` on session/skill completion

Ensure the `google-flights` skill (and any skill that drives `agent-browser`) always issues `agent-browser close` in a teardown step. 

- **Trade-off:** relies on LLM/skill adherence — not robust as a sole fix. Use only as defense-in-depth alongside Option 1.

### Option 3 — cap daemon threadpool / raise or rescope the PID limit

- Investigate whether `agent-browser` honors an env knob to bound its threadpool (e.g. tokio worker threads), reducing per-daemon task count.
- Reconsider `PidsLimit`: either raise it further for browser-capable agents, or bound it by *processes* rather than *tasks* if the scheduler allows (`--pids-limit` only counts tasks in Docker; Nomad has separate process/task knobs to evaluate).

- **Trade-off:** raises the ceiling again without stopping the leak; only delays the failure. Not sufficient alone.

### Recommended plan

1. Implement **Option 1** (process-group teardown) in the `execute_shell` path.
2. Add **Option 2** (skill-level `close`) as defense-in-depth.
3. Evaluate **Option 3** (threadpool/PID rescoping) to confirm headroom for legitimate multi-process agent work.
4. Add a regression test asserting no orphaned processes/daemons remain after `execute_shell` returns.

## Immediate Remediation (no code change)

Restart the affected agent container to clear the 126/128 state:

```sh
docker restart herobids-agent-3a15d738-8870-448c-9a9e-5cbf6e85d4d1
```

## Files Involved

- `apps/worker/src/tools/shell.ts` — builds and executes the sandboxed `execute_shell` command (teardown belongs here)
- `scripts/sandbox-exec.sh` — network-namespace wrapper; forks `ip`/`iptables`/`sudo`/`sh` per invocation
- `scripts/agent-entrypoint.sh` — writes `agent-browser` CDP config (intact; not at fault)
- `apps/worker/src/agents/docker-agent-manager.ts` — sets `PidsLimit` from `maxProcesses`; source of the 128 ceiling
- `config/default.yaml` — `sandboxDefaults.maxProcesses` / `resourceProfiles.*.maxProcesses`
- `docs/bug-reports/2026/08/31/003-agent-container-pid-limit-exhaustion.md` — prior band-aid (50 → 128)

## Verification

- Reproduce: run a loop of `execute_shell`-style `agent-browser --session n open …` invocations and observe `pids.current` climb past the visible-process count; confirm `agent-browser close` or group-teardown prevents the climb.
- Confirm `pids.current` returns to baseline after `execute_shell` returns under Option 1.
