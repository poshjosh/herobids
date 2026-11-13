# Sandbox Egress Rules by UID (Replaces Network Namespace)

> **Superseded on 2026-11-13** by [sandbox-shell-access.md](../../2026/11/12/001-hetzner-scale-path/sandbox-shell-access.md), part of the Hetzner scale path plan. Do not follow this plan's phases. It stays as background for the design and its decisions.

**Status:** Code written and unit-tested locally; not built into an image, not deployed
**Estimated effort:** 2–3 days engineering, plus a staged rollout on staging
**Dependencies:** [Bug 2026/11/09 001](../../../bug-reports/2026/11/09/001-sandbox-mount-blocked-by-apparmor-on-nomad.md), [rollout plan](../000-staged-agent-node-rollout/001-plan.md), [incident learnings](../000-staged-agent-node-rollout/002-learnings-and-state.md)

## Summary

The sandbox created a network namespace to block private-network access from agent commands. That needs `SYS_ADMIN` and a `mount`, which Docker's AppArmor profile blocks on Nomad nodes.

This plan removes the namespace. Instead, the container's iptables rules block private networks for the agent's UID, installed once at container start. Only `NET_ADMIN` is needed.

## Decisions (from review)

| # | Decision | Effect |
|---|---|---|
| 1 | Full mode keeps passwordless `sudo` | Full mode is unchanged. It runs as root and is not network-restricted. |
| 2 | Standard mode keeps `sudo -u agent` | No new sandbox user. |
| 3 | Full mode has no network block | Root can change iptables, so the rule would not hold. Stated plainly in docs. |
| 4 | Loopback is not blocked | Confirm nothing listens on loopback in the agent container before relying on this. |
| 5 | Remove the `ip netns` path | One sandbox path. |
| 6 | No third caps node for now | Check capacity on the two caps nodes first. |
| 7 | Pin the agent image to `sha-<commit>` | Nodes cannot run a stale `:latest`. |
| 8 | Remove `herobids-staging-agent-1` | No investigation before removal (see Phase 6). |
| 9 | Move agents in groups | Two, check gates, then three at a time. |

## Known limitations (must be documented)

1. **Standard mode can bypass the rules.** The agent user has passwordless `sudo` (`docker/Dockerfile.agent`), so a standard command can run `sudo iptables -F`. The UID rule guards against accidental private-network access. **It is not a security boundary.** Accepted for simplicity.
2. **Full mode is not network-restricted.** It runs as root, and root can change the rules. This is the intended meaning of full mode.
3. **`execute_code` runs as root in every mode** (`code.ts` does not use `sudo -u agent`). The UID rule therefore does not restrict code execution. The wrapper still requires the rules to be installed (fail-closed), but it does not restrict network access for code. Confirm before the canary.
4. **Nomad launch env may not include `SANDBOX_ALLOWED_HOSTS`.** The Docker path sets it for the browser pool (`docker-agent-manager.ts`). Verify the Nomad path (open item in Phase 1).

## Design

### Container start (entrypoint)

`scripts/agent-entrypoint.sh` runs as root. When the container has `NET_ADMIN`, it runs `scripts/sandbox-egress.sh` before `exec "$@"`:

- Clears any old marker, then writes `/run/herobids/sandbox-egress-ready` only after every rule is installed.
- Accepts established connections for the agent UID.
- Accepts resolver addresses from `/etc/resolv.conf` and each `SANDBOX_ALLOWED_HOSTS` entry.
- Rejects `10/8`, `172.16/12`, `192.168/16`, `169.254/16` for the agent UID. Rejects `fc00::/7` and `fe80::/10` with `ip6tables`.
- Loopback is not rejected (decision 4).
- **Fail closed:** if `NET_ADMIN` is present and a rule fails, the entrypoint exits non-zero, so the boot error is visible. If `NET_ADMIN` is absent, the entrypoint skips rules and writes no marker. Commands then fail with a clear error (see below).

The rules live in the container network namespace, so they apply to every process running as the agent UID, including `sudo -u agent` children.

### Per-command wrapper

