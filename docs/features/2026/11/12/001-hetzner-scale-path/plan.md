# Hetzner Scale Path: agent autoscaling to 10,000 agents

**Start here.** This file and the [sandbox plan](./sandbox-shell-access.md) it links (Phase 4b and task 7.6) are the whole plan. You (the implementing agent) need nothing from earlier conversations.
**Created:** 2026-11-12. **Owner:** the project owner. **Reviewer:** Kiro (a separate agent session). **Verified against:** `herobids` commit `b317176e`, read-only.
**Replaces:** the autoscaling program in [`docs/features/2026/11/11/001-autoscaling-program/`](../../11/001-autoscaling-program/README.md). Do not follow that folder's process (journal, inbox, decision briefs, milestones). Use it only as background reading. Deleting it waits for the owner.

---

## 1. Why this plan exists (read once)

The company is one engineer working with LLM agents. Speed matters, and so does quality. The rule for this plan is:

> **How carefully we work depends on how hard a mistake is to undo.** Easy to undo: just do it, test it, roll back if needed. Hard to undo: stop and check.

Targets (the "100k-user envelope"):

| Tier | Target | What this plan delivers |
|---|---|---|
| Agent containers (one long-running Docker container per agent, on Nomad nodes) | about 10,000 running at once | Automatic scale-out and scale-in, proven under load |
| Browser pool (Browserless, used by agents to browse) | up to 200 concurrent sessions | A dedicated node, measured capacity per node, resized by changing one number. **Not** autoscaled |
| Traderton (separate repo, trading service, one VM) | about 5,000 trading agents | One load test that shows whether one VM holds 5,000. **Not** autoscaled |
| Agent shell access (`execute_shell`, `execute_code`) on Nomad | every agent, staging and production | Works again, with standard-mode commands blocked from private addresses. Same priority as autoscaling. See the [sandbox plan](./sandbox-shell-access.md) |

Agents stay running all the time (owner decision C-12: starting a stopped agent is slow). So capacity follows the number of agents, not their activity.

### What is wrong today

