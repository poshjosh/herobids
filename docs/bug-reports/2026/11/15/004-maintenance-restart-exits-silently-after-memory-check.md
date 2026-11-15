# Bug Report: maintenance-restart.sh exits silently after the memory check

- **Status:** FIXED (in code; not yet run on a server)
- **Severity:** High
- **Date:** 2026-11-15
- **Summary:** Since `6aa925d7` (2026-11-14), `maintenance-restart.sh` exited 1 with no message right after `Memory OK` on every server. It read a `NOMAD_NAMESPACE` key that no `.env` contains, and a grep miss under `set -euo pipefail` kills the script. The fix also closes a second gap that the first one hid: on the Nomad runtime with Nomad unusable, the script marked agents stopped in the DB and then fell back to a `docker stop` that stops nothing.

## Symptom

```
infra/hetzner/scripts/maintenance-restart-from-local.sh --env staging --start-interval=30 --restart-running
...
[..] PRE  Memory OK: 2076 MB free (minimum: 1024 MB).
$            <- script ends here, no "Step 1" line, no error
```

The local wrapper returned to the prompt with no failure text. Nothing was stopped or deployed. With `--skip-deploy` there is no memory check, so the output stops right after `Script up to date.`

## Root Cause

### Defect 1: silent exit on a missing `.env` key

Commit `6aa925d7` added the "Runtime backend detection" block. It reads four keys from `/opt/herobids/.env` like this:

```bash
NOMAD_AGENT_NAMESPACE="${NOMAD_AGENT_NAMESPACE:-$(grep -E '^NOMAD_NAMESPACE=' "${ROOT}/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')}"
```

With `set -euo pipefail`, a `grep` with no match exits 1, the pipeline fails, and the assignment takes the command substitution's status. `set -e` ends the script, and `2>/dev/null` hides the message.

`NOMAD_NAMESPACE` is in no `.env`: not `.env.staging`, `.env.production`, or `.env.environment.example`. No app code reads it. The worker gets its namespace from operator config (`config/default.yaml` → `nomad.namespace`), and `apps/worker/src/config.ts` has no env override for it. So the block died on every server, however complete the server `.env` was. A stale server `.env` (one not re-uploaded with `setup-env.sh`) gives the same symptom one line earlier, at `RUNTIME_BACKEND`. The symptom cannot tell the two apart, and re-uploading the `.env` would not have fixed it.

`NPM_TOKEN` in Step 3 used the same pattern. It did not fail only because that key is normally present.

### Defect 2: Nomad unusable falls back to a `docker stop` that stops nothing

This one was hidden behind Defect 1, because the script never reached Step 2. With `RUNTIME_BACKEND=nomad`, `nomad_available` can still fail (CLI missing, empty `NOMAD_ADDR`, token rejected). Step 2 then:

1. Marked the sessions and agents `stopped` in the DB.
2. Fell back to `docker stop` by label, with only a warning.

The control plane runs Nomad with `client { enabled = false }` (`cloud-init.yaml`). Agent containers run on the agent nodes, so `docker stop` on the control plane finds nothing. The DB said the agents were stopped while their Nomad jobs kept running on the old image.

### Why it was not caught

The block was never run to completion anywhere, and no test covered the script.

## Fix

`infra/hetzner/scripts/maintenance-restart.sh`:

- Added `env_file_value <KEY>`. It wraps the `grep` in `{ ... || true; }`, so a missing key or a missing `.env` gives an empty string with status 0. `RUNTIME_BACKEND`, `NOMAD_ADDR`, `NOMAD_TOKEN` and `NPM_TOKEN` use it. An empty `RUNTIME_BACKEND` means Docker: the worker reads the same `.env` through compose `env_file`, and it defaults to `docker` too.
- Removed the `NOMAD_NAMESPACE` read. The namespace is `NOMAD_AGENT_NAMESPACE`, defaulting to `herobids-agents` (the config value). A `.env` key the worker ignores would let the script and the worker target different namespaces.
- Step 2 picks the stop path before the DB update. If `RUNTIME_BACKEND=nomad` and Nomad is unusable, it exits with `FAIL` and the reason (`nomad_unavailable_reason`) before any agent is touched. The silent `docker stop` fallback for Nomad is gone.
- Documented `RUNTIME_BACKEND`, `NOMAD_ADDR`, `NOMAD_TOKEN` and `NOMAD_AGENT_NAMESPACE` in the script header (`--help`).

## Files Changed

- `infra/hetzner/scripts/maintenance-restart.sh`
- `infra/hetzner/scripts/tests/test-maintenance-restart-runtime.sh` (new)

## Verification

- New `test-maintenance-restart-runtime.sh` runs the real script with `--skip-deploy`. It uses a temp `HEROBIDS_ROOT`, stub `docker`/`nomad`/`curl`/`sleep`, and a clean `env -i` environment. It covers:
  - a Docker `.env` with no runtime keys, and no `.env` at all: these runs complete and the agent is docker-stopped;
  - a complete Nomad `.env` without `NOMAD_NAMESPACE`: the run completes and the job is purged in `herobids-agents` with the `.env` token and address;
  - `NOMAD_NAMESPACE` in `.env` is ignored, while `NOMAD_AGENT_NAMESPACE` is honoured;
  - Nomad unusable (`nomad status` returns 403, empty `NOMAD_ADDR`, or no CLI): the run fails with the reason and makes no DB write and no `docker stop`.
- 26/26 pass. Run against the `HEAD` script, the same test fails 16 checks, including the complete Nomad `.env` case.
- `bash infra/hetzner/scripts/tests/run-all.sh`: all suites pass. `shellcheck -S warning` is clean on both files.
- Not verified: a run against a real server. The wrapper checks the script out from `DEPLOY_REF` (default `origin/main`) before running it, so the fix must be pushed first, or pass `DEPLOY_REF=origin/<branch>`.

## Follow-up

- Other `$(grep ... | ...)` assignments in `infra/hetzner/scripts/*.sh` running under `set -euo pipefail` may share Defect 1. Not audited.
- Steps 5 and 6 log "Running agent containers" from local `docker ps`. On the Nomad runtime this is always 0. This is a pre-existing problem.