`scripts/sandbox-exec.sh` keeps its path, so the call sites in `shell.ts` and `code.ts` do not change. It now:

1. Fails with exit 97 and a clear message if the marker is missing. Message: `sandbox egress rules not active in this container`.
2. Otherwise `exec`s the command. No namespace, no `mount`.

### Capabilities

| Where | Before | After |
|---|---|---|
| `apps/worker/src/agents/nomad-runtime-adapter.ts` (`cap_add`, when `sandboxCapsEnabled`) | `NET_ADMIN`, `SYS_ADMIN` | `NET_ADMIN` |
| `apps/worker/src/agents/docker-agent-manager.ts` (`CapAdd`) | `NET_ADMIN`, `SYS_ADMIN` | `NET_ADMIN` |
| `infra/hetzner/cloud-init-nomad-client.yaml` (`allow_caps`) | `net_admin`, `sys_admin` | `net_admin` only |

Existing caps nodes (`agent-caps-1`, `agent-caps-2`) keep `sys_admin` in `allow_caps` until they are replaced. No job requests it, so it is harmless.

### Error classification

`NON_RECOVERABLE_SANDBOX_PATTERNS` gains the wrapper message, so an agent is told not to retry. The old `mount --make-shared` and `ip netns add` patterns are kept, with a comment, because older images may still emit them.

## Phases

### Phase 0 — Baseline

- [ ] Record `NOMAD_AGENT_IMAGE`, `NOMAD_SANDBOX_CAPS_ENABLED` (`false`), and node eligibility.
- [ ] Record the current digest of `ghcr.io/poshjosh/herobids-agent:latest`.
- [ ] Confirm nothing listens on `127.0.0.1` inside the agent container (decision 4).

**Gate:** baseline recorded in the rollout log.

### Phase 1 — Code and tests

- [x] Rewrite `scripts/sandbox-exec.sh` as a marker-gated wrapper.
- [x] Add `scripts/sandbox-egress.sh` and call it from `scripts/agent-entrypoint.sh`.
- [x] `cap_add` and `CapAdd` set to `NET_ADMIN` only; `allow_caps` to `net_admin` only.
- [x] Add the wrapper message to the non-recoverable patterns.
- [x] Rewrite `scripts/shell/tests/sandbox-allowlist-smoke-test.sh` for the UID rules: marker, standard-mode blocking and allowlist, root exemption, and refusal without `NET_ADMIN`. Not yet run; it needs the built image (Phase 2).
- [x] Verify the Nomad launch env passes `SANDBOX_ALLOWED_HOSTS` (known limitation 4). Verified in code: the launcher builds env with `buildAgentEnv` for every backend, and the Nomad task uses `Env: config.env`. Regression test added in `nomad-runtime-adapter.test.ts`.
- [x] Run `apps/worker` tests for touched files (159 passing), `tsc --noEmit`, and `shellcheck` on the changed scripts.

**Gate:** tests pass; flag-off launch output unchanged apart from the `cap_add` value.

### Phase 2 — Image and probe

- [ ] Merge to `main`. CI publishes `herobids-agent:sha-<commit>`.
- [ ] Probe the pinned image on `agent-caps-1` with `--cap-add NET_ADMIN` only (no `SYS_ADMIN`, no AppArmor change):

| Check | Run as | Expected |
|---|---|---|
| Private address `10.0.0.1` | agent UID (via `sudo -u agent`) | Rejected |
| Public address (`1.1.1.1:443`) | agent UID | Allowed |
| Allowlisted address (`SANDBOX_ALLOWED_HOSTS`) | agent UID | Allowed |
| Same private address | root | Allowed (known limitation 2) |
| `iptables -F` | agent UID via `sudo` | Succeeds (known limitation 1) |
| Entrypoint with `NET_ADMIN` removed | container start | Starts; no marker; wrapper returns exit 97 |
| Entrypoint with `NET_ADMIN`, rule fails | container start | Exits non-zero |

**Gate:** every row matches. Any surprise stops the rollout.

### Phase 3 — Worker deploy (flag off)

