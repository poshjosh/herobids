# Bug Report 016 — Agent Container Crash: PID Limit Too Low (exit 139 / SIGSEGV)

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** Agent containers launched by the worker crashed immediately with exit code 139 (SIGSEGV), preventing any LLM ticks from running.

## Root Cause

Two `sandboxDefaults` config values in `config/default.yaml` were too restrictive for a Node.js process running the agent runtime:

1. **`maxProcesses: 10`** — Node.js requires many threads (libuv worker pool, V8 isolates, native addon threads). A limit of 10 is far below what Node.js needs at startup, causing a SIGSEGV when `pthread_create` fails.
2. **`memoryMb: 512`** — While not the direct crash cause (OOMKilled was false), 512 MB is marginal for Node.js + LLM SDK initialization; increased as a safety margin.

The container logged only 4 "Warning: OpenAI may not support records in schemas!" lines before exiting with code 139. `docker inspect` confirmed `OOMKilled: false` and `ExitCode: 139`. A manual `docker run` with `--memory=1g` and no `--pids-limit` flag ran successfully.

## Fix

Updated `config/default.yaml`:
```yaml
# Before
sandboxDefaults:
  memoryMb: 512
  maxProcesses: 10

# After
sandboxDefaults:
  memoryMb: 1024
  maxProcesses: 50
```

Worker image was rebuilt (`docker compose build worker && docker compose up -d worker`) to bake the updated config into the image.

## Files Changed

- `config/default.yaml` — `sandboxDefaults.memoryMb`: 512 → 1024; `sandboxDefaults.maxProcesses`: 10 → 50

## Verification

After the fix:
- Container launched with `PidsLimit: 50` and `Memory: 1073741824` (verified via `docker inspect`)
- Agent runtime logged: "Agent runtime starting", "Redis connected", "Agent tick starting", "Prepared tick context payload"
- Container remained running for 60+ seconds without crashing
- Subsequent ticks logged "Scout held the tick" and "Skipping agent tick before LLM dispatch" — correct behavior for an agent with no portfolio changes to act on
