# Bug Report: Agent container refuses to start when `SANDBOX_ALLOWED_HOSTS` holds a hostname

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-11-14
- **Summary:** On the local Docker stack, `run-all-tests.sh --e2e` fails at step 6b (connection cycle) because the agent container exits at start: `sandbox-egress.sh` passes the unresolvable hostname `browser-pool` to `iptables`, fails, and the entrypoint fails closed. A second defect in the same run, the worker-readiness gate, can never succeed.

## Symptom

`scripts/shell/tests/run-all-tests.sh --e2e` (Playwright passed: 15 passed, 4 skipped):

```
[tests] Waiting for the worker runtime launcher to be ready…
[tests] Worker runtime launcher readiness log not seen after ~120s; running 6b anyway.
wait for connection link failed: {"agentId":"36ebcb26-d7ab-4dce-bcc6-0b4b286cf4b6","waitedMs":300626}
[release] Core tests FAILED. Fix failures before releasing.
```

`bash scripts/shell/tests/connection-cycle-test.sh` run on a fresh local stack (started the way `run-all-tests.sh` starts it, without teardown) failed the same way after 180 s (`waitedMs: 180417`).

## Evidence (reproduced 2026-11-14)

Worker log, at worker start:

```
WARN (herobids-worker): Failed to resolve browser pool hostname for sandbox allowlist
      Error: getaddrinfo ENOTFOUND browser-pool
```

Worker log, when the agent started:

```
INFO (docker-agent-manager): Agent container started
WARN (docker-agent-manager): Agent container died — startup_failure   (same second)
INFO (agent-crash-loop-guard): Recorded agent crash event  crashCount: 1  maxCrashes: 3
```

Agent container (`docker ps -a`: `herobids-agent:latest  Exited (1)`), `docker logs`:

```
iptables v1.8.13 (nf_tables): host/network `browser-pool' not found
Try `iptables -h' or 'iptables --help' for more information.
entrypoint: sandbox egress rules failed to install; refusing to start
```

Readiness gate, reproduced against the running worker under `set -euo pipefail`. The launcher line is present (`grep -c` returns 1), but the gate's exact pipeline never matches:

```
run 1..5: gate did NOT match
PIPESTATUS=255 0
```

## Root Cause

### Defect 1 (the failure): a hostname in the egress allowlist aborts container start

1. Local compose has no `browser-pool` service. The only one is in `docker-compose.dev.yaml`, which `build-and-run.sh` and `reset-and-run.sh` include but `run-all-tests.sh` does not (it uses `docker-compose.yaml` plus `docker/xstack.override.yml`).
2. `config/default.yaml` still has `browserPool.enabled: true` with `url: http://browser-pool:3000`, so the worker tries to resolve that host. `lookup()` fails (`apps/worker/src/index.ts`, "Failed to resolve browser pool hostname"), leaving `browserPoolResolvedHost` undefined.
3. `docker-agent-manager.ts` and `runtime-lifecycle.ts` then fall back to the raw hostname: `SANDBOX_ALLOWED_HOSTS=browser-pool`.
4. `scripts/sandbox-egress.sh` only filters entries with `^[0-9a-zA-Z.:/-]+$`. A hostname passes that filter, so it reaches `iptables -A … -d browser-pool`. iptables tries to resolve it, fails, and `set -e` stops the script.
5. `scripts/agent-entrypoint.sh` fails closed by design: with `NET_ADMIN` present, a failed rule means the container exits 1. The agent never boots, so no connection link is produced. The crash-loop guard stops it after 3 crashes.

The script's own comment says the allowlist holds "IPs or CIDRs", and `docs/tech/agents/tool-access-and-sandboxing.md` says the worker resolves the hostname to an IP. The filter does not enforce either statement.

### Defect 2: the readiness gate can never succeed

`run-all-tests.sh` runs with `set -euo pipefail`. The gate is:

```bash
docker compose -f docker-compose.yaml logs worker 2>/dev/null | grep -q "Agent runtime launcher initialized"
```

`grep -q` exits at the first match and closes the pipe. `docker compose logs` then exits non-zero (255). With `pipefail` the pipeline reports failure even though the line was found, so the `if` is false on every iteration. The gate always spends ~120 s and then prints "running 6b anyway". It never gated anything.

### Why it was not seen earlier

- The local `herobids-agent:latest` image used before 2026-11-14 predates the container-start egress rules (`ee532da6`, 2026-11-11, "Update docs, skills"). Before that, `SANDBOX_ALLOWED_HOSTS` was only read when a shell command ran, so a bad entry could not stop an agent booting. The image on this machine was rebuilt on 2026-11-14 12:46 UTC, which fits the "passed earlier, fails now" report. This link is inferred from dates; the old image is gone, so it was not re-run.
- On staging and production the pool URL is empty and resolves through Nomad to a private IP, so the allowlist always holds an IP.
- Playwright journeys start and stop agents but never need a real agent boot to succeed, so only the connection cycle notices.

### Related history (read)

- `docs/bug-reports/2026/08/31/001-agent-browser-cdp-fails-inside-sandbox-dns.md` introduced pre-resolving the pool host into `SANDBOX_ALLOWED_HOSTS`; it assumed a `browser-pool` container exists.
- `docs/features/pending/000-sandbox-uid-egress/001-plan.md` and `docs/features/2026/11/12/001-hetzner-scale-path/sandbox-shell-access.md` define the fail-closed entrypoint. Fail-closed stays; only the input validation changes.
- `docs/bug-reports/2026/11/07/002-staging-agents-fail-boot-after-cap-change-reverted.md` is a different cause (a node that does not allow `NET_ADMIN`) with the same symptom.
- No earlier bug report covers a hostname in the allowlist or the readiness gate.

