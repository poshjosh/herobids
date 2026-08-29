# Lessons Learnt — Nomad Staging Provisioning

> **Date:** 2026-08-27
> **Environment:** Staging

Bugs and pitfalls encountered while enabling Nomad orchestration on staging.

---

## 1. Nomad `{{ GetPrivateIP }}` selects Docker bridge, not Hetzner private network

**Symptom:** Nomad server advertised `172.17.0.1` (Docker's `docker0` bridge) instead of `10.0.0.2` (Hetzner private network). Agent nodes connected to port 4647 on the correct IP but were told to communicate with the Docker bridge IP, which they couldn't reach.

**Root cause:** Nomad's Go template `{{ GetPrivateIP }}` returns the first RFC 1918 address it finds. Docker's bridge interface (`docker0` at `172.17.0.1`) was enumerated before the Hetzner private network interface (`enp7s0` at `10.0.0.2`).

**Fix:** Replace `{{ GetPrivateIP }}` with a `__PRIVATE_IP__` placeholder in the cloud-init Nomad config files. At boot time, a `runcmd` step extracts the network prefix from the Terraform-configured `private_subnet` variable (e.g. `10.0.0.0/24` → `10.0`, `10.1.0.0/24` → `10.1`) and uses it to build a regex that matches the correct Hetzner private interface, then patches the config with `sed` before starting Nomad.

**Files changed:** `cloud-init.yaml`, `cloud-init-nomad-client.yaml`

---

## 2. Nomad client `server_join` at top level is ignored

**Symptom:** Agent node logs showed `no servers available` and Consul fallback errors, despite the `server_join` block being present in the config and network connectivity being confirmed (`nc -zv 10.0.0.2 4647` succeeded).

**Root cause:** The `server_join` block was placed at the top level of the Nomad HCL config, outside the `client {}` block. For Nomad clients, `server_join` must be nested inside `client {}`. The top-level `server_join` is only for server-to-server gossip joins.

**Fix:** Moved `server_join` inside the `client {}` block and also added the `servers` list as a belt-and-suspenders approach:

```hcl
client {
  enabled = true
  servers = ["10.0.0.2:4647"]
  server_join {
    retry_join = ["10.0.0.2:4647"]
    retry_max  = 0
    retry_interval = "5s"
  }
}
```

**Files changed:** `cloud-init-nomad-client.yaml`

---

## 3. `retry_max = 30` causes permanent join failure

**Symptom:** Agent node exhausted all 30 retries during initial boot (the Nomad server wasn't ready yet), then fell back to Consul-based discovery, which doesn't exist. The node never recovered — even after the server became available.

**Root cause:** `retry_max = 30` with `retry_interval = "5s"` gives only 150 seconds of retries. If the agent boots faster than the server (both provisioned simultaneously), retries exhaust before the server is ready.

**Fix:** Set `retry_max = 0` (infinite retries). The agent will keep trying indefinitely until it finds the server.

**Files changed:** `cloud-init-nomad-client.yaml`

---

## 4. `NOMAD_ADDR` env var not mapped in worker config

**Symptom:** Worker logged `nomadAddr: "http://localhost:4646"` despite `NOMAD_ADDR=http://10.0.0.2:4646` being present in the container environment. The worker couldn't reach the Nomad API.

**Root cause:** The `applyEnvOverrides` map in `apps/worker/src/config.ts` had `NOMAD_TOKEN` mapped but not `NOMAD_ADDR`. The Zod schema default (`http://localhost:4646`) was used instead.

**Fix:** Added `NOMAD_ADDR: { path: 'nomad.addr', type: 'string' }` to the env overrides map.

**Files changed:** `apps/worker/src/config.ts`

---

## 5. `agent_node_count` in cloud-init causes unnecessary server replacement

**Symptom:** Changing `agent_node_count` from 0 to 1 via `terraform apply -var="agent_node_count=1"` triggered a destroy-and-recreate of the control-plane server, not just the agent node.

**Root cause:** `agent_node_count` is passed as a template variable into `cloud-init.yaml` to seed `/var/run/nomad-autoscale-node-count`. Changing it changes the `user_data` hash, which Terraform treats as an immutable attribute — forcing server replacement.

**Workaround:** Set `prevent_destroy = false` temporarily, or use `-target` to isolate changes (though `-target` didn't help here due to dependency chains).

**Status:** Known design issue. The autoscaler manages this file at runtime. The seed value in cloud-init is only useful at first boot. A proper fix would remove `agent_node_count` from the cloud-init template.

---

## 6. `cpx21` server type discontinued in `fsn1`

**Symptom:** `terraform apply` failed with "Server Type cpx21 is unavailable in fsn1 and can no longer be ordered."

**Fix:** Changed `agent_node_server_type` from `cpx21` to `cpx22` in `staging.tfvars`. Updated the default in documentation.

**Files changed:** `staging.tfvars`

---

## 7. SSH host key changes on server recreation

**Symptom:** `ssh` refused to connect after a server was destroyed and recreated by Terraform, showing "REMOTE HOST IDENTIFICATION HAS CHANGED."

**Root cause:** Hetzner may reuse the same IP for a new server. SSH caches the old server's host key in `~/.ssh/known_hosts`.

**Fix:** Run `ssh-keygen -R <ip>` before reconnecting.

---

## 8. `staging.tfvars` is gitignored — not available on the server

**Symptom:** Running `terraform apply -var-file=staging.tfvars` on the server failed with "Given variables file staging.tfvars does not exist."

**Root cause:** `staging.tfvars` contains secrets (Hetzner token, deploy key) and is gitignored. The server gets code via `git clone` but never receives gitignored files.

**Fix:** Run Terraform from your local machine (where `staging.tfvars` exists), not from the server. If server-side Terraform is needed, upload `staging.tfvars` via `scp` first.

---

## 9. Terraform state mismatch between local and server

**Symptom:** Running `terraform apply` on the server showed a plan to create all resources from scratch (network, firewalls, etc.) instead of just the agent node.

**Root cause:** Terraform state is local, stored in `terraform.tfstate.d/staging/` on your Mac. The server has its own empty state. Running Terraform on the server is equivalent to a fresh init against the same config.

**Fix:** Always run Terraform from the machine that owns the state (your local machine). The autoscaler on the server will eventually need its own state — this is a known limitation (see runbook "Known Limitations").

---

## 10. Cloud-init `runcmd` re-runs on reboot, destroying deployed `.env`

**Symptom:** After a server reboot, `https://staging.openaidom.com` was unreachable. All Docker containers were gone, `herobids.service` was `inactive (dead)`, and `/opt/herobids/.env` was missing.

**Root cause:** Cloud-init `runcmd` runs on every boot on Ubuntu 24.04. The `git clone` command would fail (directory already exists), but the `.env` file — uploaded by `deploy.sh` and gitignored — was never restored. Without `.env`, `docker compose up` (via the systemd service) fails silently. The net effect: every reboot kills the staging deployment.

**Fix:** Guard `git clone`, `git config`, and `cp .env.example` with first-boot-only checks (`if [ ! -d /opt/herobids/.git ]` and `if [ ! -f /opt/herobids/${env_file} ]`). On reboot, these steps are skipped, preserving the deployed state. The systemd service then starts the app normally.

**Files changed:** `cloud-init.yaml`

**Bug report:** `docs/bug-reports/2026/08/28/001-cloud-init-reboot-overwrites-env-and-repo.md`

---

## 11. Hard-coded `10.0.*` private IP regex fails in production

**Symptom:** Nomad server and client nodes in production (`10.1.0.0/24`) would fail to resolve their private IP at boot. The `PRIVATE_IP` variable would be empty, leaving the `__PRIVATE_IP__` placeholder unpatched in the Nomad config. Nomad would either refuse to start or advertise the wrong address.

**Root cause:** The original fix for lesson #1 used a hard-coded regex `grep -oP '10\.0\.\d+\.\d+'` to avoid Docker's `172.17.x.x` bridge. This works for staging (`10.0.0.0/24`) but not production (`10.1.0.0/24`) — the `10.0` prefix was a staging-only assumption baked into both cloud-init templates.

**Fix:** Extract the network prefix dynamically from the Terraform `private_subnet` template variable. The `runcmd` step now does:

```bash
SUBNET_PREFIX=$(echo "${private_subnet}" | cut -d'.' -f1-2)
PRIVATE_IP=$(ip -4 addr show | grep -oP "$SUBNET_PREFIX\.\d+\.\d+" | head -1)
```

This produces `10.0` for staging and `10.1` for production, making the regex match the correct Hetzner private network in both environments.

**Files changed:** `cloud-init.yaml`, `cloud-init-nomad-client.yaml`

**Remediation plan:** `docs/features/2026/08/28/001-nomad-production-scale-in-readiness/001-remediation-plan.md` (W3)

---

## 12. New agent nodes may need reboot for Hetzner private network interface

**Symptom:** A freshly provisioned agent node has no `enp7s0` private network interface. The Nomad client can't reach the server at `10.0.0.2:4647` and fails to join the cluster. The `__PRIVATE_IP__` placeholder in the Nomad config is not replaced.

**Root cause:** Hetzner attaches the private network at the hypervisor level, but the guest OS doesn't always auto-configure the interface on first boot. The `netplan` config generated by cloud-init may not include the private interface until after a reboot.

**Fix:** Reboot the agent node. After reboot, the `enp7s0` interface appears with the assigned private IP, cloud-init re-runs the Nomad IP resolution, and the client joins the cluster. Alternatively, wait — the node uses `retry_max = 0` (infinite retries) and will join once the interface appears.

**Impact:** Low. Agent nodes are cattle. The autoscaler only counts `ready` nodes, so an unjoined node doesn't affect scaling decisions. The node eventually joins after reboot or network reconfiguration.

---

## 13. ACL token becomes stale after control-plane server recreation

**Symptom:** After `provision.sh` recreates the control-plane server (e.g., due to `user_data` change), all Nomad API calls return `403 Permission denied`. The ACL token in `.env.backend` and `/etc/herobids/autoscale.env` was bootstrapped on the old server and is not valid on the new one.

**Root cause:** Nomad ACL state is stored in Nomad's data directory on the server. When the server is destroyed and recreated, the data directory is fresh — no ACL bootstrap has occurred. The old token is meaningless.

**Fix:** Re-run `setup-nomad.sh`, which detects the empty `NOMAD_ACL_TOKEN` (or stale token) and bootstraps a new one. If the old token is still in `.env.backend`, clear it first (`NOMAD_ACL_TOKEN=`), then re-run the script. The script saves the new token to `.env.backend` and `.env.staging`/`.env.prod` automatically.

**Prevention:** Use `ignore_changes = [user_data]` on `hcloud_server.default` (now the default) to avoid unnecessary server recreation.

---

## 14. `ssh_public_key_path` with `~` does not resolve on the server

**Symptom:** Autoscale `terraform apply` on the server fails with `no file exists at "~/.ssh/herobids_deploy_key.pub"`. The `file()` function in Terraform cannot resolve `~` outside the operator's local machine.

**Root cause:** The `staging.tfvars` file uses `~/.ssh/herobids_deploy_key.pub` for `ssh_public_key_path`. This works on the operator's machine where `~` expands to the home directory. On the server, `~` resolves to `/root` but the `file()` function doesn't expand `~` — it treats it as a literal path segment.

**Fix:** When uploading `staging.tfvars` to the server (via `setup-autoscale-env.sh`), the `ssh_public_key_path` should use an absolute path (`/root/.ssh/herobids_deploy_key.pub`). The operator must also upload the public key file to the server. Both are now handled by `setup-autoscale-env.sh`.

---

## 15. `set -a` required when sourcing env files in shell scripts

**Symptom:** Running `source /etc/herobids/autoscale.env` in a script, then calling a Terraform or autoscale command, fails with "missing environment variables" even though the file contains the correct values.

**Root cause:** `source` sets variables in the current shell, but does not export them to child processes. Terraform and the autoscale scripts run as child processes and cannot see the sourced variables. The systemd `EnvironmentFile=` directive handles this automatically, but manual shell invocations don't.

**Fix:** Wrap the source with `set -a` / `set +a`:
```bash
set -a
source /etc/herobids/autoscale.env
set +a
```

`set -a` marks all subsequent variable assignments for export. This is already used in `setup-autoscale-env.sh`, `setup-nomad.sh`, and `migrate-backend-to-s3.sh`.
