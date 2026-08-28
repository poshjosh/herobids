# Lessons Learnt — Nomad Staging Provisioning

> **Date:** 2026-08-27
> **Environment:** Staging

Bugs and pitfalls encountered while enabling Nomad orchestration on staging.

---

## 1. Nomad `{{ GetPrivateIP }}` selects Docker bridge, not Hetzner private network

**Symptom:** Nomad server advertised `172.17.0.1` (Docker's `docker0` bridge) instead of `10.0.0.2` (Hetzner private network). Agent nodes connected to port 4647 on the correct IP but were told to communicate with the Docker bridge IP, which they couldn't reach.

**Root cause:** Nomad's Go template `{{ GetPrivateIP }}` returns the first RFC 1918 address it finds. Docker's bridge interface (`docker0` at `172.17.0.1`) was enumerated before the Hetzner private network interface (`enp7s0` at `10.0.0.2`).

**Fix:** Replace `{{ GetPrivateIP }}` with a `__PRIVATE_IP__` placeholder in the cloud-init Nomad config files. At boot time, a `runcmd` step resolves the actual Hetzner private IP via `ip -4 addr show | grep -oP '10\.0\.\d+\.\d+'` and patches the config with `sed` before starting Nomad.

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