## Fix

1. `scripts/sandbox-egress.sh`: accept only IPv4/IPv6 addresses and CIDRs from `SANDBOX_ALLOWED_HOSTS`. Skip anything else with a one-line warning to stderr. A skipped entry stays blocked, so this is the safe direction. Real iptables failures still stop the container. `SANDBOX_MARKER_DIR` is added as an override (default unchanged) so the script can be tested without root.
2. `scripts/shell/tests/run-all-tests.sh`: capture the worker logs before grepping, so `pipefail` and SIGPIPE cannot hide a match. When the gate times out, print the worker state and the last worker log lines. When step 6b fails, print the worker and agent container logs before the stack is torn down.
3. New `scripts/shell/tests/sandbox-egress-test.sh`: runs `sandbox-egress.sh` with stub `iptables`/`ip6tables`. Wired into `run-all-tests.sh` as a tier that needs no Docker.

## Not changed (follow-ups)

- The worker still falls back to the raw hostname for `SANDBOX_ALLOWED_HOSTS` and `AGENT_BROWSER_CDP_URL` when resolution fails. It is harmless now that the script ignores it, and existing unit tests assert it (`runtime-lifecycle.test.ts`). A hostname in `AGENT_BROWSER_CDP_URL` also does not work inside the sandbox (bug 2026/08/31/001), so the browser tools stay unusable when the pool is unresolvable.
- `run-all-tests.sh --e2e` still has no browser pool (it does not include `docker-compose.dev.yaml`). Browser tools are not exercised there. Decide whether to add the dev compose file or set `browserPool.enabled: false` for that run.

## Files Changed

- `scripts/sandbox-egress.sh`
- `scripts/shell/tests/run-all-tests.sh`
- `scripts/shell/tests/sandbox-egress-test.sh` (new)
- `CHANGELOG.md`

## Verification

All run 2026-11-14 on the local machine. Nothing committed.

| Check | Result |
|---|---|
| `bash scripts/shell/tests/sandbox-egress-test.sh` (stub iptables) | 17 passed, 0 failed |
| Same test against the old logic (HEAD script plus only the marker-dir override) | 10 failed, including `iptables … host/network 'browser-pool' not found`. The test catches the bug |
| Real `iptables` in `herobids-agent:latest`, `SANDBOX_ALLOWED_HOSTS=browser-pool`, baked-in (old) script | exit 2, same message as the incident |
| Same, new script mounted over it | exit 0, warning printed, marker written, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` still `REJECT` |
| Same with `browser-pool,10.0.0.5` | exit 0, `10.0.0.5/32 -j ACCEPT` present |
| Readiness gate pipeline against a running worker: old form | 0 of 5 matches (`PIPESTATUS=255 0`) |
| Readiness gate pipeline: new form (read into a variable, then `grep -q`) | 3 of 3 matches |
| `connection-cycle-test.sh` on a fresh stack, old agent image | FAIL, `wait for connection link failed`, agent container `Exited (1)` |
| Same stack, agent image rebuilt with the fix | `"verdict": "PASS"`, agent container `Up` |
| `pnpm lint` | passes |
| `shellcheck -S warning` on `sandbox-egress.sh`, `sandbox-egress-test.sh` | clean |
| `bash scripts/shell/tests/run-all-tests.sh --e2e` from a cold start | all 12 tiers PASS: Unit, Agent-bot LLM inheritance, Sandbox egress rules, Integration, Functional, Transport parity, 4 API smoke, Playwright, Connection cycle. The log shows "Worker runtime launcher is ready." |

### Notes

- `run-all-tests.sh` does not build `herobids-agent:latest`; `build-and-run.sh` does. A machine with an agent image built between 2026-11-11 and this fix still has the old script baked in and keeps failing until the image is rebuilt (`docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`). Staging and production are not affected: their allowlist holds an IP.
- Browser pool with a real IP, verified locally against the rebuilt agent image (these are the `run-extra-tests.sh` Tier 4 smoke tests; they start `browser-pool` from `docker-compose.dev.yaml` themselves):
  - `sandbox-allowlist-smoke-test.sh`: 6 passed, 0 failed. A standard command is blocked from the pool IP without the allowlist, reaches it when the IP is allowlisted, and an unlisted private IP stays blocked.
  - `browser-pool-agent-browser-smoke-test.sh`: 5 passed, 0 failed (`agent-browser` open, snapshot and close through Browserless).
- Not verified, and cannot be verified locally: the Nomad path. Staging and production run agents as Nomad jobs from the image `ghcr.io/poshjosh/herobids-agent:<tag>` on Hetzner nodes, and the local stack uses the Docker backend. Verifying needs a commit and push to `main` (CI publishes `sha-<commit>`), pinning that tag with `NOMAD_AGENT_IMAGE` on staging, a deploy, and starting an agent there. Pass condition: the allocation log shows `sandbox-egress: rules installed for user agent`. The risk is low: the script is identical, the allowlist on Nomad is an IP from service discovery, and the same image passed the real-iptables checks above.