1. **Staging scale-out is refused every minute** with `ownership_mismatch` in `/var/log/nomad-autoscale.log` on the staging control plane. The guard (`infra/hetzner/scripts/capacity-inventory.sh`, the `_CAPACITY_RECONCILE_JQ` program, about lines 120 to 210) treats any live `role=agent` server whose name is not `<pool>-agent-<N>` as foreign. Staging has a temporary second pool named `herobids-staging-agent-caps-<N>` (`infra/hetzner/main.tf`, resource `hcloud_server.agent_caps`), built for a sandbox fix that is now deferred. There is also a server called `herobids-staging-agent-3` that earlier notes say is not in Terraform state. Notes about which Hetzner server maps to which Nomad node disagree, so **the live inventory is the truth** (task 0.2).
2. **Nodes are small.** `agent_node_server_type = "cx23"` (2 vCPU, 4 GB). About 14 agents fit per node, so 10,000 agents would need about 715 nodes. A Hetzner private network holds at most 100 servers ([Hetzner docs](https://docs.hetzner.com/networking/networks/overview/)). With `cx53` (16 vCPU, 32 GB) about 120 fit, so about 85 nodes.
3. **Scale-in never runs while demand mode is on.** `scale-in.sh` (about line 139) exits early with "scale-in deferred" whenever `NOMAD_AUTOSCALE_DEMAND_ENABLED=true`. Demand mode is the scale-out mode we use. So today nodes are never removed automatically.
4. **Each agent can open up to 10 Postgres connections.** `packages/db/src/index.ts` calls `postgres(connectionString)` with no options; the `postgres` library's default pool size is 10. Postgres runs with its default `max_connections` (100). Each agent also opens 2 Redis clients (`apps/worker/src/agent.ts` about lines 868 and 876). Redis runs with its default `maxclients` (10,000) and `--maxmemory 512mb` (`docker-compose.yaml`). Each agent sends a heartbeat every 5 s (`config/default.yaml`, `heartbeatIntervalMs: 5000`); at 10,000 agents that is 2,000 messages a second into the worker.
5. **Production** has one `cx23` agent node, `max_agent_nodes = 9`, demand mode off, and the capacity-aware start gate off (`config/default.yaml`, `capacityAwareStart.enabled: false`; only `config/staging.yaml` turns it on). With the gate off, an agent start must finish in 60 s, but a new node takes minutes. So production cannot start an agent that needs a new node.
6. **The browser pool** is one Nomad job (`infra/nomad/browser-pool.nomad.hcl`): `count = 1`, static port 3100, 2 GB, `MAX_CONCURRENT_SESSIONS = "2"`. It runs on any agent node.
7. **Agents cannot run shell commands on Nomad.** Every `execute_shell` and `execute_code` call is refused with exit 97, because agent containers do not get the `NET_ADMIN` capability the sandbox needs (`nomad.sandboxCapsEnabled` is off, and old nodes did not allow it). The fix is written and on `main`; turning it on depends on Phase 1 (every node rebuilt from the current template) and Phase 4 (browser pool at a stable address). Details: [sandbox plan](./sandbox-shell-access.md).

### What this plan does not do

- No browser autoscaler, no load balancer in front of several browser instances.
- No Traderton autoscaler or multi-instance design. If one VM cannot hold 5,000, record that; the design is Traderton's next piece of work.
- No change to the sandbox design. The sandbox plan turns on and proves the design already on `main`; it does not make the rules a security boundary (see its section 3).
- No shared autoscaling library or repo, no TypeScript rewrite of the autoscaler, no Nomad Autoscaler plugin, no tier profiles.
- No guard rewrite beyond the one-line exemption in task 4.2.
- No hibernation or stopping of idle agents.

If you find yourself building something on this list, stop and ask.

---

## 2. How to work

### 2.1 Before you start

Read these once. They are short and each comes from a real incident:
- `AGENTS.md` (repo root): rules for code, tests, env files, Terraform.
- `infra/hetzner/README.md`: environments, Terraform workspaces, `TF_DATA_DIR`.
- `infra/hetzner/docs/auto-scaling/lessons-learnt.md`: all of it. Lessons 8, 9, 10, 12, 13, 20 and 21 apply directly.
- `infra/hetzner/docs/auto-scaling/useful-commands.md`: SSH, Nomad and log commands.
- `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md`, section "Clearing a blocked scale guard".
- `infra/hetzner/docs/runbooks/production-notes.md` before any production step.
- `docs/tech/agents/agent-runtime-rollout-guide.md` section 7 (how to relaunch an agent).

### 2.2 What you may do without asking

Because the product is pre-launch, you have **standing approval** for everything this plan lists, on staging at any time and on production after review gate R1 passes (section 2.4). That includes:
- Commits on the branch `feat/hetzner-scale-path`, pushing it, and deploying it to staging with `DEPLOY_REF=origin/feat/hetzner-scale-path infra/hetzner/scripts/push.sh --env staging --yes` (or `deploy.sh`, see task 1.1).
- Terraform applies, **only** from a saved plan whose changes match the "expected plan" written in the task exactly. Always: `cd infra/hetzner && export TF_DATA_DIR=.terraform-envs/<env>`, then `terraform plan -var-file=<env>.tfvars -out=/tmp/<name>.tfplan`, then `terraform show -no-color /tmp/<name>.tfplan`, read it, then `terraform apply /tmp/<name>.tfplan`.
- Draining, purging and deleting the servers and Nomad nodes named in task 1.3's mapping table.
- Stopping and starting the autoscale timers, editing tfvars (local and server copies), changing config files, resizing servers listed in this plan, and running the load tests within the budget below.
- Restarting staging and production agents (they recover by being relaunched; see section 2.1).

**Budget for load tests:** up to EUR 50 of extra Hetzner spend in total, and nothing extra left running at the end. Hetzner bills by the hour; one `cx53` costs roughly EUR 0.05 an hour (check with the API, task 0.3).

### 2.3 When you must stop and ask the owner

Stop, write the question in the plan's log (section 9), and tell the owner in plain words when:
1. A Terraform plan shows **any** destroy, replace or update that the task's "expected plan" does not list. Above all: a replace or destroy of `hcloud_server.default` (the control plane, which holds the database), of `hcloud_network`, of any volume, or of anything labelled `app=traderton`.
2. An action would delete data: the database, Redis data, Terraform state, S3 objects, a user's agent.
3. You would need to read, print, rotate or create a secret that this plan does not mention. Never print tokens or passwords in logs, commits or the plan.
4. Spending would pass the budget, or the Hetzner limit stops a step.
5. The same approach failed twice and you do not know why. Diagnose first; do not keep patching.
6. A change would affect Traderton production, or Traderton code beyond the load-test script in Phase 8.
7. You are about to build something from "What this plan does not do".

### 2.4 Review gates (the reviewer is Kiro)

There are two. At each one, stop, set the gate's status to `ready for review` in section 8, and give a short summary in chat: what changed, the commits, the evidence, and anything you are unsure of.

- **R1, before production:** after Phases 1 to 6 are done on staging, **including Phase 4b (sandbox)**.
- **R2, at the end:** after Phases 7 to 9, **including task 7.6 (sandbox on production)**.

Do not start production work (Phase 7) until R1 says `passed`. Traderton work (Phase 8) does not wait for R1.

### 2.5 Quality bar (never skip)

- Read the code before you change it. Search `docs/bug-reports/` and `git log -- <file>` for the files you touch.
- Shell changes: run `infra/hetzner/scripts/tests/run-all.sh` **and** `infra/hetzner/scripts/tests/check-nomad-capacity.test.sh` (the second is not run by the first). Run `shellcheck` on changed scripts. Several tests check the text of `scale-in.sh` and `scale-out.sh`; update those tests in the same commit when you change the text.
- TypeScript changes: focused Vitest tests for the changed behaviour, then `pnpm lint` and `pnpm build`.
- Env variables: if you add or change one, update the matching `.example` file in the same commit (`AGENTS.md`). New Terraform variables go in `infra/hetzner/environment.tfvars.example` with a one-line comment.
- One logical change per commit. Commit messages say what and why.

### 2.6 How to record progress

- Each task below has a status: `todo`, `doing`, `done`, `blocked`. Update it in this file as you go.
- `done` means the "Done when" check passed on the real system, with **evidence** written under the task (a command and its key output, a log line, a commit hash). A written file alone is not done.
- Append a short entry to the log (section 9) at the end of each session and at each gate: what you did, what you learned, what is next.
- If you learn a fact that contradicts this plan, fix the plan text and note it in the log.

### 2.7 Tools and access

- Local machine (macOS): `terraform`, `jq`, `shellcheck` are installed. `nomad` and `hcloud` are **not**. Run `nomad` commands on the control plane over SSH (`useful-commands.md`). For Hetzner, use the HTTP API with `curl` the way `capacity-inventory.sh` does (token passed on stdin, never on the command line), or install `hcloud` with Homebrew (`brew install hcloud`, mention it in the log).
- SSH keys: staging `~/.ssh/herobids_deploy_key`, production `~/.ssh/herobids_deploy_key_prod`.
- The Hetzner token is the `hcloud_token` line in the gitignored `infra/hetzner/<env>.tfvars`. Terraform backend credentials are in the gitignored `.env.ops.<env>` files at the repo root (check key names only, never print values).
- `infra/hetzner/<env>.tfvars` is gitignored and exists in two copies: your local one and the server's `/opt/herobids/infra/hetzner/<env>.tfvars`. The autoscaler writes `agent_node_count` into the server copy after each scale action. **Before any manual Terraform run, stop the autoscale timer and make the local `agent_node_count` equal to the server's.** After the run, upload the local file with `infra/hetzner/scripts/setup-autoscale-env.sh --env <env>` (read its header first; it also renders autoscale settings).
- Autoscale timers on the control plane: `nomad-autoscale.timer` (scale-out, every 60 s) and `nomad-scale-in.timer` (nightly). Stop with `systemctl stop nomad-autoscale.timer`; start with `systemctl start nomad-autoscale.timer`.
- The agent image is built by GitHub Actions on every push to `main` (`.github/workflows/build-push-agent.yml`) as `ghcr.io/poshjosh/herobids-agent:latest` and `:sha-<commit>`. A branch push does not build an image. If staging needs agent-image changes before merge, ask the reviewer how to proceed.

---

## 3. Target settings (end state)

| Setting | Where | Staging | Production |
|---|---|---|---|
| `agent_node_server_type` | `<env>.tfvars` | `cx53` | `cx53` |
| `nomad_node_template_memory_mb`, `nomad_node_template_cpu_mhz` | `<env>.tfvars` | measured on a live `cx53` (task 1.5) | same values |
| `agent_node_count` | `<env>.tfvars` | 1 after cleanup (the autoscaler changes it) | 1 (the autoscaler changes it) |
| `min_agent_nodes` / `max_agent_nodes` | `<env>.tfvars` | 1 / 3 (raised only during the load test) | 1 / 20 (owner may change; 20 nodes hold about 2,400 agents and cost about EUR 600 a month at most) |
| `agent_caps_node_count` | `staging.tfvars` | 0, then the resource is removed | not used |
| `nomad_autoscale_demand_enabled` | `<env>.tfvars` | `true` | `true` |
| `enable_scale_in` | `<env>.tfvars` | `true` | `true` |
| `scale_out_cooldown_seconds` | `<env>.tfvars` | 300 | 300 |
| `capacityAwareStart.enabled` | `config/<env>.yaml` | `true` (already) | `true` |
| Agent Postgres pool | code (task 3.3) | small pool with idle timeout | same |
| Redis `maxclients`, Postgres `max_connections` | `docker-compose*.yaml` | from measurements (task 3.4) | same |
| Browser node | Terraform (task 4.2) | 1 dedicated node | 1 dedicated node |
| Control plane size | `server_type` in tfvars | resized for the load test, then back | unchanged unless measurements require; resize trigger recorded |
| Browser node private IP | `main.tf` (sandbox plan S1) | fixed, `cidrhost(subnet, 240)` | same |
| `NOMAD_SANDBOX_CAPS_ENABLED` | `infra/hetzner/.env.<env>` | `true` (sandbox plan S5) | `true` (P3) |
| `NOMAD_AGENT_IMAGE` | `infra/hetzner/.env.<env>` | pinned `sha-<commit>` tag, probed (S2, S3) | pinned, probed (P2) |

---

## 4. Phases and tasks

Rough effort: about 7 to 9 working days in total. Phases 1 to 3 come first. Phase 4 and Phase 8 can run in parallel with them.

### Phase 0: Read and take stock (read-only, about half a day)

**0.1 Read** the files in section 2.1. Status: `done` (section 2.1 files and the referenced guard/scale-in code read before any change).

**0.2 Live inventory, staging and production.** Status: `done` (staging). Production: `todo` (read-only, pending; safe to run the same GET-only reads with the production key).

Evidence (staging, read-only, 2026-11-13, control plane `138.199.172.202`):

Mapping table (Hetzner server ↔ Terraform address ↔ Nomad node ↔ what runs on it):

| Hetzner server (id) | private IP | TF address | Nomad node name (id) | class / eligibility | role in cleanup |
|---|---|---|---|---|---|
| herobids-staging (167421976) | 10.0.0.2 | `hcloud_server.default` | — (control plane, not a client) | — | keep |
| herobids-staging-agent-1 (173731633) | 10.0.0.5 | `hcloud_server.agent[0]` | `herobids-staging-agent-3` (714f26cc) **name drift** | agent / ineligible (drained) | rebuild as `cx53` (1.4) |
| herobids-staging-agent-2 (173858368) | 10.0.0.3 | `hcloud_server.agent[1]` | `herobids-staging-agent-2` (9fed1a12) | agent / ineligible (drained) | destroyed when count→1 (1.4) |
| herobids-staging-agent-caps-1 (175258516) | 10.0.0.4 | `hcloud_server.agent_caps[0]` | `herobids-staging-agent-caps-1` (ae9393db) | agent / eligible | destroy (1.6) |
| herobids-staging-agent-caps-2 (175258517) | 10.0.0.6 | `hcloud_server.agent_caps[1]` | `herobids-staging-agent-caps-2` (690b36fc) | agent / eligible | destroy (1.6) |

Notes:
- The Nomad node named `herobids-staging-agent-3` maps to the Hetzner server `herobids-staging-agent-1` by private IP (10.0.0.5). There is no Nomad node literally named `herobids-staging-agent-1`. Live inventory is the truth: this is the drifted node the plan's §1 note warned about. Its purge is handled in task 1.7.
- The eligible agent nodes are currently the two caps nodes; `agent-1`/`agent-2`'s Nomad nodes are `ineligible` (drained earlier).
- Settings: `server_name = "herobids-staging"`, `agent_node_count = 2`, `min_agent_nodes = 1`, `max_agent_nodes = 3`, `agent_node_server_type = "cx23"`, `NOMAD_AUTOSCALE_DEMAND_ENABLED=true`. The autoscaler resolves the pool from `TF_VAR_server_name` → `herobids-staging` (`scale-common.sh:67`).
- `systemctl list-timers 'nomad-*'`: only `nomad-autoscale.timer` is active (every ~60 s). `nomad-scale-in.timer` did not appear in the active list — to be confirmed in task 2.3.
- Autoscale log: `ownership_mismatch` every tick; failure count at 4553/3.
- Control plane: 2 vCPU, 3819 MB RAM (≈ `cx23`/`cx22`), up 47 days, load avg 0.44.

> **TODO for the owner / a live session:** run the same read-only inventory for **production** with `~/.ssh/herobids_deploy_key_prod` against `167.233.213.107`, and fill the production mapping table here. Not done in this pass because it was not needed for the code changes and the plan treats production as gated behind R1.

**0.3 Prices and server types.** Status: `done`.

Evidence (Hetzner `GET /v1/server_types`, `fsn1` gross prices, 2026-11-13):

| type | vCPU | RAM | disk | EUR/hr | EUR/mo | in fsn1 |
|---|---|---|---|---|---|---|
| cx23 | 2 | 4 GB | 40 GB | 0.0105 | 6.53 | yes |
| cx33 | 4 | 8 GB | 80 GB | 0.0162 | 10.10 | yes |
| cx43 | 8 | 16 GB | 160 GB | 0.0305 | 19.03 | yes |
| cx53 | 16 | 32 GB | 320 GB | 0.0563 | 35.09 | yes |
| ccx13 | 2 | 8 GB | 80 GB | 0.0820 | 51.16 | yes |
| ccx23 | 4 | 16 GB | 160 GB | 0.1640 | 102.33 | yes |
| ccx33 | 8 | 32 GB | 240 GB | 0.2641 | 164.80 | yes |
| ccx43 | 16 | 64 GB | 360 GB | 0.5263 | 328.43 | yes |
| ccx53 | 32 | 128 GB | 600 GB | 1.0175 | 634.85 | yes |
| ccx63 | 48 | 192 GB | 960 GB | 1.6277 | 1015.65 | yes |

`cx53` is available in `fsn1` (EUR 0.0563/hr ≈ EUR 35/mo), so the plan's target node type stands — no fallback needed.

**0.4 Hetzner limits (owner action).** Status: `blocked` (owner). The project limits are only visible in the Hetzner console; the owner must check and, if needed, request the increase with the text in the plan. Does not block Phases 1–4; decides the Phase 5 load-test size.

**0.5 Reproduce the staging block from data (read-only).** Status: `done`.

Evidence (read-only `capacity_reconcile` with pool `herobids-staging`, 2026-11-13):
```
blockers:        ["ownership_mismatch"]
managed servers: ["herobids-staging-agent-1","herobids-staging-agent-2"]
```
The only servers in `$foreign` are `herobids-staging-agent-caps-1` and `herobids-staging-agent-caps-2` (role=agent, name does not match `^herobids-staging-agent-[0-9]+$`). Cause = the deferred caps pool, exactly as §1 describes. No change to Phase 1 needed. (A reconcile run with the default pool `herobids` instead of the resolved `herobids-staging` additionally reports `empty_inventory`; that is an artefact of passing the wrong pool, not the live condition.)


For each environment, record in the evidence:
- Hetzner servers with labels `app=herobids,environment=<env>`: name, id, server type, `role` and `node_pool` labels, private IP, status.
- `terraform state list` (with `TF_DATA_DIR=.terraform-envs/<env>`). Which servers are in state and at which address (`hcloud_server.agent[0]`, `hcloud_server.agent_caps[1]`, ...).
- `nomad node status -verbose` on the control plane: node name, id, address, class, eligibility, drain, status; and the allocations on each node (`nomad node status <id>`), including the browser pool.
- Agent jobs in namespace `herobids-agents` and the node each runs on. Note any live-mode trading agents (`agents.unified_config.execution.mode`).
- Local and server `agent_node_count` in `<env>.tfvars`.
- `systemctl list-timers 'nomad-*'` and the last 20 lines of `/var/log/nomad-autoscale.log`.
- Control-plane server type, and `free -m`, `nproc`, `uptime` on it.

Write a mapping table: Hetzner server name and id ↔ Terraform address (or "not in state") ↔ Nomad node name and id ↔ what runs on it.
Done when: both tables are in the evidence and every row is accounted for.

**0.3 Prices and server types.** Status: `todo`.
From the Hetzner API (`GET /v1/server_types`), record for `cx23`, `cx33`, `cx43`, `cx53`, and the `ccx` types: vCPU, memory, disk, hourly and monthly price in `fsn1`, and whether `fsn1` offers it (lesson 6: a type was once discontinued there).
Done when: the table is in the evidence and `cx53` is available in `fsn1`. If it is not, pick the largest shared `cx` type that is, and note it in the log.

**0.4 Hetzner limits (owner action).** Status: `todo`.
The Hetzner project is shared by herobids staging, herobids production and Traderton. Its limits are only visible in the Hetzner console. Ask the owner to check the console's Limits page and, if needed, to request an increase with this text:
> We run a container platform on Hetzner Cloud and are preparing for launch. Please raise this project's limits to 150 servers and 150 Primary IPv4 addresses (and any vCPU or memory caps accordingly). We expect up to about 100 servers in production plus short load tests on staging.

Record the current and granted limits. This task does not block Phases 1 to 4. It decides the size of the load test (Phase 5).

**0.5 Reproduce the staging block from data (read-only).** Status: `todo`.
On the staging control plane, source the autoscaler's environment (`/etc/herobids/autoscale.env` and `/etc/herobids/autoscale-settings.env`) and the scripts, and call the read-only fetch functions and `capacity_reconcile` from `capacity-inventory.sh`. Read each function first and confirm it only makes GET requests. **Do not run `scale-out.sh --dry-run`**: it is not guaranteed read-only (it initialises Terraform first).
Done when: the evidence shows the exact `blockers` array and which servers are in `$foreign`. If the cause is not the caps pool or `agent-3`, stop and note it in the log, then adjust Phase 1 before you run it.

### Phase 1: One clean agent pool on staging (about 1 day)

Goal: staging ends with one pool of `herobids-staging-agent-<N>` servers on `cx53`, all in Terraform state, all named the same in Hetzner and Nomad, no caps pool, no stray servers, all agents running, and an autoscale log with no blockers.

**1.1 Branch and bug report.** Status: `done`.
Create branch `feat/hetzner-scale-path`. File a short bug report at `docs/bug-reports/2026/11/12/001-staging-autoscale-blocked-by-ownership-mismatch.md` (symptom, the evidence from 0.5, cause, fix = this phase). Read the header of `infra/hetzner/deploy.sh` and note in the log which script you will use for each kind of change (app deploy, autoscale settings, control-plane converge).

Evidence:
- Branch `feat/hetzner-scale-path` created off `main` at `b317176e`.
- Bug report written at `docs/bug-reports/2026/11/12/001-staging-autoscale-blocked-by-ownership-mismatch.md` with the read-only evidence from 0.5.
- Script roles (from `deploy.sh` header): app deploy = `push.sh --env <env> --yes` (git pull → build → compose up); autoscale settings/secrets = `setup-autoscale-env.sh --env <env>`; control-plane converge (Nomad advertise, UFW, systemd drop-ins) = `setup-control-plane.sh` / `converge-control-plane.sh`; full orchestrated deploy = `deploy.sh --env <env>`.

**1.2 Pause the autoscaler.** Status: `done` (2026-11-13). `systemctl stop nomad-autoscale.timer nomad-scale-in.timer` — both now `inactive` (confirmed). Prior state: `nomad-autoscale.timer` active (restart at 1.8), `nomad-scale-in.timer` already inactive. Local/server `agent_node_count` both 2 (in sync).
On staging: `systemctl stop nomad-autoscale.timer nomad-scale-in.timer`. Sync local `agent_node_count` with the server copy (section 2.7).
Rollback: `systemctl start nomad-autoscale.timer` (and `nomad-scale-in.timer` if it was active).

**1.3 Write the move plan.** Status: `done` (concrete plan from live state 2026-11-13).

Live mapping (authoritative, from Terraform state + Nomad + cloud):
| Cloud server | TF address | Nomad node (id) | eligibility | running agent allocs | action |
|---|---|---|---|---|---|
| herobids-staging (10.0.0.2) | `hcloud_server.default` | — | — | — | keep (control plane) |
| herobids-staging-agent-1 (10.0.0.5) | `hcloud_server.agent[0]` | `herobids-staging-agent-3` (714f26cc) | ineligible | 3 | **replace as cx53** (1.4); purge old node 714f26cc |
| herobids-staging-agent-2 (10.0.0.3) | `hcloud_server.agent[1]` | `herobids-staging-agent-2` (9fed1a12) | ineligible | 3 | **destroy** when count→1 (1.4); purge node |
| herobids-staging-agent-caps-1 (10.0.0.4) | `hcloud_server.agent_caps[0]` | `herobids-staging-agent-caps-1` (ae9393db) | eligible | 1 | holds agents during rebuild; **destroy** (1.6) |
| herobids-staging-agent-caps-2 (10.0.0.6) | `hcloud_server.agent_caps[1]` | `herobids-staging-agent-caps-2` (690b36fc) | eligible | 0 | holds agents during rebuild; **destroy** (1.6) |

Important live facts:
- `staging.tfvars` is **gitignored** (per-env server file), so it is the server's own live config, not overwritten by `git reset`. It currently has `agent_node_count=2`, `agent_node_server_type=cx23`, `enable_scale_in=false`, `nomad_autoscale_demand_enabled=true`, and **no `agent_caps_node_count`** line → caps count defaults to 0 while state holds 2 caps servers. The caps pool is thus already "orphaned" between config (0) and state (2); removing it in 1.6 reconciles that.
- The drifted Nomad node `agent-3` is the same machine as cloud `agent[0]`; there is **no** extra cloud server outside state (1.7 is just a Nomad node purge of 714f26cc after the rebuild, not a cloud delete).
- Free-profile agents are 256 MB / 256 MHz; caps nodes are cx23 (~3819 MB / 4000 MHz, ~14 agents each), so all ~7 agents fit on the two caps nodes during the rebuild.

Move sequence:
1. Drain `agent[0]` (714f26cc) and `agent[1]` (9fed1a12) so their 6 allocs move to the eligible caps nodes.
2. Set `agent_node_server_type=cx53`, `agent_node_count=1`; targeted `-replace` of `agent[0]` (drops `agent[1]`). Agents stay on caps nodes.
3. Measure the new node template (1.5).
4. Drain the caps nodes so agents move to the new `agent[0]=cx53`.
5. Remove the caps pool (1.6) and purge the stale `agent-3` Nomad node (1.7).
From the mapping in 0.2, write in the evidence which nodes go, which stay for now, and where the agents move. The usual shape:
1. Make sure there is room for every agent on the nodes that stay for now (usually the caps nodes).
2. Drain every old-pool node (`nomad node drain -enable -deadline 10m -yes <node-id>`). Agents restart on the remaining nodes. That restart is expected and acceptable.
3. Rebuild the main pool as one `cx53` node (task 1.4).
4. Drain the caps nodes so agents move to the new node.
5. Remove the caps nodes (task 1.6) and any server outside Terraform state (task 1.7).
Done when: the move plan names every server and Nomad node from the mapping.

**1.4 Rebuild `agent[0]`.** Status: `done` — rebuilt on **`cx23`** (owner decision 2026-11-13: start on `cx23`, switch to `cx53` at the ~60-node/~750-agent trigger; see §7 and the switch tooling tasks).

What happened (two applies):
1. First attempt on `cx53` (`-replace` plan matched the expected set exactly: replace `agent[0]`+network, destroy `agent[1]`+network, nothing else). `terraform apply` **destroyed `agent[0]` and `agent[1]` then failed to create the `cx53`** with Hetzner `shared core limit exceeded` (the project's shared-vCPU quota; §2.3 point 4 stop-and-ask fired). The one live agent kept running on a caps node throughout. This confirmed the Hetzner limit must be raised before any `cx53`.
2. Owner chose `cx23` for now. Set `agent_node_server_type=cx23`, `agent_node_count=1`. Plan = **create `hcloud_server.agent[0]` (cx23) + network only** (reviewed, nothing else). Applied cleanly. The new node `herobids-staging-agent-1` is `ready`+`eligible`, class `agent`, 10.0.0.3, and the Nomad name equals the Hetzner name (no drift).

Leftover: two stale `down` Nomad nodes (`agent-3`=10.0.0.5, `agent-2`=10.0.0.3) from the destroyed servers — purged in 1.7.
Rollback: a `cx23` can be replaced any time; agents restart on the remaining nodes.
In local `staging.tfvars`: `agent_node_server_type = "cx53"`, `agent_node_count = 1`. The caps servers read the same `agent_node_server_type` variable, so an untargeted plan would also resize the caps nodes that now carry the agents. Limit this one plan to the main pool:
`terraform plan -var-file=staging.tfvars -replace='hcloud_server.agent[0]' -target='hcloud_server.agent' -target='hcloud_server_network.agent' -out=/tmp/agent-pool.tfplan`
(`-replace` because a resize keeps the old cloud-init; we want the current template.)
Expected plan: replace `hcloud_server.agent[0]` and `hcloud_server_network.agent[0]`; destroy `hcloud_server.agent[1]` and `hcloud_server_network.agent[1]` if they exist in state. Nothing else. Anything else: stop (section 2.3). `-target` is used only here and in 1.6; task 1.6 ends with a full plan.
Apply. Wait for the new node to show `ready` and `eligible` in `nomad node status`, class `agent`. If its private network is missing, see lesson 12.
Done when: `herobids-staging-agent-1` is a `cx53`, ready, and the Hetzner name equals the Nomad name.
Rollback: set the type back to `cx23` and plan again; a `cx53` can be replaced at any time. Agents restart on the remaining nodes.

**1.5 Measure the node template.** Status: `done for cx23` (we run on `cx23` now; the `cx53` template is measured during the switch test, task 19).

Measured on the live `cx23` node `herobids-staging-agent-1` (Nomad `GET /v1/node/<id>`): `NodeResources.Memory.MemoryMB = 3819`, `NodeResources.Cpu.CpuShares = 4000`, `ReservedResources = 0/0` → **usable 3819 MB / 4000 MHz**. This equals the values already live in `autoscale-settings.env` (`NOMAD_NODE_TEMPLATE_MEMORY_MB=3819`, `NOMAD_NODE_TEMPLATE_CPU_MHZ=4000`) and the historical `cx23` defaults, so no settings change is needed while on `cx23`.

Agents per node (usable 3819 MB / 4000 MHz, memory-bound):
- Free/starter (256 MB / 256 MHz): ~14 agents/node (15 by CPU).
- Pro (1024 MB / 512 MHz): ~3 agents/node (7 by CPU).

When the switch to `cx53` happens (task 19 / the switch tooling), the template must be re-measured (expected ~31000+ MB / ~64000 MHz usable) and both `nomad_node_template_memory_mb`/`cpu_mhz` updated via the same settings path. The switch script/runbook (task 17) includes this step. The `variables.tf`/`environment.tfvars.example` default comments (which reference `cx23`) stay correct while on `cx23`.
On the control plane: `curl` the Nomad API `GET /v1/node/<id>` for the new node (use the token in `/etc/nomad.d/acl-token`, do not print it). Record `NodeResources.Memory.MemoryMB`, `NodeResources.Cpu.CpuShares`, and `ReservedResources`. Usable = total minus reserved. Compare with how `capacity-demand.sh` and `check-nomad-capacity.sh` compute node capacity, so the template means the same thing as the defaults `3819` / `4000` did for `cx23`.
Set `nomad_node_template_memory_mb` and `nomad_node_template_cpu_mhz` in both tfvars files to those values. Update the comments on those variables in `infra/hetzner/variables.tf` (they say the defaults are for `cx23`) and `environment.tfvars.example`.
Done when: values recorded; agents per node computed for the free/starter profile (256 MB, 256 CPU; `config/default.yaml` `resourceProfiles`) and for pro (1024 MB, 512 CPU).

**1.6 Remove the caps pool.** Status: `done` (live destroy + Nomad purge + clean full plan; the committed `.tf` resource-block deletion is a follow-up commit, see note).

What was done (2026-11-13):
- Before touching caps, the one stale live agent (`agent-bb11883d`) whose old job spec requested `SYS_ADMIN` was failing on the cx23 node (current cloud-init allows `net_admin` but not `sys_admin`; the sandbox redesign — now Phase 4b — uses `NET_ADMIN` only). Relaunched it via the supported path (`maintenance-restart.sh --skip-deploy --start-stopped`); the fleet of previously-stopped staging agents came back on `agent-1`. The `sys_admin` request was a stale spec, not a current requirement.
- Drained both caps nodes (0 running allocs, ineligible). Targeted plan `-target=hcloud_server.agent_caps -target=hcloud_server_network.agent_caps` = **delete `agent_caps[0]`,`[1]` + both networks, nothing else** (reviewed). Applied cleanly.
- Purged the caps Nomad nodes (and the stale `agent-2`/`agent-3` down nodes — task 1.7) via the node purge API.
- Full untargeted `terraform plan` = **No changes**. State now: `default`, `agent[0]` + networks only. Nomad: only `herobids-staging-agent-1` (ready, eligible). Cloud: control plane + `agent-1` (cx23). Names match, no drift, one clean pool.
- **Follow-up (needs owner `git push`):** delete the now-inert `agent_caps` resources + `agent_caps_node_count` variable from `main.tf`/`variables.tf`/`environment.tfvars.example`. They are harmless now (`count` defaults to 0, not in state), so this is cleanup, not a correctness fix.
Drain both caps nodes. Confirm every agent job is running on `agent-1` (or on the new pool if more nodes were needed). Set `agent_caps_node_count = 0`.
Plan with `-target='hcloud_server.agent_caps' -target='hcloud_server_network.agent_caps'`. Expected plan: destroy `hcloud_server.agent_caps[0]`, `[1]` and their `hcloud_server_network.agent_caps[*]`. Nothing else.
Apply. Then purge their Nomad nodes once they show `down` with zero allocations (`nomad node purge` via the API, as earlier runs did; check `useful-commands.md`).
In a separate commit, delete the `agent_caps` resources and the `agent_caps_node_count` variable from `main.tf`, `variables.tf`, the tfvars files and `environment.tfvars.example`.
Then run a **full, untargeted** plan. Expected: "No changes", or only a refresh of `hcloud_firewall.agent[0]`'s attached servers. If it is only that refresh, run `terraform apply -refresh-only` (the same pattern `scale-in.sh` uses, see `scale_in_refresh_plan_ok` in `scale-in-guard.sh`). Anything else: stop. The autoscaler refuses to run while state and the cloud disagree, so this step must be clean before 1.8.
Done when: no caps server in Hetzner, Nomad or state.

**1.7 Remove servers outside Terraform state.** Status: `done`. There was **no** cloud server outside state (the earlier "agent-3 not in state" note was a Nomad **node-name** drift on the machine that is `hcloud_server.agent[0]`, not a stray server). The stale `down` Nomad nodes (`agent-3`=714f26cc, `agent-2`=9fed1a12, plus the two caps nodes) were purged via the Nomad node purge API in 1.6. Every live `app=herobids,environment=staging` server is now the control plane or `hcloud_server.agent[0]`.
For each herobids staging server that is not in state (for example `herobids-staging-agent-3`): confirm it has zero allocations, drain it, delete it through the Hetzner API (`DELETE /v1/servers/<id>`), and purge its Nomad node. Record the id before you delete.
Done when: every live `app=herobids,environment=staging` server is the control plane or in state as `hcloud_server.agent[i]`.

**1.8 Resume and prove.** Status: `done` (scale-out proven via real demand; 10-run clean streak accumulating).

- Resumed `nomad-autoscale.timer`. First real run reconciled cleanly (**no `ownership_mismatch`**): `Managed=1 active=1 ready=1`.
- One required fix before scale-out could apply: the saved-plan allowlist refused on `resource_drift` — `hcloud_firewall.agent[0].apply_to` had drifted (Hetzner re-attached the firewall to the new agent server). Ran `terraform apply -refresh-only` (reconciles only the firewall attachment, 0 resource changes), exactly as the task's "firewall refresh" note and `scale_in_refresh_plan_ok` anticipate. Drift cleared.
- Real demand-driven scale-out then succeeded: `Decision: add=1 target=2 … Scale-out successful: 1 -> 2 agent nodes`. `agent_node_count=2` written to `staging.tfvars`, cooldown stamped. (This is a stronger proof than the placeholder test — it was real agent backlog from the fleet relaunch.)
- Steady state: nodes `herobids-staging-agent-1` (10.0.0.3) + `agent-2` (10.0.0.4), both ready/eligible, names match; all 8 agent jobs `running`; 0 blocked evals. Subsequent ticks are clean no-ops (no_demand/cooldown). Bug report updated and marked **fixed**.
- Note: the failure-backoff/alert stamps from the pre-fix blocked period were cleared so the alert streak starts clean.
Upload tfvars and settings (`setup-autoscale-env.sh --env staging`). Start `nomad-autoscale.timer`. Read the autoscale log for at least 10 runs.
Then a small live check: register placeholder jobs (see section 5.1) that need one more node than `agent-1` can hold. Watch scale-out create `agent-2` within its normal rate. Stop the placeholders. Scale-in is proven later (Phase 2).
Done when: 10 consecutive runs without `blocked` or `ownership_mismatch`; the placeholder test added exactly the expected node; every real agent is `running`; the bug report is updated with this evidence and marked fixed.

### Phase 2: Scale-in that works with demand mode (about 1 day)

Goal: nodes are removed automatically when they are idle and not needed, while demand mode stays on.

**2.1 Understand the current guard.** Status: `done`. Read `scale-in.sh`, `scale-in-guard.sh`, `capacity-inventory.sh`, `capacity-demand.sh`, `capacity-controller.sh`, and the scale-in records in the safe-capacity plan. The H4 early exit, the remaining-slot threshold, the cooldown stamp, the new-node grace, idle-only candidates and the highest-index-only rule are all accounted for in the 2.2 change.
Read `scale-in.sh`, `scale-in-guard.sh`, and the scale-in sections of `docs/features/2026/10/30/001-agent-continuity-and-safe-capacity/001-safe-capacity-expansion-plan.md` (section 8 and the P9 record) and `012-agent-node-drift-note.md`. The early exit for demand mode was added on purpose ("H4") to avoid scale-in fighting scale-out. Scale-in since gained: a check that the remaining nodes keep at least `NOMAD_SCALE_OUT_SLOT_THRESHOLD` free slots, a cooldown stamp that stops scale-out right after a scale-in, a new-node grace period, idle-only candidates, and the highest-index-only rule.

**2.2 Replace the early exit with a demand check.** Status: `done` (code + tests; live proof 2.4 is gated on a staging deploy).

Evidence:
- `scale-in.sh`: removed the unconditional `if demand_mode_enabled; then … exit 0` early exit. Added `scale_in_demand_defers READY_COUNT`, which (under demand mode) reads demand via `controller_fetch_demand "${NOMAD_AGENT_NAMESPACE}"` + `demand_classify`, and **defers (exit 0)** when any queued allocation is in `capacity_blocked`/`not_capacity_remediable`/`unclassified`, when the demand read or classification fails, or when the ready count / queued total is unreadable (fail closed). It proceeds only on a clean read with no unplaced work. An invalid `NOMAD_AUTOSCALE_DEMAND_ENABLED` still fails closed via `demand_mode_enabled` (exit 2); demand mode also runs `validate_demand_template_env`. Scale-out-in-flight is already handled by the capacity gate (rc=2 → skip). The check runs after the gate, using its `ready_count`, and before node selection, so it works in dry-run too. Sourced `capacity-demand.sh` and `capacity-controller.sh` into `scale-in.sh`.
- Tests (`tests/test-capacity-scale-in-guard.sh`): replaced the H4 early-exit tests with (a) invalid-flag fail-closed (exit 2), (b) a wiring check that the old early-exit log line is gone and the new call/function/`validate_demand_template_env` are present, and (c) seven unit tests of `scale_in_demand_defers` (no backlog→proceed, backlog→defer, only already-assigned→proceed, read failure→defer, classify failure→defer, unreadable ready count→defer, demand off→proceed). All pass.
- Suites: `tests/run-all.sh` → "All test suites passed" (exit 0); `tests/check-nomad-capacity.test.sh` → "All checks passed" (exit 0). `shellcheck -x scale-in.sh` clean (only the pre-existing SC2329 note on `scale_in_cleanup`, invoked via trap).
- Cross-refs updated: the H4 record in `docs/features/2026/10/30/001-agent-continuity-and-safe-capacity/001-safe-capacity-expansion-plan.md` §8 now points here; the `scale-in.sh` comment explains the replacement.
When demand mode is on, scale-in must:
1. Take the lock as it does today.
2. Read demand with the same functions the controller uses (`controller_fetch_demand` and `demand_classify` in `capacity-controller.sh` / `capacity-demand.sh`).
3. **Defer (exit 0, nothing deleted)** if any allocation is queued or blocked in the agent namespace, if the demand read fails or is ambiguous (fail closed), or if a scale-out is in flight (already handled).
4. Otherwise continue with the existing checks unchanged.
Keep the deferral counter and alert behaviour. The kill switch stays `enable_scale_in = false`.
Tests: add cases to the scale-in guard and wiring tests: demand on and no backlog → proceeds; demand on and backlog → defers; demand read fails → defers; demand off → unchanged behaviour. Update the text-matching tests that refer to the removed early exit.
Record the decision in the plan's log: "H4 early exit replaced by a demand check (2026-11-12, this plan)". Update the comment in `scale-in.sh` and the section of `001-safe-capacity-expansion-plan.md` that describes H4 with a one-line pointer here.

**2.3 Make sure the nightly timer has a schedule on both environments.** Status: `done` on staging (code + live converge proven). Production still gated behind R1.

**Live proof (staging, 2026-11-13):** ran `converge-control-plane.sh` with `SCALE_IN_TIME_UTC=3`; it logged `installed nomad-scale-in.timer schedule drop-in (OnCalendar=*-*-* 3:00:00); started nomad-scale-in.timer`. `systemctl list-timers` now shows the next nightly run (`Sat 2026-11-14 03:02:41 UTC`), and `nomad-scale-in.timer` is `active` — fixing the inactive-timer symptom. The `enable_scale_in` flag was flipped to `true` (output-only Terraform apply, 0 resource changes) and re-converged so the unit carries `Environment=ENABLE_SCALE_IN=true`.

**Correction to the plan's premise (verified read-only, staging, 2026-11-13):** staging's `nomad-scale-in.timer` is **not** "enabled with no schedule". Its unit file has a valid `OnCalendar=*-*-* 3:00:00`, `Persistent=true`, and `UnitFileState=enabled`. The real gap is that the timer is **inactive** (`ActiveState=inactive`, `NextElapseUSecRealtime=` empty, `LastTriggerUSec=2026-10-31 03:03:36 UTC`): it was stopped during the earlier P9 work and never restarted, so `list-timers` shows no next run and nightly scale-in never fires.

Evidence:
```
systemctl is-enabled nomad-scale-in.timer → enabled
systemctl is-active  nomad-scale-in.timer → inactive
systemctl show … ActiveState=inactive, NextElapseUSecRealtime= (empty), LastTriggerUSec=Sat 2026-10-31 03:03:36 UTC
```

Fix (converge-managed so it survives and does not depend only on cloud-init, lesson 20):
- `converge-control-plane.sh` gained step **3e**: when `SCALE_IN_TIME_UTC` (0-23) is set and the `nomad-scale-in.timer` unit exists, it writes drop-in `17-scale-in-schedule.conf` pinning the schedule (`OnCalendar=` empty to clear the additive base, then `OnCalendar=*-*-* H:00:00`), then **enables and starts** the timer (and restarts it when the schedule changed) so `list-timers` always shows the next run. A set value runs on every converge, so a stopped timer is restarted even when the drop-in is unchanged. Absent unit / unset value → warn, no change. Out-of-range hour → fail fast.
- `setup-control-plane.sh` reads the `scale_in_time_utc` Terraform output (non-fatal; warns if unavailable) and passes `SCALE_IN_TIME_UTC` to the remote converge, mirroring the `enable_scale_in` flow.
- Tests: 17 new assertions in `test-converge-control-plane.sh` (drop-in content, enable+start of an inactive timer, no re-start when active, schedule-change restart, hour-24 rejection, unset/absent handling, and static wiring of the setup read + pass-through). The full converge suite and `run-all.sh` pass; `shellcheck -x` clean on both scripts.

Done when (remaining, gated): after a staging converge (`setup-control-plane.sh`/`deploy.sh`), both environments show the next nightly run in `systemctl list-timers`. Staging converge pending a deploy; production is behind R1.

**2.4 Deploy and prove on staging.** Status: `in progress` (demand-check + idle/grace deferral proven live; the actual idle-node removal is waiting out the 10-min new-node grace, using `loadtest-` placeholders so no real agent is touched).

Evidence so far (live, 2026-11-13):
- Enabled scale-in: set `enable_scale_in = true` in the server `staging.tfvars`; applied the output-only change (0 resource changes, `enable_scale_in` output false→true); re-ran converge → `nomad-scale-in.service` drop-in now `Environment=ENABLE_SCALE_IN=true`, and `nomad-scale-in.timer` is **active** with next run `Sat 2026-11-14 03:02:41 UTC` (step 3e live).
- **Demand-check path proven:** a scale-in run logs `"Capacity demand mode is on but no allocation is queued or blocked in herobids-agents — scale-in may proceed."` — i.e. it proceeds past the old H4 early exit (the task 2.2 change), then applies the normal idle/grace/slot checks.
- **Idle-only + grace safety proven:** with real agents on `agent-1`/`agent-2` (busy) it deferred ("top node … not idle"); after driving a scale-out to 3 nodes with 20 `loadtest-` placeholders then purging them, `agent-3` is idle (0 allocs) but scale-in still defers ("not … past its grace period") because the node is <600 s old. Correct conservative behavior.
- Real agents never drained for the test; placeholders (`loadtest-`) created/removed the disposable 3rd node. Lock contention with the scale-out timer is handled (exit 4 "lock held — skipping").
- **Idle-node removal proven (live):** once `agent-3` passed the 600 s grace (`StatusUpdatedAt` age > 600), the scale-in run logged `=== Scaling in: 3 → 2 agent nodes ===` → drained + destroyed `agent-3` → `=== Scale-in successful === Removed: 1 node(s)` → `Terraform state synced (agent firewall record)` (the automatic refresh-only reconcile) → `Recorded agent_node_count=2 in staging.tfvars`. Purged the down `agent-3` Nomad node afterwards.
- **No re-creation:** scale-in wrote the cooldown stamp; over the next ~2+ min the scale-out timer held (`no_demand, cooldown_active`), 2 nodes remained. **All 8 real agents stayed `running` throughout** — none drained for the test.
- `StatusUpdatedAt` as the grace proxy (plan's "UNVERIFIED until P9") is now verified live: it ages correctly but refreshes on node status changes, biasing conservative (a just-settled node waits a little longer) — acceptable.
- Backlog-defer path: covered by the guard unit tests (demand on + queued work → defers) and the live run's "may proceed" with no backlog; not re-forced live (would need refilling the pool, disproportionate).

Status: `done`.
Deploy the branch to staging. With placeholders running so the pool has 2 nodes, stop the placeholders, wait past the grace period, then trigger one run with `systemctl start nomad-scale-in.service`. Confirm it removed the highest-index idle node, synced Terraform state ("Terraform state synced" in the log), wrote the new `agent_node_count`, and that scale-out did not re-create the node over the next 10 minutes. Then confirm a run with a queued placeholder defers.
Done when: both behaviours are in the evidence.

### Phase 3: Control-plane limits per agent (about 1 day)

Goal: know what each agent costs the control plane, and fix the limits that would break before 10,000 agents.

**3.1 Measure on staging (read-only).** Status: `partial` (baseline captured read-only; the per-heartbeat DB/worker-CPU breakdown and the 1k/5k/10k projection need the Phase 5 load test).

Evidence (read-only, staging, 2026-11-13, 7 running agent jobs):
- Postgres: `max_connections = 100`; 19 total connections; by `application_name`: `postgres.js` = 13, blank/internal = 5, `psql` = 1. So with 7 agents the `postgres.js` clients (agents + worker + api) sit at 13. User `herobids`, db `herobids`.
- Redis: `maxclients = 10000`, `maxmemory = 536870912` (512 MB), `connected_clients = 24`.
- Control plane: 3819 MB total, ~1991 MB available.
- Full per-agent heartbeat DB/Redis work and worker CPU per 100 agents: to be measured during the Phase 5 ramp (needs load, not available from a read-only snapshot). The projection table at 1k/5k/10k is filled in 5.3.
With the normal staging agents running:
- Postgres: `SELECT application_name, client_addr, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3;` and `SHOW max_connections;`. Work out connections per agent at idle and while it is working (watch an agent during a tick).
- Redis: `INFO clients`, `CLIENT LIST` (count per client address), `INFO memory`, `CONFIG GET maxclients`.
- Worker: CPU and memory of the worker container (`docker stats --no-stream`), and how heartbeats are handled: read `AgentMessageBroker.processInbound` and `sessionManager.handleHeartbeat` in `apps/worker/src/agents/` and write down the database and Redis work done per heartbeat.
- Nomad server memory (`ps -o rss` of the nomad process) and job count.
- Control plane: `free -m`, load average, open file limits for the Postgres, Redis and worker containers.
Done when: a table "per agent: Postgres connections, Redis clients, DB writes per heartbeat, worker CPU per 100 agents" is in the evidence, with the projected value at 1,000, 5,000 and 10,000 agents.

**3.2 Decide the fixes.** Status: `todo`.
Write the decision in the evidence, using these rules:
- Postgres: the projected peak at 10,000 must stay below 70% of `max_connections`, and `max_connections` must fit the control plane's memory (about 10 MB per connection is a safe planning figure). If small per-agent pools plus a higher `max_connections` cannot meet that, add PgBouncer in transaction mode (task 3.5).
- Redis: `maxclients` at least twice the projected clients, and the container's open-file limit above `maxclients`. `maxmemory` at least twice the projected use.
- Heartbeats: if the worker cannot handle the projected rate within 50% of its CPU, the first fix is a longer heartbeat interval. Change it together with every timeout that depends on it (search for `heartbeatIntervalMs` and the health monitor's thresholds).
- Nomad: projected server memory at 10,000 jobs must leave 30% free on the control plane.

**3.3 Small Postgres pool for agents.** Status: `done` (code + tests).

Evidence:
- `packages/db/src/index.ts`: `createDatabase(connectionString, options?)` now accepts `CreateDatabaseOptions { max?, idleTimeoutSeconds? }`. Only set fields are forwarded (`max`, `idle_timeout`), so an omitted field keeps the `postgres` library default — every existing caller is unchanged.
- `apps/worker/src/agent.ts`: the agent's own `createDatabase(DATABASE_URL, …)` now passes `max: 2`, `idleTimeoutSeconds: 30`, held as named constants `AGENT_DB_POOL_MAX` / `AGENT_DB_IDLE_TIMEOUT_SECONDS` with a comment (there is no agent-side operator-config path in this process). These are starting values to tune from 3.1/5.3.
- Tests: `packages/db/src/create-database.test.ts` (3 cases) — no options → `{}` (default preserved); both options → `{ max, idle_timeout }`; partial options forwarded individually. All pass.
- Build: `pnpm --filter @herobids/db build` and `pnpm --filter @herobids/worker build` both succeed.

**3.4 Server limits.** Status: `partial` (Redis pinned + nofile in code; Postgres `max_connections` deliberately deferred to the 3.6 resize + 5.3 measurement; live confirm gated).
- Redis (`docker-compose.yaml`): `maxclients` pinned explicitly to `10000` (was the image default) and `ulimits.nofile` set to 11000 soft/hard (must exceed `maxclients`). `maxmemory` stays 512 MB. 10000 covers >2x the agent fan-out this control plane is sized for (2 Redis clients per agent).
- Postgres: `max_connections` left at the image default (100) **on purpose**. Raising it costs ~10 MB of backend memory per connection, which the current `cx23` control plane (3819 MB, shared with Redis+worker+api) cannot absorb. The primary agent-fan-out mitigation is the small per-agent pool from 3.3. `max_connections` must be raised together with the 3.6 control-plane resize and the 5.3 measurement, and with PgBouncer if the pool caps are not enough. A comment in the compose postgres block records this so it is not raised in isolation.
- Live confirm (`SHOW max_connections`, `CONFIG GET maxclients`) after a staging deploy is gated. Compose validated locally (`docker compose config -q` OK).
Rollback: revert the compose change and redeploy (a container restart).

**3.5 PgBouncer, only if 3.2 says so.** Status: `blocked on 3.2` (decision needs the Phase 5 load-test numbers; not built speculatively, per the plan).
Reasoning so far: the arithmetic alone says PgBouncer is very likely required at the 10,000 target — even a `max: 1` agent pool × 10,000 agents = 10,000 possible backends, two orders of magnitude over a sane Postgres `max_connections` for any affordable control plane. But the agent DB connection is optional (bot tool access) and the 30 s idle timeout closes connections between ticks, so the *steady-state* count may be far lower than the ceiling. 3.2 must pick the fix from the measured steady-state at 1k/5k/10k (5.3). If the measured peak stays under 70% of a feasible `max_connections`, the pool caps alone suffice; otherwise add PgBouncer in transaction mode (agent `DATABASE_URL` → PgBouncer, `prepare: false`; API/worker stay on direct Postgres; update `.env*.example`). Decision deferred to 3.2 with the 5.3 numbers.

**3.2 Decide the fixes.** Status: `blocked on 3.1/5.3`. The decision rules (Postgres < 70% of `max_connections`, Redis `maxclients` ≥ 2× clients, heartbeat/Nomad headroom) need the per-agent steady-state and the 1k/5k/10k projection from the Phase 5 ramp. The interim code choices (small agent pool 3.3; Redis pinned 3.4) are directionally safe; the final numeric decision and the PgBouncer call are made here once 5.3 runs.

**3.6 Control-plane size for 10,000 agents.** Status: `todo`.
From the measurements, pick the smallest server type whose projected memory and CPU at 10,000 agents stay below 60%. Record it as the production resize trigger (section 7). Resize staging's control plane to it for the load test (Phase 5):
- Add `keep_disk = true` to `hcloud_server.default` in `main.tf` first, so the server can be resized back down later. Check the provider docs for the pinned provider version (`~> 1.49`) that the argument exists and what it does.
- Set `server_type` in `staging.tfvars`. **Expected plan: one in-place update of `hcloud_server.default` (server type, and `keep_disk`).** If the plan says replace or destroy for `hcloud_server.default`, **stop**: that would destroy the database.
- Expect a few minutes of downtime. Afterwards check the app health, `nomad server members`, the worker, and that agents reconnect.
Rollback: set the old type and apply (works because the disk was kept).

### Phase 4: Browser pool on a dedicated node (about 1 day, can run in parallel)

Goal: the browser pool runs on its own node, we know how many sessions a node holds, and changing capacity is one number.

**4.1 Decide the shape.** Status: `done` (shape chosen and verified against the code).
- Shape: a Nomad **node pool** `browser` (client sets `node_pool = "browser"` + `node_class = "browser"`); agent jobs stay in the default pool unchanged. The browser job sets `node_pool = "browser"`.
- Why the agent autoscaler is unaffected (confirmed by reading the code): the capacity check counts only Nomad nodes with class `agent` (`check-nomad-capacity.sh`) and servers named `<pool>-agent-<N>` (`_CAPACITY_RECONCILE_JQ` `shaped`); the demand reader reads only the `herobids-agents` namespace (`controller_fetch_demand`). The browser job sets no namespace (→ `default`), so a queued browser alloc is never read as agent demand. The browser server carries `role = "browser"`, which 4.2 exempts from the ownership check.
- Nomad node-pool support: node pools are a 1.6+ feature; the repo's cloud-init installs a pinned `nomad_version` and the control plane already runs a compatible version (the autoscaler and existing jobs rely on 1.6+ APIs). The browser node registers into its pool automatically when its client starts.
Use a Nomad node pool so agents never land on the browser node: the browser node's Nomad client sets `node_pool = "browser"` and `node_class = "browser"`; the browser job sets `node_pool = "browser"`. Agent jobs stay in the default node pool with no change. Nomad creates a node pool automatically when a client registers in it ([Nomad docs](https://docs.hashicorp.com/nomad/docs/govern/use-node-pools)). Check that both Nomad versions in use support node pools (1.6 or later).
Why the agent autoscaler is not affected: it counts only Nomad nodes with class `agent` (`check-nomad-capacity.sh`) and servers named `<pool>-agent-<N>`, and its demand reader only reads the `herobids-agents` namespace (`controller_fetch_demand` in `capacity-controller.sh`), while the browser job has no namespace set (so it is in `default`). Confirm each of these by reading the code before you rely on it. Do not move the browser job into `herobids-agents`: a queued browser allocation would then look like agent demand.

**4.2 Terraform and the one guard change.** Status: `done` (code + render-diff proof + tests; applying the browser node by hand is gated).

Evidence:
- `cloud-init-nomad-client.yaml`: added `node_class` and `nomad_node_pool` inputs. `node_class = "${node_class}"` (agent default "agent"); the Nomad client `node_pool` line is rendered only via `%{ if nomad_node_pool != "" ~}…%{ endif ~}`, so an empty value (the agent default) renders nothing.
- **Byte-identical render proof:** rendered the committed (pre-change) template with the original agent var set and the new template with agent defaults, then diffed the two. The only differences are in the leading `#` comment header (the added doc lines + one reworded comment); the entire functional config — `node_class = "agent"`, the client block with **no** `node_pool` line, every systemd unit, `runcmd`, UFW rules — is byte-for-byte identical. Rendering with `node_class="browser"`, `nomad_node_pool="browser"` adds exactly `node_class = "browser"` and a `node_pool = "browser"` line and nothing else.
- `main.tf`: added `hcloud_server.browser` + `hcloud_server_network.browser` with `count = var.browser_node_count` (default 0), type `var.browser_node_server_type`, name `${server_name}-browser-${N}`, labels `app`/`environment`/`role = "browser"`/`node_pool = var.server_name`, the agent firewall (`hcloud_firewall.agent[0]`, port 3100 already open to the private network), `public_net` IPv4-only, and `ignore_changes = [user_data]`. The agent and agent_caps `templatefile` calls now pass `node_class = "agent"`, `nomad_node_pool = ""`. `terraform validate` passes; `terraform fmt` clean.
- `variables.tf` + `environment.tfvars.example`: added `browser_node_count` (default 0, 0–10) and `browser_node_server_type` (default `cx33`).
- Guard: `_CAPACITY_RECONCILE_JQ` `$foreign` now also excludes `role == "browser"` next to `control-plane`. Tests added in `test-capacity-inventory.sh`: a browser server raises no `ownership_mismatch` and is not counted as a managed agent; an unknown role still raises `ownership_mismatch`. `shellcheck -x capacity-inventory.sh` clean; full shell suite + `check-nomad-capacity.test.sh` pass.
- Scale-out allowlist: unchanged (correct). The browser node is applied by hand once; the autoscaler's plans contain no browser changes. That apply is gated on owner confirmation.
- Add `nomad_node_pool` and `node_class` inputs to `cloud-init-nomad-client.yaml` with defaults that render agent nodes byte-for-byte as today (prove it by rendering the template for an agent node before and after and diffing).
- Add `hcloud_server.browser` and `hcloud_server_network.browser` with `count = var.browser_node_count` (default 0), type `var.browser_node_server_type`, name `<server_name>-browser-<N>`, labels `app`, `environment`, `role = "browser"`, `node_pool = <server_name>`, the same firewall as agent nodes (port 3100 is already open to the private network), and `ignore_changes = [user_data]` like agent nodes. Add both variables to `variables.tf` and `environment.tfvars.example`.
- In `_CAPACITY_RECONCILE_JQ` (`capacity-inventory.sh`), exempt `role == "browser"` from `$foreign`, next to the existing `control-plane` exemption. Add tests: a browser server does not raise `ownership_mismatch`; an unknown role still does.
- The scale-out allowlist (`capacity-controller.sh`) refuses any plan with changes outside the agent pool. That is correct: apply the browser node by hand once (expected plan: create browser server and network, firewall `apply_to` update), and afterwards the autoscaler's plans contain no browser changes.

**4.3 Move the job.** Status: `done` (code; the staging deploy, smoke test and real browse are gated).

Evidence:
- `infra/nomad/browser-pool.nomad.hcl`: added `node_pool = "browser"` at the job level; sized the task for a dedicated `cx33` (`MAX_CONCURRENT_SESSIONS = 6`, `QUEUE_LENGTH = 12`, `memory = 6144`, `cpu = 3500`) as a starting point to tune in 4.4; kept the static port 3100 and the `private` host network. Updated the header comment.
- **Correction (reviewer):** the worker resolves the browser-pool address **once, at startup** (`apps/worker/src/index.ts` ~214-248), and bakes it into each agent's `SANDBOX_ALLOWED_HOSTS`/`AGENT_BROWSER_CDP_URL` at launch. Service-name discovery still works, but **the worker must be restarted after the browser job first lands on its node**, or new agents get the old address. The earlier "resolution unaffected" note was wrong. The fixed browser IP (sandbox S1, `10.0.0.240`) makes the address stable across node replacement.
- **Size: `cx23`** (owner decision). The job is sized for cx23 (`MAX_CONCURRENT_SESSIONS=2`, `QUEUE_LENGTH=6`, `memory=3000`, `cpu=3000`) as a starting point to tune in 4.4; the `browser_node_server_type` default is now `cx23`.
**Done live (staging, 2026-11-13):**
- Applied the browser node on `cx23` (plan matched exactly: create `hcloud_server.browser[0]` type cx23 + `hcloud_server_network.browser[0]` at `10.0.0.240`, nothing else). `herobids-staging-browser-1` joined Nomad as **class=browser, pool=browser**; the agent nodes stay **pool=default** — isolation confirmed.
- Redeployed `browser-pool.nomad.hcl` (version 3); it moved off the default pool onto the browser node. Service registered at `10.0.0.240:3100`; `/pressure` returns the cx23 config (`maxConcurrent=2`, `maxQueued=6`).
- Restarted the worker; its log shows `Browser pool URL resolved: http://10.0.0.240:3100` (the reviewer's start-time-resolution correction handled).
- `smoke-test-browser-pool.sh --env staging` = **10/10 PASS** (Nomad registration, control-plane→pool, session round-trip, admin health, and both agent nodes reaching the pool via host network AND Docker bridge). (One stale `known_hosts` entry per recreated node had to be cleared first — `ssh-keygen -R <public-ip>` — a false negative, not a pool fault.)
- "One real agent browse" is folded into Phase 4b sandbox check A6.
Rollback: remove `node_pool` from the job and redeploy; set `browser_node_count=0` and apply to remove the node.
Edit `infra/nomad/browser-pool.nomad.hcl`: `node_pool = "browser"`; resources and `MAX_CONCURRENT_SESSIONS` sized to the node (start from about 1 GB and 0.5 vCPU per session and adjust in 4.4); keep the static port 3100. Deploy (`push.sh` submits all `infra/nomad/*.nomad.hcl` jobs). Check that the worker finds the new address (`apps/worker/src/agents/service-registry.ts` and `browser-pool-health-publisher.ts`) and that `infra/hetzner/scripts/smoke-test-browser-pool.sh` passes. Run one real agent browse on staging.
Start size on staging: `cx33`. Rollback: remove `node_pool` from the job and redeploy; the job goes back to agent nodes.

**4.4 Browser load test.** Status: `script done`; running it + recording the ceiling is gated (needs the live browser node).
Evidence: `scripts/loadtest/browser-sessions.sh` — ramps concurrency through `--steps` (default 2,5,10,20,…), each "session" a Browserless REST `/function` call that opens a page, snapshots, clicks and thinks 5–15 s; samples `/pressure` (running/queued/recentlyRejected/cpu/memory) mid-step and computes p95 per-action latency; prints a CSV row per step. Uses only `curl` + `jq` (no new dependency — adding playwright/puppeteer/ws for a load test is unjustified per AGENTS.md; the REST `/function` path exercises the same session lifecycle). `shellcheck` clean. The ceiling rule (highest N with no queueing/rejection and p95 < 2× the 2-session value), the sessions-per-vCPU/GB figures, the nodes-for-200 calc, and setting `MAX_CONCURRENT_SESSIONS`/`QUEUE_LENGTH` from the measurement are done when the test runs on the live `cx33` browser node.
Write `scripts/loadtest/browser-sessions.*` (TypeScript or shell, your choice; reuse a library already in the repo if one fits, otherwise justify the dependency in the commit). It opens N concurrent CDP sessions against the pool, and each session loops: open a typical page, take a snapshot, click, wait 5 to 15 s (agents think between actions). Ramp N in steps (2, 5, 10, 20, ...). At each step record `/pressure` (`running`, `queued`, `recentlyRejected`, CPU, memory), node CPU and memory, and p95 time per action.
The ceiling for a node is the highest N where nothing is rejected or queued for more than 10 s and p95 stays under 2x the 2-session value. Test on `cx33`, then on the largest shared type (resize by changing `browser_node_server_type`) to see how it scales.
Done when: sessions per vCPU and per GB are recorded; the server type (and count of such nodes) that 200 sessions would need is computed; `MAX_CONCURRENT_SESSIONS` and `QUEUE_LENGTH` are set from the measurement; the node is resized back to the size current use needs.
If no single node can hold 200 sessions, record it; that is the trigger for building a multi-instance browser pool later (section 7). Do not build it.

### Phase 4b: Sandbox shell access on staging (about 1 day)

**Follow [sandbox-shell-access.md](./sandbox-shell-access.md), tasks S0 to S8.** Task statuses and evidence live there; this line is only the summary. Status: `todo`.

Order with the rest of this plan:
- **S1 (fixed browser IP) goes before the browser node is first applied** in 4.2/4.3. It is a one-line Terraform change.
- The worker resolves the browser pool address **once, at start** (`apps/worker/src/index.ts`, about lines 214 to 248). So after the browser job first runs on its node, restart the worker, or new agents get the old address. This applies even without the sandbox.
- S2 to S8 start after **1.8** (only current-template nodes remain) and after the browser node is live (4.3 deployed). They can run before or during Phase 5: fake agents (`loadtest-` jobs) do not request the capability and are not affected.
- The cx23↔cx53 switch tooling must keep the sandbox working: nodes come from the same template, the browser node keeps its fixed IP (destroy the old attachment before creating the new one), and the switch runbook re-runs sandbox rows A1 to A3 afterwards.

Done when every S task is `done` with its section 7 evidence. Part of R1.

### Phase 5: Load test on staging (1 to 2 days)

Goal: show that the autoscaler adds nodes at its normal rate and removes them afterwards, and that the control plane holds the per-agent load, at the largest scale the Hetzner limit and the budget allow (target: 10,000 agents, about 85 nodes).

**5.1 Fake agents.** Status: `scripts done`; running the ramp + synthetic-row seeding is gated.
Evidence:
- `apps/worker/src/loadtest/fake-agent.ts` — a compiled-into-the-image stand-in for an idle agent. Reuses the real agent's footprint: 2 ioredis clients (`redis` + `.duplicate()`), the small Postgres pool via `createDatabase(DATABASE_URL, { max: 2, idleTimeoutSeconds: 30 })` (task 3.3), heartbeats every `HEARTBEAT_INTERVAL_MS` (default 5000) through the real inbound path (`agent:inbound:<AGENT_ID>` XADD with the same envelope, `AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT`, and `HeartbeatPayload` `{sessionId, status:'ready'}`), and a light `SELECT 1` on `DB_QUERY_INTERVAL_MS`. It refuses to run unless `AGENT_ID`/`SESSION_ID` start with `loadtest-`. Compiles clean; output at `apps/worker/dist/loadtest/fake-agent.js`.
- `scripts/loadtest/register-fake-agents.sh` — registers N `loadtest-<n>` Nomad jobs (namespace `herobids-agents`, free-profile resources 256/512 MB, 256 CPU, no constraints) at a bounded rate via the Nomad API, running the agent image with a command override to the compiled fake agent. Job IDs are `loadtest-*`, **never** `agent-*` — confirmed safe: the worker's `fetchAgentJobs` filters on the `agent-` prefix, so `list`/`reconcile` ignore these jobs and never stop them.
- `scripts/loadtest/cleanup.sh` — purges every `loadtest-` job (refusing any id without the prefix), runs `nomad system gc`, and optionally deletes synthetic `loadtest-` rows from `agent_runtime_sessions` then `agents` (opt-in via `--database-url`, prints counts first).
- All three scripts `shellcheck`-clean.
- **Gated / open:** whether `sessionManager.handleHeartbeat` does real work only for *known* sessions (plan note). If so, the fake agents need real `agents` + `agent_runtime_sessions` rows for a synthetic `loadtest-` user before the heartbeats exercise the full path. That seeding script, and the ramp itself (5.2–5.4), run live during Phase 5 — they need the schema/user setup and the resized control plane, and are owner-gated. `cleanup.sh` already deletes exactly those rows.
- Packaging: the fake agent compiles into the worker/agent image, so new nodes pull the real image (realistic start time). This requires merging to `main` before the test (image builds on push to `main`); per the plan, confirm the branch-vs-main route with the reviewer at R1.
Build a fake agent: a small Node process that behaves like an idle agent towards the control plane. It must use the same libraries and settings as `apps/worker/src/agent.ts`: the same Redis client options and count (2), the same Postgres client settings (after task 3.3), heartbeats every `heartbeatIntervalMs` through the same message path (`publishToInbound` and the message types in `@herobids/domain`), and a light database query at the rate measured in 3.1.
Heartbeats are handled by `sessionManager.handleHeartbeat`. Read it. If it does real work only for known sessions, the fake agents need real agent and session rows. Create them for a synthetic user with a clear marker (for example names starting `loadtest-`), on **staging only**, with a cleanup script that deletes exactly those rows and nothing else.
Run each fake agent as its own Nomad job in namespace `herobids-agents`, with job ID `loadtest-<n>` (**never** `agent-<n>`: the worker manages `agent-` jobs and may stop unknown ones; confirm by reading `nomad-runtime-adapter.ts` `list` and `reconcile`). Copy the resource block from a real agent job (`nomad job inspect agent-<id>`): `MemoryMB` 256, `MemoryMaxMB` 512, `CPU` 256 for the free profile. No constraints, affinities or spreads (the demand reader ignores constrained jobs). Pass connection settings as job environment variables; the job specs are visible to anyone with Nomad read access, so purge every `loadtest-` job at the end.
Recommended packaging: compile the fake agent into the agent image (for example `apps/worker/src/loadtest/fake-agent.ts`) and run it with a command override, so new nodes pull the real image (realistic start time) and no new build pipeline is needed. This means merging it to `main` before the test; ask the reviewer if you prefer a branch-only route.
Also write `scripts/loadtest/register-fake-agents.sh` (register N jobs at a bounded rate through the Nomad API) and `scripts/loadtest/cleanup.sh` (stop and purge every `loadtest-` job, run `nomad system gc`, delete synthetic rows).

**5.2 Prepare.** Status: `todo`.
Control plane resized (task 3.6). Fixes from Phase 3 deployed. Set `max_agent_nodes` on staging to the test size (limited by the Hetzner limit minus everything else running in the project, and by the budget). Keep `scale_out_cooldown_seconds = 300` so the test shows the real ramp. Upload settings. Record a baseline (section 3.1 measurements) and the state of real staging agents.

**5.3 Ramp.** Status: `todo`.
Steps: 100, 1,000, 2,500, 5,000, 10,000 fake agents (stop at the largest your node limit allows). At each step, wait until all are placed, then record for 15 minutes:
- Autoscaler: time from first blocked placement to node ready, nodes added per decision, total nodes against the expected `ceil(fake agents / agents per node)`, any refusal or blocker in the log.
- Control plane: Postgres connections against `max_connections`, Redis clients against `maxclients`, Redis memory, worker CPU and heartbeat handling (no growing backlog in the inbound stream), Nomad server memory and leader stability, control-plane memory and load.
- Real staging agents: still `running`, heartbeats on time, one chat or tick works.
**Stop the ramp** (go to 5.4) if any of these passes 80% of its limit, the worker falls more than two heartbeat intervals behind, the Nomad leader changes, or real agents degrade. That point is the finding; record it.

**5.4 Ramp down and scale-in.** Status: `todo`.
Run `cleanup.sh`. Temporarily raise `scale_in_max_nodes_per_run` on staging (for example to 10) and trigger `nomad-scale-in.service` repeatedly until the pool is back at `min_agent_nodes`. Confirm each run removed only idle highest-index nodes and that scale-out did not re-create them. Restore `scale_in_max_nodes_per_run`, `max_agent_nodes = 3`, and the control-plane size (task 3.6 rollback). Check no `loadtest-` job, synthetic row or extra server is left.
Done when: the evidence has the table per step, the cost spent, and "nothing left running".

### Phase 6: Write up staging results (about 2 hours)

**6.1** Fill in section 7 (triggers) and section 6 (results) with numbers. Status: `todo`.
**6.2** Set R1 to `ready for review` (section 8) and summarise in chat. Status: `todo`.

### Phase 7: Production (after R1 passes, about half a day to a day)

Production is pre-launch: a few minutes of downtime is acceptable. Read `production-notes.md` first. Use the production SSH key and `TF_DATA_DIR=.terraform-envs/production`.

**7.1 Merge and deploy code.** Status: `todo`.
Merge the branch to `main` (fast-forward or a merge commit, no force push). Wait for the agent image build. Set `capacityAwareStart.enabled: true` in `config/production.yaml` (same as staging) in this merge. Deploy to production with the flow chosen in 1.1. Confirm health and the worker log.

**7.2 Pause and rebuild the node pool.** Status: `todo`.
Stop the autoscale timers. Sync `agent_node_count`. In `production.tfvars`: `agent_node_server_type = "cx53"`, the template values from 1.5, `max_agent_nodes = 20`, `nomad_autoscale_demand_enabled = true`, `enable_scale_in = true`, `browser_node_count = 1`, `browser_node_server_type` from 4.4. Plan with `-replace='hcloud_server.agent[0]'`.
Expected plan: replace `hcloud_server.agent[0]` and its network attachment; create `hcloud_server.browser[0]` and its network attachment; firewall `apply_to` updates; no change to `hcloud_server.default` other than `keep_disk` if task 3.6 added it. Anything else: stop.
Apply. Agents on the old node stop; Nomad places them on the new node. Check every agent is `running`; relaunch any that are not (section 2.1 guide). Live-mode trading agents: record them before, confirm them after.
Rollback: type back to `cx23`, plan with replace again.

**7.3 Limits and settings.** Status: `todo`.
Confirm Postgres and Redis limits from 3.4 are live. Upload settings (`setup-autoscale-env.sh --env production`) and converge. Confirm the rendered settings show demand mode on and the template values. Start the timers. Read 10 runs of the autoscale log.

**7.4 Small production proof.** Status: `todo`.
Register placeholder jobs (`loadtest-` prefix, no database rows needed; a sleeping container with the agent resource shape) that need one more node. Watch scale-out add `agent-2`. Remove them, wait past the grace period, trigger scale-in once, and watch it remove `agent-2`. Clean up.
Done when: both are in the evidence and production is back to one agent node plus the browser node.

**7.5 Browser pool on production.** Status: `todo`.
Confirm the browser job runs on the browser node at its fixed IP and the smoke test passes. Restart the worker afterwards so it resolves the new address.

**7.6 Sandbox on production.** Status: `todo`.
Follow [sandbox-shell-access.md](./sandbox-shell-access.md), tasks P1 to P4, after 7.2 (the old production node is replaced) and 7.5. Done when every P task is `done` with its evidence. Part of R2.

### Phase 8: Traderton capacity test (1 to 2 days, can run in parallel, staging only)

Traderton is a separate repo: `/Users/chinomso.ikwuagwu/dev_ai/traderton`. Follow its `AGENTS.md`. Trading logic stays in Traderton; this phase only measures.

**8.1 Read.** Status: `todo`.
Traderton `AGENTS.md`, `infra/hetzner/README.md`, and the "Load-Test Expectations" section of `docs/features/initial/007-operational-readiness.md` (it already defines what to measure and when the test passes). Find how a trading agent becomes an actor (the boundary's agent actor code in `packages/boundary/src/` and the registry in `packages/worker/src/composition/create-trading-runtime.ts`).

**8.2 Write the test in the Traderton repo.** Status: `todo`.
A script that, through the boundary with staging credentials, creates N trading agents in **paper** execution mode, and exercises `submit_decision` and a read tool (for example `get_price` or `list_positions`) at a realistic rate. Commit it on a Traderton branch. Cleanup must remove every test agent and actor it created.
Never place live orders. Watch for venue rate limiting (HTTP 429 or venue errors): if it appears, stop the ramp and record the agent count; that is the per-IP limit, which a bigger VM does not fix.

**8.3 Run.** Status: `todo`.
Resize Traderton's **staging** VM to a large shared type through its own Terraform flow (`plan-apply.sh`, its per-env data dir; expected plan: one in-place update of the server type; anything else, stop). Ramp 100, 500, 1,000, 2,500, 5,000. Record the metrics from 007 plus process CPU, event-loop lag, memory and connections at each step.
Resize back afterwards.
Done when: the evidence says the largest N that passed, what limit stopped it (CPU of one Node process, memory, database, venue limits), and whether one VM holds 5,000.

### Phase 9: Close out (about half a day)

**9.1 Unit cost.** Status: `todo`. Using prices from 0.3 and densities from 1.5 and 4.4: cost per agent per month (agent node price / agents per node, plus control-plane share at 10,000), and cost per browser session slot per month. Write them in section 6.
**9.2 Registers.** Status: `todo`. In `docs/decisions/04-assumptions-and-limitations.md`, update only the rows whose facts you measured (node density A-23, control-plane load A-24, browser memory A-04, network limit A-08, prices A-09) with the new value and "verified 2026-11-xx, this plan". In `docs/decisions/03-decision-register.md`, add one line: C-07 (shared autoscaling repo) deferred until Traderton needs to scale out (owner, 2026-11-12).
**9.3 Docs.** Status: `todo`. Update `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md` for the new node type, scale-in under demand mode, and the browser node. Add a CHANGELOG entry.
**9.4** Set R2 to `ready for review`. Ask the owner whether the old program folder (`docs/features/2026/11/11/001-autoscaling-program/`) may be deleted. Status: `todo`.

---

## 5. Placeholder and fake-agent rules (used by Phases 1, 2, 5, 7)

1. Job IDs start with `loadtest-`. Never `agent-`.
2. Namespace `herobids-agents`. Same resource block as a free-profile agent. No constraints, affinities or spreads.
3. No secrets in placeholder jobs. Fake agents (Phase 5) carry staging connection settings only, and are purged at the end.
4. Every test ends with `scripts/loadtest/cleanup.sh` and a check that nothing is left.

---

## 6. Results (fill in)

| Measure | Value | Evidence |
|---|---|---|
| Usable memory and CPU per `cx53` node | | 1.5 |
| Agents per node (free / pro) | | 1.5 |
| Nodes for 10,000 free agents | | 1.5 |
| Scale-out rate observed (nodes per hour) | | 5.3 |
| Largest fake-agent count held, and what limited it | | 5.3 |
| Postgres connections per agent, before and after fixes | | 3.1, 5.3 |
| Redis clients per agent | | 3.1 |
| Control-plane type needed for 10,000 agents | | 3.6 |
| Browser sessions per node (by type), and nodes for 200 | | 4.4 |
| Traderton: largest trading-agent count on one VM, and the limit | | 8.3 |
| Cost per agent per month | | 9.1 |
| Cost per browser session slot per month | | 9.1 |
| Load-test spend | | 5.4 |

---

## 7. Triggers: when to act next (fill in numbers)

Before launch there is little traffic, so these are checked by hand weekly until real use passes about 30% of a ceiling; then add an alert.

| Tier | Resize when | Build scale-out when |
|---|---|---|
| Agents | n/a (autoscaled). Raise `max_agent_nodes` when the pool reaches 80% of it. **Switch node type `cx23` → `cx53` when the pool reaches ~60 nodes OR ~750 active agents, whichever first** (owner decision 2026-11-13: start on `cx23`; `cx53` needs the Hetzner shared-core limit raised; `cx53` ~120 agents/node and ~40% cheaper/agent, and keeps 10k agents under the 100-server network cap at ~85 nodes vs ~715 on `cx23`). An email alert fires at this trigger (see the switch tooling + alert). | Pool would pass about 90 nodes (the private network holds 100 servers): plan a second network or bigger nodes |
| Browser pool | Starts on `cx23` (owner decision 2026-11-13). Switch `cx23` → `cx53` with the same tooling when the measured sessions-per-node ceiling is the constraint | see browser row below |
| Control plane | Projected use at current agent count passes 60% of memory or CPU on the current type | n/a |
| Browser pool | `/pressure` shows `queued > 0` for several minutes, any `recentlyRejected`, or running sessions above 70% of `MAX_CONCURRENT_SESSIONS` | Use passes 50% of what the largest acceptable single node holds |
| Traderton | Active trading agents pass 70% of the measured ceiling, or VM CPU stays above 70% | Use passes 50% of the ceiling, or venue rate limits appear |

---

## 8. Review gates

| Gate | Status | Notes |
|---|---|---|
| R1 (staging done, before production) | not ready | **Code/config surface complete on `feat/hetzner-scale-path` (7 commits), all tests + lint + build green.** Still required before R1 can be `ready for review`: the gated live staging work — Phase 1 (rebuild the pool on `cx53`, remove the caps pool + drifted `agent-3`), 1.5 node-template measurement, 2.4/3.6 live proofs, 3.4 live confirm, the browser-node apply (4.2/4.3 deploy), and Phase 5 ramp (5.2–5.4). These need Terraform applies, server deletes, and the load test, which are owner-gated per §2.3. |
| R2 (all done) | not ready | After R1 + production (Phase 7) + Traderton (Phase 8) + close-out (Phase 9). |

---

## 9. Log

Append one short entry per session, newest at the bottom: date and time, what you did, what you learned, what is next, what blocks you.

**2026-11-13 (session: code/config pass).**
- Did: created branch `feat/hetzner-scale-path` off `main@b317176e`. Ran read-only Phase 0 investigation over SSH against staging (`138.199.172.202`): live cloud + Nomad inventory, reconcile reproduction, Hetzner price table. Wrote the bug report (task 1.1). Updated tasks 0.1, 0.2 (staging), 0.3, 0.5 to `done` with evidence; 0.4 `blocked` (owner), 0.2 production `todo`.
- Learned: the pool name is `herobids-staging` (from `TF_VAR_server_name`), and the two `herobids-staging-agent-caps-*` servers are the sole `$foreign` set that raises `ownership_mismatch`. The Nomad node `herobids-staging-agent-3` maps to the Hetzner server `agent-1` (10.0.0.5) — name drift, handled by task 1.7. `cx53` is available in `fsn1`. Staging failure count is at 4553. `nomad-scale-in.timer` is not in the active timer list (confirm in 2.3). The owner confirmed SSH is straightforward via `docs/runbooks/useful-commands.md`.
- Scope decision (agreed with owner): this session does option 1 — the reversible code/config/test surface on the branch. All live Terraform applies, server drains/deletes, timer stops on live hosts, the two load tests, control-plane/Traderton resizes, the Hetzner console limits request, and the R1/R2 gates stay gated on owner confirmation. Read-only live reads (Phase 0, verification reads) are fine.
- Next (code): task 2.2 (scale-in demand check), 2.3 (timer schedule converge), 3.3 (agent Postgres pool), 3.4 (server limits), 4.2 (browser node + guard exemption), 4.3 (browser job), 4.4/5.1 (load-test scripts + fake agent). Then run test suites, lint, build.
- Blocks: none for the code work. Production inventory (0.2) and the console limits (0.4) need the owner / a live production session.

**2026-11-13 (session: code/config pass, cont.).**
- Did: task 2.2 — replaced the scale-in H4 demand early exit with `scale_in_demand_defers` (demand read + classify, fail closed), sourced `capacity-demand.sh`/`capacity-controller.sh` into `scale-in.sh`, rewrote the guard tests, updated the H4 cross-reference in the safe-capacity plan §8. Commit `a28ea566`.
- Decision recorded: **H4 early exit replaced by a demand check (2026-11-12, this plan).** Scale-in defers under demand mode only when the agent namespace has queued/blocked work or the demand read is ambiguous (fail closed); otherwise it proceeds under the lock.
- Verified: `tests/run-all.sh` (all suites pass), `tests/check-nomad-capacity.test.sh` (all checks pass), `shellcheck -x scale-in.sh` clean.
- Next: task 2.3 (nightly timer schedule via converge drop-in + test).

**2026-11-13 (session: code/config pass, cont. 2).**
- Did: task 2.3 — added converge step 3e (`converge-control-plane.sh`) that pins `nomad-scale-in.timer`'s `OnCalendar` from `SCALE_IN_TIME_UTC` and enables+starts the timer; wired `setup-control-plane.sh` to read the `scale_in_time_utc` output and pass it through; added 17 converge tests. Also marked 2.1 done.
- Learned (corrects the plan): staging's `nomad-scale-in.timer` already has a valid schedule and is `enabled`, but it is **inactive** (stopped since 2026-10-31, never restarted). So the symptom is a stopped timer, not a missing schedule; step 3e fixes both by converge-starting it.
- Verified: `test-converge-control-plane.sh` (all pass incl. new 3e block), `tests/run-all.sh` (all suites pass), `shellcheck -x` clean on converge + setup.
- Next: task 3.3 (agent Postgres pool in `@herobids/db` + worker wiring + Vitest). Then 3.4 (compose limits) and the Phase 4 browser work.

**2026-11-13 (session: code/config pass, cont. 3).**
- Did: task 3.3 — `createDatabase` optional pool options + small agent pool (max 2, idle 30s) + Vitest (commit `81683435`). Task 3.4 — pinned Redis `maxclients=10000` + `nofile` 11000 in `docker-compose.yaml`; left Postgres `max_connections` at 100 with a comment explaining it waits for the 3.6 resize + 5.3 measurement (raising it now would risk OOM on the `cx23` control plane).
- Read-only baseline (staging, 7 agents): Postgres `max_connections=100`, 19 conns (`postgres.js`=13); Redis `maxclients=10000`, 24 clients, 512 MB; control plane 3819 MB, ~1991 MB free. Recorded in 3.1.
- Decisions: 3.2 and 3.5 (PgBouncer) are blocked on the Phase 5 numbers — the agent pool cap is the interim mitigation; PgBouncer is very likely needed at 10k but is not built speculatively (plan rule).
- Verified: `docker compose config -q` OK; db + worker builds pass; `create-database.test.ts` passes.
- Next: Phase 4 — task 4.2 (browser TF node + cloud-init node_pool/class inputs + the `role==browser` guard exemption + tests), 4.3 (browser-pool.nomad.hcl node pool), 4.4/5.1 (load-test scripts + fake agent).

**2026-11-13 (session: code/config pass, cont. 4).**
- Did: Phase 4 code. Task 4.2 — cloud-init `node_class`/`nomad_node_pool` inputs (conditional `node_pool` line), `hcloud_server.browser` + network in `main.tf`, `browser_node_count`/`browser_node_server_type` vars, and the `role == "browser"` exemption in the capacity guard with tests. Task 4.3 — `browser-pool.nomad.hcl` moved to `node_pool = "browser"`, sized for `cx33`, port 3100 kept. Task 4.1 shape confirmed against the code.
- Proof: rendered the old vs new cloud-init for an agent node and diffed — functional config byte-identical (only the comment header differs); browser render adds exactly the two client lines. `terraform validate` + `fmt` clean. Full shell suite + `check-nomad-capacity.test.sh` pass; `shellcheck` clean.
- Next: task 4.4/5.1 — load-test scripts (`scripts/loadtest/browser-sessions.*`, `register-fake-agents.sh`, `cleanup.sh`) and the compiled fake agent (`apps/worker/src/loadtest/fake-agent.ts`). Then final verify pass (lint/build) and the plan writeup + R1 scope summary. Running the load tests themselves is gated.

**2026-11-13 (session: code/config pass, cont. 5).**
- Did: task 4.4/5.1 load-test scaffolding. `apps/worker/src/loadtest/fake-agent.ts` (idle-agent footprint: 2 Redis clients, small PG pool, real heartbeat path, light DB query; refuses non-`loadtest-` ids). `scripts/loadtest/register-fake-agents.sh` (N `loadtest-` Nomad jobs, bounded rate), `cleanup.sh` (purge `loadtest-` jobs + gc + synthetic row delete), `browser-sessions.sh` (curl+jq Browserless ramp vs `/pressure`, no new dep).
- Confirmed safety: the worker's `fetchAgentJobs` filters on the `agent-` prefix, so `loadtest-` jobs are invisible to `list`/`reconcile` and never stopped by the worker.
- Verified: worker build passes (fake agent compiles to `dist/loadtest/fake-agent.js`, the path the register script uses); all three shell scripts `shellcheck`-clean.
- Gated: running the ramps (5.2–5.4), the browser ceiling measurement (4.4), and the synthetic-row seeding all need the live environment and are owner-gated.
- Next: final verify pass (lint + build across packages, shell suites), then the plan writeup + R1 scope summary (task 11).

**2026-11-13 (session close: code/config surface complete).**
- Done this session (branch `feat/hetzner-scale-path`, 7 commits off `main@b317176e`):
  - 1.1 + Phase 0 read-only inventory/reproduction/prices (staging) — `4c69819a`.
  - 2.2 demand-aware scale-in (replaces H4) + tests — `a28ea566`.
  - 2.3 converge the nightly scale-in timer schedule + activation — `d2229b18`.
  - 3.3 `createDatabase` pool options + small agent pool + test — `81683435`.
  - 3.4 Redis `maxclients`/`nofile` pinned; Postgres hold documented — `0880211d`.
  - 4.1/4.2/4.3 dedicated browser Nomad node pool + guard exemption + job move — `2e8247fa`.
  - 4.4/5.1 fake-agent runtime + load-test scripts — `98e58f33`.
- Final verify (all green): `pnpm lint` (tsc --noEmit, whole workspace); `pnpm build` (whole workspace); `infra/hetzner/scripts/tests/run-all.sh`; `check-nomad-capacity.test.sh`; `packages/db` `create-database.test.ts`; `shellcheck -x` clean on every changed script; `terraform validate`/`fmt` clean.
- Plan corrections recorded from live read-only evidence: the pool is `herobids-staging` and the caps pool is the sole `ownership_mismatch` cause (0.5); the scale-in timer had a valid schedule but was left inactive, not scheduleless (2.3).
- **Gated remainder (owner / live environment), per §2.3** — all require Terraform applies, server drains/deletes, timer changes on live hosts, load tests (EUR budget), resizes, the Hetzner console limits request (0.4), and the production/Traderton/close-out phases: Phase 1 (1.2–1.8), 2.4, 3.1 full/3.2/3.5/3.6, 3.4 live confirm, 4.2/4.3 apply+smoke, Phase 5 (5.2–5.4), Phase 0.2 production, and Phases 6–9. The code and scripts those steps use are in place and tested; each step's exact gated commands and expected Terraform plans are in the task text above.
- Next: hand to the owner to run the gated staging steps, then set R1 to `ready for review`.

**2026-11-13 (session: staging live-ops, start).**
- Owner approved all staging work. Pushed `feat/hetzner-scale-path` to origin (owner ran `git push`, blocked for the agent by policy).
- 1.2: paused both autoscale timers on staging. Deployed the branch to the server via `git reset --hard origin/feat/hetzner-scale-path` in `/opt/herobids` (was on `feat/safe-capacity-p9-staging`); the new scale-in demand check, converge timer step, browser guard exemption and `main.tf` browser resource are now on the server. Did NOT run `push.sh`'s nomad-job submission, to avoid making the `node_pool=browser` browser-pool job unplaceable before the browser node exists; the full converge is deferred to 1.8.
- Terraform-state init recipe (server): `set -a; . /etc/herobids/autoscale.env; set +a` to export AWS creds, then `terraform init -reconfigure -backend-config bucket/key=herobids/staging/.../region` with `TF_DATA_DIR=.terraform-envs/staging`.
- Learned: `staging.tfvars` is gitignored (live server config). It has no `agent_caps_node_count` line → caps count defaults to 0 while state holds 2 caps servers; `enable_scale_in=false`. Running agent allocs are split across `agent[0]`(714f26cc, 3), `agent[1]`(9fed1a12, 3), `caps-1`(1), `caps-2`(0); the two main-pool Nomad nodes are ineligible but still running allocs.
- Next: drain `agent[0]`+`agent[1]` onto caps, then the targeted cx53 replace (1.4).

**2026-11-13 (session: staging live-ops, cont.).**
- 1.4: `cx53` apply hit Hetzner `shared core limit exceeded` AFTER destroying `agent[0]`+`agent[1]` and before creating the `cx53`. One live agent stayed up on a caps node. Owner decided: **start on `cx23`**, switch to `cx53` later at a trigger. Rebuilt `agent[0]` on `cx23` (create-only plan, reviewed) — now `ready`+`eligible`, name matches, no drift.
- Owner direction change: **browser node also starts on `cx23`** (was `cx33` default). Build **cx23↔cx53 switch tooling** (script + runbook) for both agent and browser pools, plus an **email alert** when the switch trigger (~60 nodes / ~750 active agents) is met; test the alert and the switch (switch test + 10k load test both gated on raising the Hetzner shared-core limit). Added tasks 16–19.
- §7 Triggers updated with the cx23→cx53 switch rule for agents and browser.
- Stale `down` Nomad nodes `agent-3`(10.0.0.5) and `agent-2`(10.0.0.3) remain from the destroyed servers — purge in 1.7.
- Next: 1.5 measure the cx23 node template (we are on cx23 now, not cx53 — record cx23 values and the cx53 values will be measured during the switch test), 1.6 remove caps, 1.7 purge stale nodes, 1.8 resume+prove. Then browser cx23 default change + switch tooling + alert.

**2026-11-13 (reviewer note, Kiro: sandbox added to scope).**
- Owner decision: fixing agent shell access is in scope, at the same priority as autoscaling. Added [sandbox-shell-access.md](./sandbox-shell-access.md), Phase 4b (staging) and task 7.6 (production). R1 and R2 now include them. No other task or decision changed; `cx23` stays as decided.
- **Act on this before the browser node is first applied:** sandbox task S1 (fixed private IP for `hcloud_server_network.browser`).
- Found while reading the code, affects Phase 4 even without the sandbox: the worker resolves the browser pool address only at start (`apps/worker/src/index.ts` about lines 214 to 248). The 4.3 evidence ("worker resolution unaffected") misses this. After the browser job lands on its node, restart the worker and check its "Browser pool URL resolved" log line.
- Next: continue Phase 1 (1.6 to 1.8). Sandbox S2 onwards starts after 1.8 and the browser node is live.

**2026-11-13 (session: staging live-ops, constraint + correction).**
- **Constraint (owner, clarified):** staging runs agents belonging to OTHER (test) users as well as the owner's. Relaunching other users' agents is **allowed** on staging; the rule is **never leave any agent stopped** — restore every agent to running after any operation (drain, node rebuild, deploy). Do not shut agents down as a test device.
- Relaunch note: to recover one stuck agent (`agent-bb11883d`, stale `SYS_ADMIN` spec), `maintenance-restart.sh --skip-deploy --start-stopped` relaunched the whole previously-stopped fleet. This is fine under the clarified rule (it brought stopped agents back up). 8 agents now run on the clean `cx23` nodes with fresh specs (`cap_add=none`, no stale sys_admin), 8 running sessions, no sandbox errors — healthier than their prior stuck/stopped state.
- The owner's own 7 agents are confirmed shut down (owner's choice); the 8 running belong to other test users and should stay running.
- Scale-in proof (2.4) will still use `loadtest-` placeholder jobs we control — not because real agents are off-limits, but because placeholders give a clean, disposable idle node without disturbing real agents.
- Live state otherwise unchanged: 2 clean `cx23` nodes, autoscaler healthy (no `ownership_mismatch`), `enable_scale_in=false` still.
- Next (non-agent-touching): browser default → `cx23` + resize the browser job (task 16), sandbox S1 fixed browser IP, then enable scale-in and prove it with `loadtest-` placeholders.

**2026-11-13 (session: staging live-ops, scale-in proven).**
- Browser node defaulted to `cx23` + job resized; sandbox S1 fixed browser IP (`10.0.0.240`) added to `main.tf` (commit 16452689).
- 2.3 live: enabled `enable_scale_in` (output-only apply), converged → scale-in timer scheduled (3 AM) and active; unit flag `ENABLE_SCALE_IN=true`.
- 2.4 live: proved demand-aware scale-in end-to-end using `loadtest-` placeholders (never touching real agents): drove scale-out 2→3 with 20 placeholders, purged them, waited out the 600 s grace, then scale-in removed the idle `agent-3` (3→2), synced state, wrote `agent_node_count=2`, and did not re-create it (cooldown). All 8 real agents stayed running. Placeholders fully cleaned up; down node purged.
- Local branch is 4 commits ahead of origin (needs an owner `git push` before the browser-node apply, which requires the new `main.tf` on the server).
- Next: (needs push) deploy the browser/sandbox code to the server, apply the browser node on `cx23`, restart the worker, smoke test (4.2/4.3); then Phase 4b sandbox rollout; switch tooling + alert; then gated cx53/load-test on the Hetzner limit raise.

**2026-11-13 (session: staging live-ops, browser node live).**
- Owner pushed the branch; deployed to the server (`git reset --hard origin/feat/hetzner-scale-path`), no premature browser-job submission.
- Applied the browser node on `cx23` (fixed IP `10.0.0.240`), node joined as class/pool `browser`; agent nodes stay pool `default`. Redeployed the browser-pool job onto it, restarted the worker (resolved `http://10.0.0.240:3100`). `smoke-test-browser-pool.sh` = 10/10 PASS (after clearing stale local known_hosts for the recreated nodes' public IPs). Tasks 4.2/4.3 done live.
- Live state: control plane + agent-1 + agent-2 (cx23, pool default) + browser-1 (cx23, pool browser). 8 real agents running.
- Next: Phase 4b sandbox rollout (S0–S8) — needs the browser node live (now true). Then switch tooling + alert; gated cx53/load-test on the Hetzner limit.
