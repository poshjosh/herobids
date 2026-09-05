# Bug Report: `sandbox-exec.sh` leaks a shell error when `/proc/sys` is read-only

- **Status:** OPEN (fix drafted, not yet committed at time of writing)
- **Severity:** Low (cosmetic/noise in the common case; can mask real failures and break a smoke-test success match)
- **Date:** 2026-09-04
- **Discovered By:** `scripts/shell/tests/run-extra-tests.sh --all` → Tier 4 `sandbox-allowlist-smoke` Test 2 failed with a leaked error in its captured output.
- **Component:** `scripts/sandbox-exec.sh` (production code — baked into the agent image via `docker/Dockerfile.agent`: `COPY scripts/sandbox-exec.sh /usr/local/bin/sandbox-exec.sh`; runs on every `execute_shell`/`execute_code` sandbox invocation).

## Summary

`sandbox-exec.sh` enables host-side NAT for the sandbox network namespace by writing to the `ip_forward` sysctl:

```sh
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
```

The intent is clearly "best-effort, non-fatal" (`2>/dev/null || true`). But when `/proc/sys` is **read-only** (e.g. a container run without the sysctl being writable), the failure occurs while the shell tries to **open the redirect target**, before the command's stderr redirection or the `||` short-circuit apply. The shell therefore prints the error to the script's stderr regardless:

```
/usr/local/bin/sandbox-exec.sh: line 54: can't create /proc/sys/net/ipv4/ip_forward: Read-only file system
```

`2>/dev/null` cannot suppress this (it applies to the command's own fds, not to the shell's redirection-open failure), and `|| true` cannot catch it (a redirection failure is not the command's exit status). The `set -e` at the top of the script does not abort here because the redirection error is non-fatal to the shell in this context, but the message still leaks.

## Steps to Reproduce

1. Run `sandbox-exec.sh` inside a container whose `/proc/sys` is read-only (i.e. without a writable `net.ipv4.ip_forward`), e.g. the Tier 4 sandbox-allowlist smoke test's `docker run` (which adds `CAP_NET_ADMIN`/`CAP_SYS_ADMIN` but does not make `/proc/sys` writable / pass `--sysctl net.ipv4.ip_forward=1`).
2. Observe on stderr:
   ```
   /usr/local/bin/sandbox-exec.sh: line NN: can't create /proc/sys/net/ipv4/ip_forward: Read-only file system
   ```

Observed in the run log (`.ignore/run-extra-tests-log.log`), Tier 4 Test 2:
```
✗ sandbox did NOT allow browser-pool IP with allowlist. Output: /usr/local/bin/sandbox-exec.sh: line 54: can't create /proc/sys/net/ipv4/ip_forward: Read-only file system
```

## Root Cause

Shell redirection semantics: for `cmd > FILE`, the shell opens `FILE` **before** running `cmd` and **before** applying `cmd`'s own redirections (`2>/dev/null`). If opening `FILE` fails (read-only filesystem), the shell emits its own diagnostic to stderr. The trailing `2>/dev/null` redirects the *command's* stderr, not the shell's redirection-open error; `|| true` only guards the command's exit status. So neither guard suppresses the leaked message.

## Impact

- **Common/production path (happy path):** In a correctly provisioned agent container (documented `CAP_NET_ADMIN` + `CAP_SYS_ADMIN`, writable `/proc/sys`), the write succeeds and there is no error. This bug only manifests where `/proc/sys` is read-only.
- **Noise:** When it does manifest, a spurious error is written to stderr on every sandbox invocation.
- **Masking:** The leaked line pollutes captured output. In the sandbox-allowlist smoke test it contaminated Test 2's output and contributed to a confusing failure (compounded by a separate, now-fixed `curl` vs `wget` bug — see Related).

## Fix (drafted)

Wrap the write in a subshell so the redirect-open failure is contained and suppressed, caught via `if !`:

```sh
# Enable IP forwarding for sandbox NAT — best-effort.
# The write is wrapped in a subshell so that when /proc/sys is mounted
# read-only the redirect-open failure lands on the SUBSHELL's stderr (which
# 2>/dev/null suppresses) and surfaces as the subshell's exit status (caught
# by `if !`).
if ! ( echo 1 > /proc/sys/net/ipv4/ip_forward ) 2>/dev/null; then
  : # /proc/sys is read-only or otherwise unwritable — skip forwarding setup.
fi
```

Notes / why not `[ -w ]`:
- **`[ -w /proc/sys/net/ipv4/ip_forward ]` does NOT work here.** Verified empirically: in the non-privileged agent container `/proc/sys` is mounted `ro` (confirmed via `/proc/mounts`), yet `test -w` returns true because it checks the file's permission bits (`-rw-r--r--`, root-owned, container runs as root) and does not detect the read-only *mount*. So `[ -w ]` would still attempt the write and leak the error.
- **No `|| true`** (per maintainer decision). The subshell + `if !` pattern catches failure via exit status, not `|| true`; `2>/dev/null` applies to the subshell (the command being redirected), so it suppresses the shell-level "can't create" diagnostic that a bare `echo 1 > file 2>/dev/null` cannot.
- Behaviourally equivalent to today's intent on the happy path (writable → write happens, `ip_forward=1`). On read-only `/proc/sys`, the write is skipped cleanly with no leaked error.

Verified in the agent image (`herobids-agent:latest`):
- `--privileged` (writable `/proc/sys`): `ip_forward=1`, no error.
- default (read-only `/proc/sys`): no leaked error, execution continues.

## Risk

`sandbox-exec.sh` is security-sensitive production code (the sandbox egress-control mechanism). The change is minimal and does not alter *when* forwarding is enabled on the happy path. Primary residual risk: the script's only automated coverage is the Tier 4 smoke test, which cannot fully run where `/proc/sys` is read-only — so the change should be verified in a container with the proper caps (writable `/proc/sys`) to confirm `ip_forward` is still set to 1.

## Verification

| Check | How |
|-------|-----|
| Happy path unchanged | Run `sandbox-exec.sh` in a container with writable `/proc/sys` → `cat /proc/sys/net/ipv4/ip_forward` is `1`, sandbox egress works |
| No leaked error on read-only procfs | Run in a container with read-only `/proc/sys` → no `can't create ...: Read-only file system` line on stderr |
| `set -e` intact | Script still aborts on genuine setup failures elsewhere |

## Related

- Same test, separate (already-fixed) bug: the agent image never shipped `curl`, only busybox `wget`; the in-container probes used `curl`, producing a false-positive "blocked" on Tests 1/3 and a real failure on Test 2. Fixed in commit `cbfea80c` (test-only, `curl`→`wget`).
- `scripts/sandbox-exec.sh` — the file to change.
- `docker/Dockerfile.agent` — bakes the script into the agent image.