- [ ] Deploy with `DEPLOY_REF=origin/main infra/hetzner/scripts/push.sh --env staging --yes`.
- [ ] Confirm the worker env (`NOMAD_SANDBOX_CAPS_ENABLED=false`).

**Gate:** worker healthy; no change in agent behaviour.

### Phase 4 — Canary

- [ ] Set `NOMAD_AGENT_IMAGE` to the pinned `sha-` tag in `/opt/herobids/.env`. Restart the worker.
- [ ] Set `NOMAD_SANDBOX_CAPS_ENABLED=true`. Restart the worker.
- [ ] Relaunch Job searcher (`bb11883d`) with the [relaunch procedure](../../../tech/agents/agent-runtime-rollout-guide.md#7-agent-relaunch). This also removes its `SYS_ADMIN`.
- [ ] Verify: job spec has only `NET_ADMIN`; placed on a caps node; boot within 120 s; session `running`; one `execute_shell` succeeds; no `sandbox_infrastructure_error`.

**Gate:** all pass. On failure, flag off and relaunch.

### Phase 5 — Move the rest

Relaunch before draining. A drain moves running allocations with their old spec.

- [ ] Relaunch the seven remaining agents in groups: two, then three, then two.
- [ ] After each group, check placement, boot, heartbeat, and the fault stream.
- [ ] Check capacity before each group (decision 6). Add `agent-caps-3` only if a group does not fit.

**Gate:** all eight agents `running` on caps nodes with no fault events.

### Phase 6 — Retire the old nodes

- [ ] Drain `herobids-staging-agent-3`. Only `browser-pool` should remain. Confirm it runs on a caps node and passes `infra/hetzner/scripts/smoke-test-browser-pool.sh`.
- [ ] Confirm `herobids-staging-agent-2` is empty.
- [ ] Set `agent_node_count = 0` in `staging.tfvars` (local file). `agent[0]` (agent-1) and `agent[1]` (agent-2) are the two indexes. Run `terraform plan` with `TF_DATA_DIR=.terraform-envs/staging`. **Stop if the plan destroys anything other than `hcloud_server.agent[0]`, `hcloud_server.agent[1]`, and their network attachments.** Apply only after review.
- [ ] **Open item:** `herobids-staging-agent-3` is not in Terraform state. Decide its removal path when it is empty.

**Gate:** only the caps pool remains; the plan matched.

### Phase 7 — Cleanup

- [ ] Update [tool-access-and-sandboxing.md](../../../tech/agents/tool-access-and-sandboxing.md) and [permission-levels.md](../../../tech/agents/tools/permission-levels.md): UID design, full mode's lack of network block, `execute_code` running as root, and the sudo limitation.
- [ ] Mark bug reports 2026/11/07 001 and 002, and 2026/11/09 001, Fixed with evidence.
- [ ] Add a CHANGELOG entry.

## Rollback

1. Flag off (`NOMAD_SANDBOX_CAPS_ENABLED=false`) and restart the worker.
2. Set `NOMAD_AGENT_IMAGE` back to the previous `sha-` tag. Relaunch affected agents.
3. Re-enable eligibility on old nodes only if they still exist. Create new nodes through Terraform rather than re-adding removed ones.

## Acceptance criteria

- [ ] Phase 2 probe matrix passes on the pinned image.
- [ ] Canary and all eight agents run `execute_shell` with no `sandbox_infrastructure_error`.
- [ ] No job requests `SYS_ADMIN`.
- [ ] Old nodes `agent-1` and `agent-2` removed through a reviewed plan; `agent-3` has a decided path.
- [ ] Docs updated with the known limitations.

## Risks

| Risk | Mitigation |
|---|---|
| Rules missing on a node | Fail-closed boot error in the entrypoint; probe in Phase 2 |
| Browser pool unreachable | Allowlist via `SANDBOX_ALLOWED_HOSTS`; smoke test before drain |
| Skill expects a different network path | Test a sample of skills in the canary |
| Node runs cached `:latest` | Pin `sha-` tag (decision 7) |
| Terraform count removes the wrong node | Check the plan before apply (Phase 6) |
| `sudo` bypasses standard-mode rules | Accepted and documented (known limitation 1) |
