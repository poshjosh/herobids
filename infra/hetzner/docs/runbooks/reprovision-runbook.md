# Teardown → Re-provision → Setup Runbook

**Status:** operator runbook
**Date:** 2026-10-07 (generalized from the staging-only version dated 2026-09-27)
**Replaces (supersedes the unordered flow in):** `infra/hetzner/docs/setup.md`
**Scope:** a clean, ordered sequence to (optionally) destroy an environment and
bring it back to a fully working state — Nomad cluster, worker, admin user,
agents, smoke test — without hand-patching anything. Applies to **both**
`staging` and `production`; substitute `<env>` with the one you're operating
on. See `production-notes.md` for the handful of places production actually
behaves differently (not just different values).

The order below matters. Steps marked **[skip-if]** are conditional; read the
note on each before deciding to run it. Steps marked **[Nomad-only]** only
apply when `enable_nomad = true` for this environment (the default — see
`<env>.tfvars`); skip them entirely for a plain Docker Compose deployment with
Nomad disabled.

---

## 0. Preconditions (before anything)

- Working directory: `infra/hetzner` (all paths below are relative to it).
- Tools installed: `terraform`, `jq`, `docker`, `python3`, `dig`, `pnpm`, `aws` cli optional.
- Required files present and correct:
  - `.env.backend` — S3 backend creds (`TF_BACKEND_BUCKET`, `AWS_*`, optional `TF_BACKEND_DYNAMODB_TABLE`) + `NOMAD_ACL_TOKEN`.
  - `.env.<env>` — app secrets + `NOMAD_TOKEN` + `GHCR_USERNAME`/`GHCR_TOKEN`.
  - `<env>.tfvars` — Hetzner token, deploy key, `ghcr_username`/`ghcr_token`, `agent_node_count >= 1`.
- Traderton boundary for `<env>` is up: `curl https://api.<env-prefix>traderton.com/health/ready` → 200
  (staging: `https://api.staging.traderton.com/health/ready`; production:
  `https://api.traderton.com/health/ready` — **do not assume this exists**; see
  `production-notes.md` § Traderton production dependency before relying on it).

