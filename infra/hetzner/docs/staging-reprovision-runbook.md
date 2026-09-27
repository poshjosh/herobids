# Staging Teardown → Re-provision → Setup Runbook

**Status:** operator runbook
**Date:** 2026-09-27
**Replaces (supersedes the unordered flow in):** `infra/hetzner/docs/setup.md`
**Scope:** a clean, ordered sequence to (optionally) destroy staging and bring it
back to a fully working state — Nomad cluster, worker, admin user, agents, smoke
test — without hand-patching anything.

The order below matters. Steps marked **[skip-if]** are conditional; read the
note on each before deciding to run it.

---

## 0. Preconditions (before anything)

- Working directory: `infra/hetzner` (all paths below are relative to it).
- Tools installed: `terraform`, `jq`, `docker`, `python3`, `dig`, `pnpm`, `aws` cli optional.
- Required files present and correct:
  - `.env.backend` — S3 backend creds (`TF_BACKEND_BUCKET`, `AWS_*`, optional `TF_BACKEND_DYNAMODB_TABLE`) + `NOMAD_ACL_TOKEN`.
  - `.env.<env>` — app secrets + `NOMAD_TOKEN` + `GHCR_USERNAME`/`GHCR_TOKEN`.
  - `<env>.tfvars` — Hetzner token, deploy key, `ghcr_username`/`ghcr_token`, `agent_node_count >= 1`.
- Traderton boundary is up: `curl https://api.staging.traderton.com/health/ready` → 200.

> All scripts below share the `--env <staging|production>` and IP conventions
> from `scripts/_ssh_opts.sh`. Replace `<env>` with `staging` and `<ip>` with the
> control-plane public IP (e.g. `138.199.172.202`) as you go.

---

## 1. Teardown (DESTRUCTIVE) — **[skip-if: server not yet provisioned / no teardown wanted]**

Only run if you actually want to tear everything down first. If the server
already exists and is healthy, start at step 3.

```sh
infra/hetzner/scripts/destroy.sh --env staging \
  --var-file infra/hetzner/staging.tfvars \
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
sed -i '' 's|^NOMAD_TOKEN=.*|NOMAD_TOKEN=|' infra/hetzner/.env.staging
```

---

## 3. Provision the servers — **[always]**

```sh
infra/hetzner/scripts/provision.sh --env staging \
  --var-file infra/hetzner/staging.tfvars \
  --backend-env-file infra/hetzner/.env.backend
```

This creates the control plane + `agent_node_count` agent node(s) from
`staging.tfvars`. `agent_node_count` must be `>= 1` or agent jobs will have
nowhere to land (the autoscaler may otherwise drain to zero).

---

## 4. Verify the private NIC came up — **[always; may self-heal on reboot]**

The Hetzner private NIC (`enp7s0`) can be `DOWN` on first boot, leaving
`__PRIVATE_IP__` unsubstituted. A per-boot `nomad-private-ip.service` (added to
cloud-init) substitutes it on every boot, but only once the NIC actually has an
IP.

```sh
ssh root@<ip> 'ip -4 addr show enp7s0'
```

- If `enp7s0` has a private IP (`10.0.0.x/32`) **and** `nomad.hcl` advertise shows
  a real IP (not `__PRIVATE_IP__`): proceed to step 5.
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
infra/hetzner/deploy.sh --env staging <ip> --env-file infra/hetzner/.env.staging
```

Steps: upload `.env` → upload autoscale env + Nomad ACL token + tfvars → `git
reset --hard origin/main` + rebuild images + `docker compose up` → seed admin
(skipped if `ADMIN_EMAIL`/`ADMIN_PASSWORD` unset) → health check.

> Known benign race: the `networks.default.ipam` pin can occasionally make
> `docker compose up` log `removal of container ... already in progress` at the
> very end. Re-run `deploy.sh` once — it is idempotent.

---

## 6. Nomad ACL bootstrap + namespace — **[always on a fresh cluster; skip only if already bootstrapped]**

This bootstraps the ACL token, writes it to `.env.backend`/`.env.<env>`, and
creates the `herobids-agents` namespace.

```sh
infra/hetzner/scripts/setup-nomad.sh --env staging \
  --env-file infra/hetzner/.env.staging \
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