> All scripts below accept `--env <staging|production>`, which also selects the
> correct SSH deploy key automatically via `scripts/_ssh_opts.sh` (resolved from
> `<env>.tfvars`'s `ssh_public_key_path`). You should not need to pass `-i
> <key>` by hand — if a script's auto-detected key seems wrong, see
> `production-notes.md` before overriding it with `HEROBIDS_SSH_KEY`.
>
> Replace `<ip>` with the control-plane public IP as you go (get it with
> `terraform_output -raw server_ipv4` after step 3, or `terraform output -raw
> server_ipv4` from `infra/hetzner` directly).

---

## 1. Teardown (DESTRUCTIVE) — **[skip-if: server not yet provisioned / no teardown wanted]**

Only run if you actually want to tear everything down first. If the server
already exists and is healthy, start at step 3.

```sh
infra/hetzner/scripts/destroy.sh --env <env> \
  --var-file infra/hetzner/<env>.tfvars \
  --backend-env-file infra/hetzner/.env.backend
```

- Prompts for confirmation (two interactive prompts unless `--yes`).
- Deletes servers, agent nodes, private network, firewall, SSH key.
- Does **not** delete DNS records or the S3 state bucket.

**After teardown, run step 2. If you skipped teardown, skip step 2.**

---

## 2. Clear the Nomad token — **[skip-if: fresh .env files / first-time setup]**

The ACL token in `.env.backend` / `.env.<env>` is meaningless once the cluster it
was minted for is destroyed. Leaving it set makes `setup-nomad.sh` (step 6) skip
re-bootstrap and redeploy a dead token.

```sh
sed -i '' 's|^NOMAD_ACL_TOKEN=.*|NOMAD_ACL_TOKEN=|' infra/hetzner/.env.backend
sed -i '' 's|^NOMAD_TOKEN=.*|NOMAD_TOKEN=|' infra/hetzner/.env.<env>
```

---

## 3. Provision the servers — **[always]**

```sh
infra/hetzner/scripts/provision.sh --env <env> \
  --var-file infra/hetzner/<env>.tfvars \
  --backend-env-file infra/hetzner/.env.backend
```

This creates the control plane + `agent_node_count` agent node(s) from
`<env>.tfvars`. `agent_node_count` must be `>= 1` or agent jobs will have
nowhere to land (the autoscaler may otherwise drain to zero — see
`production-notes.md`, production never allows this).

---

## 4. Verify the private NIC came up — **[Nomad-only; may self-heal on reboot]**

The Hetzner private NIC (`enp7s0`) can be `DOWN` on first boot, leaving
`__PRIVATE_IP__` unsubstituted. A per-boot `nomad-private-ip.service` (added to
cloud-init) substitutes it on every boot, but only once the NIC actually has an
IP.

```sh
ssh root@<ip> 'ip -4 addr show enp7s0'
```

- If `enp7s0` has a private IP (the subnet's `<control-plane-private-ip>/32`,
  read it from `terraform output -raw control_plane_private_ip`)
  **and** `nomad.hcl` advertise shows a real IP (not `__PRIVATE_IP__`): proceed to step 5.
- If `enp7s0` is `DOWN`/no IP: **reboot the node** and re-check:

  ```sh
  ssh root@<ip> 'systemctl reboot'
  ```

  After it returns, `nomad-private-ip.service` runs on boot and substitutes the
  IP. Confirm `/etc/nomad.d/nomad.hcl` no longer shows `__PRIVATE_IP__`.

  > If the placeholder persists (unit didn't run), the manual one-liner remains:
  > `ssh root@<ip> 'sed -i "s/__PRIVATE_IP__/<private_ip>/g" /etc/nomad.d/nomad.hcl && systemctl restart nomad'`

---

## 5. Deploy services (upload env + build + start) — **[always]**

```sh
infra/hetzner/deploy.sh --env <env> <ip> --env-file infra/hetzner/.env.<env>
```

Steps: upload `.env` → upload autoscale env + Nomad ACL token + tfvars → `git
reset --hard origin/main` + rebuild images + `docker compose up` → seed admin
(skipped if `ADMIN_EMAIL`/`ADMIN_PASSWORD` unset) → health check.

> Known benign race: the `networks.default.ipam` pin can occasionally make
> `docker compose up` log `removal of container ... already in progress` at the
> very end. Re-run `deploy.sh` once — it is idempotent.

---

## 6. Nomad ACL bootstrap + namespace — **[Nomad-only; always on a fresh cluster; skip only if already bootstrapped]**

This bootstraps the ACL token, writes it to `.env.backend`/`.env.<env>`, and
creates the `herobids-agents` namespace.

```sh
infra/hetzner/scripts/setup-nomad.sh --env <env> \
  --env-file infra/hetzner/.env.<env> \
  --backend-env-file infra/hetzner/.env.backend
```

> Idempotent: if `.env.backend` already has a **valid** `NOMAD_ACL_TOKEN`, it
> skips bootstrap (which is why step 2 clears it after teardown). On a fresh
> cluster the token is empty so it bootstraps + creates the namespace.

Verify:

```sh
ssh root@<ip> 'NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token) nomad server members'
ssh root@<ip> 'NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token) nomad node status'
```

Expected: one `alive`/`true` leader + at least one `ready` agent node.

Test alert delivery (if SMTP configured):

```sh
ssh root@<ip> '/opt/herobids/infra/hetzner/scripts/send-alert.sh --test'
```

Check your inbox for the test alert email.

---

## 6a. Verify worker → Nomad reachability — **[Nomad-only; the firewall trap]**

The worker/API containers live on the **local Docker bridge**, not the Hetzner
private network, so their Nomad traffic is subject to UFW's routed-default-deny.
If it is blocked, agents fail with `Critical execution failure` (worker logs
`runtime.launch_failed: This operation was aborted`) even though Nomad itself is
healthy. Confirm from inside the worker container:

```sh
ssh root@<ip> 'docker exec herobids-worker-1 \
  sh -c "wget -qO- --timeout=5 http://<control-plane-private-ip>:4646/v1/status/leader"'
```

Expected: the leader addr (the Nomad server's `<private-ip>:4647`), **not**
`download timed out`. The bridge→Nomad allow rules are
pinned in `cloud-init.yaml` (ports 4646/4647/4648 from `172.18.0.0/16`) and the
bridge subnet is pinned in `docker-compose.yaml` (`networks.default.ipam`). If
this check fails, re-apply:

```sh
ssh root@<ip> 'ufw allow from 172.18.0.0/16 to any port 4646 proto tcp && \
  ufw allow from 172.18.0.0/16 to any port 4647 proto tcp && \
  ufw allow from 172.18.0.0/16 to any port 4648 proto tcp'
```

> **Private-IP drift caveat:** `.env.<env>` hardcodes `NOMAD_ADDR` and
> `SHARED_REDIS_HOST`/`SHARED_POSTGRES_HOST` to a fixed private IP, while
> `cloud-init.yaml` resolves the real private IP dynamically at boot. If a
> re-provision ever lands a different private IP, the hardcoded values break
> silently. After any re-provision, confirm the values in `.env.<env>` still
> match the actual control-plane private IP (`ip -4 addr show enp7s0`). See
> `production-notes.md` § 1.

---

## 7. Seed admin user — **[skip-if: using reset-and-run.sh in step 8 (it seeds admin)]**

```sh
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='<strong-password>' \
  infra/hetzner/scripts/seed-admin.sh --env <env> <ip>
```

Idempotent (creates or promotes the user). `reset-and-run.sh` in step 8 already
runs this via `reset.sh --seed`, so run step 7 standalone only when you are
**not** doing the full reset (e.g. the DB already has users and you only need to
promote one).

---

## 8. Reset + provision user/credentials/connections/skills + agents — **[skip-if: already done]**

`reset-and-run.sh` is the self-contained bootstrap. It chains, in order:
reset (wipes DB+Redis, seeds admin) → `quick-setup-remote.sh` (user, credentials,
venue connections, skills) → `create-agents.sh`.

```sh
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='<strong-password>' \
  infra/hetzner/scripts/reset-and-run.sh --env <env> <ip> --env-file .env.ops.<env>
```

> `reset-and-run.sh` is DESTRUCTIVE (wipes DB + Redis) and has **two**
> interactive confirmation prompts (`y`, then the literal phrase `I agree to
> delete active deployment`) — see `production-notes.md` for why that second
> prompt matters more on production than it sounds. If the server is already
> provisioned and you only need to re-create the user/credentials *without*
> wiping, run `quick-setup-remote.sh` (and `create-agents.sh` if agents were
> deleted) directly instead of `reset-and-run.sh`.
>
> If step 2 (venue connection provisioning inside `reset-and-run.sh`) fails
> with a `transport_error`/`503` while linking a provider, this usually means
> the Traderton boundary for `<env>` is unreachable — confirm with `curl
> https://api.<env-prefix>traderton.com/health/ready` before assuming
> herobids itself is broken. The reset/migrate/seed-admin portion can succeed
> even when this later step fails; check `docker ps` and `/health` on the
> server directly rather than only trusting the script's own exit status.

---

## 9. Start agents and confirm they actually run — **[always]**

Start each agent (via UI, Telegram `/start`, or the API):

```sh
# API (requires an auth token from step 7/8 login):
curl -s -X POST -H 'Authorization: Bearer <token>' \
  'https://<domain>/api/agents/<agent-id>/start'
```

Confirm the worker launched them and they heartbeat (no `Stale agent start`):

```sh
ssh root@<ip> 'docker logs herobids-worker-1 --since 2m | grep -iE "running|stale|critical|registered"'
ssh root@<ip> 'NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token) nomad job status -namespace=herobids-agents'
```

Expected: `runningCount: 2` (or `N` agents), jobs `running`, no `Stale agent
start detected`.

---

## 10. Smoke test — **[always]**

```sh
infra/hetzner/scripts/smoke-test.sh --env <env> <ip>
```

(The `<ip>` may be optional — `smoke-test.sh` auto-detects it via `terraform output` when omitted.)

Expect `Passed: 13, Failed: 0, Skipped: 3` on staging (browser/OAuth/Telegram
skipped). Production skips the staging-hooks check instead — see
`production-notes.md`.

Also verify the Traderton boundary integration (from the smoke test's
"verifications" block in `deploy.md`):

```sh
# a. agent image on GHCR
docker manifest inspect ghcr.io/poshjosh/herobids-agent:latest

# b. agent node can pull it (<agent-private-ip> from `terraform output -raw agent_node_private_ips`)
ssh root@<ip> 'ssh -i /root/.ssh/deploy_key root@<agent-private-ip> "docker pull ghcr.io/poshjosh/herobids-agent:latest"'
```

**[Nomad-only]** Agent jobs run on Nomad client nodes (not the control plane)
and pull `ghcr.io/poshjosh/herobids-agent:latest`. If the image isn't
published yet (the `.github/workflows/build-push-agent.yml` CI run hasn't
pushed it) or the client node can't authenticate, every agent launch fails
with `Stale agent start detected` (health monitor) → "Critical execution
failure" — even though the Nomad job registers and places successfully. If
step (b) above fails with `denied`, the client node hasn't logged into
ghcr.io — set `ghcr_username`/`ghcr_token` in `<env>.tfvars` and re-provision
that node (cloud-init runs `docker login ghcr.io` on boot). If it fails with
`not found`, the CI workflow hasn't pushed the image yet.