---

## 7. Seed admin user — **[skip-if: using reset-and-run.sh in step 8 (it seeds admin)]**

```sh
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='<strong-password>' \
  infra/hetzner/scripts/seed-admin.sh --env staging <ip>
```

Idempotent (creates or promotes the user). `reset-and-run.sh` in step 8 already
runs this via `reset.sh --seed`, so run step 7 standalone only when you are
**not** doing the full reset (e.g. the DB already has users and you only need to
promote one).

---

## 8. Reset + provision user/credentials/connections/skills + agents — **[skip-if: already done]**

`reset-and-run.sh` is the self-contained bootstrap. It chains, in order:
reset (wipes DB+Redis, seeds admin) → `quick-setup-remote.sh` (user, credentials,
venue connections, skills) → `create-agents.sh` (creates **thyper, t1inch, tintel,
security-auditor**).

```sh
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='<strong-password>' \
  infra/hetzner/scripts/reset-and-run.sh --env staging <ip> --env-file .env.ops.staging
```

> `reset-and-run.sh` is DESTRUCTIVE (wipes DB + Redis). If the server is already
> provisioned and you only need to re-create the user/credentials *without* wiping,
> run `quick-setup-remote.sh` (and `create-agents.sh` if agents were deleted)
> directly instead of `reset-and-run.sh`.
>
> `create-agents.sh` creates `thyper`, `t1inch`, `tintel`, `security-auditor` in
> `stopped` state — they are started in step 9, not here.

---

## 9. Start agents and confirm they actually run — **[always]**

Start each agent (via UI, Telegram `/start`, or the API):

```sh
# API (requires an auth token from step 7/8 login):
curl -s -X POST -H 'Authorization: Bearer <token>' \
  'https://staging.openaidom.com/api/agents/<agent-id>/start'
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
infra/hetzner/scripts/smoke-test.sh --env staging <ip>
```

Expect `Passed: 13, Failed: 0, Skipped: 3` (browser/OAuth/Telegram skipped).

Also verify the Traderton boundary integration (from the smoke test's
"verifications" block in `deploy.md`):

```sh
# a. agent image on GHCR
docker manifest inspect ghcr.io/poshjosh/herobids-agent:latest

# b. agent node can pull it (private IP = 10.0.0.3 = agent-1)
ssh root@<ip> 'ssh -i /root/.ssh/deploy_key root@10.0.0.3 "docker pull ghcr.io/poshjosh/herobids-agent:latest"'
```

---

## Quick reference — the happy path (fresh teardown)

```sh
cd infra/hetzner
./scripts/destroy.sh --env staging --var-file staging.tfvars --backend-env-file .env.backend      # 1
sed -i '' 's|^NOMAD_ACL_TOKEN=.*|NOMAD_ACL_TOKEN=|' .env.backend                                     # 2
sed -i '' 's|^NOMAD_TOKEN=.*|NOMAD_TOKEN=|' .env.staging                                              # 2
./scripts/provision.sh --env staging --var-file staging.tfvars --backend-env-file .env.backend      # 3
# 4: verify enp7s0 / nomad.hcl (reboot if needed)
./deploy.sh --env staging <ip> --env-file .env.staging                                               # 5
./scripts/setup-nomad.sh --env staging --env-file .env.staging --backend-env-file .env.backend       # 6
ADMIN_EMAIL=... ADMIN_PASSWORD=... ./scripts/seed-admin.sh --env staging <ip>                        # 7
ADMIN_EMAIL=... ADMIN_PASSWORD=... ./scripts/reset-and-run.sh --env staging <ip> --env-file .env.ops.staging  # 8 (also creates agents)
# 9: start agents (API/UI/Telegram), confirm running
./scripts/smoke-test.sh --env staging <ip>                                                            # 10
```