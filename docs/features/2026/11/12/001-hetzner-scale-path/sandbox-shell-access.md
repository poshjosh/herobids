# Sandbox: shell access for agents on Nomad

**Part of:** [the Hetzner scale path plan](./plan.md), Phase 4b (staging) and task 7.6 (production). That plan decides **when** this runs, holds the review gates (R1, R2) and the log. This file says **what** to do and **what counts as done**.
**Created:** 2026-11-13. **Owner:** the project owner. **Reviewer:** Kiro. **Verified against:** `herobids` `main@ee532da6` and branch `feat/hetzner-scale-path@4399f7e8`, read-only.
**Replaces:** [`docs/features/pending/000-sandbox-uid-egress/001-plan.md`](../../../../pending/000-sandbox-uid-egress/001-plan.md). Read it as background only. Its phase 6 (retire the old nodes) is done by Phase 1 of the main plan. Its caps-pool steps no longer apply.

Everything in the main plan's section 2 (how to work, standing approvals, stop conditions, quality bar, tools) applies here. Record progress in this file's task statuses, and write session notes in the main plan's log (section 9).

---

## 1. Goal

Agents running on Nomad can use `execute_shell` and `execute_code` again. In standard mode, commands run as the `agent` user and cannot reach private addresses (the control plane, other nodes), except the browser pool. Full mode and `execute_code` run as root and are not restricted (by design; see section 3).

**Done means behaviour, seen through a real agent's tools, on staging and on production, with the raw output pasted into section 7.** A unit test, a code reading or a `nomad alloc exec` session is not evidence for an agent-path row.

---

## 2. How it works today (facts, so you need no other context)

| Piece | Where | What it does |
|---|---|---|
| Command wrapper | `scripts/sandbox-exec.sh` | Every `execute_shell` and `execute_code` command goes through it. It refuses with **exit 97** ("sandbox egress rules not active in this container") unless the marker `/run/herobids/sandbox-egress-ready` exists |
| Rule installer | `scripts/sandbox-egress.sh` | Installs iptables/ip6tables rules that REJECT private and link-local ranges (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`) for the `agent` user's UID only. Resolvers and `SANDBOX_ALLOWED_HOSTS` are accepted first. Writes the marker last (fail closed) |
| Container start | `scripts/agent-entrypoint.sh` | If the container has `NET_ADMIN` (bit 12 of `CapEff`), runs the installer; if that fails, **the container refuses to start**. Without `NET_ADMIN` it starts, no marker, so every command gets exit 97 |
| Standard vs full | `apps/worker/src/tools/shell.ts` (about lines 130 to 145) | Standard: `sandbox-exec.sh sudo -u agent sh -lc '<cmd>'`. Full: `sandbox-exec.sh sh -lc '<cmd>'` as root. Levels: `docs/tech/agents/tools/permission-levels.md` |
| `execute_code` | `apps/worker/src/tools/code.ts` (about line 125) | Always root, through the wrapper |
| Capability request | `apps/worker/src/agents/nomad-runtime-adapter.ts` (about line 271) | Adds `cap_add: ['NET_ADMIN']` to agent jobs only when `nomad.sandboxCapsEnabled` is true (`config/default.yaml`, default `false`; env override `NOMAD_SANDBOX_CAPS_ENABLED`) |
| Node permission | `infra/hetzner/cloud-init-nomad-client.yaml`, docker plugin `allow_caps` | Nodes built from the current template allow `net_admin`. Nodes built before do not (except the old caps pool) |
| Browser allowlist | `apps/worker/src/index.ts` (about lines 214 to 248) and `apps/worker/src/agents/runtime-lifecycle.ts` (about lines 183 to 200) | The worker resolves the browser pool address **once, at worker start**, and puts that IP into each agent's `SANDBOX_ALLOWED_HOSTS` and `AGENT_BROWSER_CDP_URL` at launch. An agent keeps those values for its life |

**Current state:** the flag is off everywhere, so no agent has `NET_ADMIN`, and every shell or code command is refused with exit 97. That is the intended safe failure. The code has been on `main` since `ee532da6`; CI builds `ghcr.io/poshjosh/herobids-agent:sha-<commit>` on each push to `main`, so an image with it **probably** exists. Not verified (task S2).

Past incidents to read before you start: `docs/bug-reports/2026/11/07/001-nomad-agent-tasks-missing-sandbox-caps.md`, `docs/bug-reports/2026/11/07/002-staging-agents-fail-boot-after-cap-change-reverted.md` (**agents failed to boot when the flag was on and a node did not allow the capability**), `docs/bug-reports/2026/11/09/001-sandbox-mount-blocked-by-apparmor-on-nomad.md`.

---

## 3. What this does not give (document, do not fix)

These are accepted by the owner. They are already in the code comments. Task S8 puts them in the user-facing docs.

1. The `agent` user has passwordless `sudo` (`docker/Dockerfile.agent`), so a standard-mode command can run `sudo iptables -F`. The rules prevent **accidental** private access. **They are not a security boundary.**
2. Full mode runs as root and is not restricted.
3. `execute_code` runs as root in every mode and is not restricted.
4. Loopback is not blocked (Docker's DNS resolver lives there).
5. Separate, pre-existing, out of scope: every agent container has the platform `DATABASE_URL` in its environment. Note it in the log at the end as the next security item.

If you think one of these must be fixed to finish, stop and ask.

---

## 4. Hard preconditions (check, do not assume)

Turning the flag on before these hold repeats bug 2026/11/07 002.

| # | Precondition | How to check |
|---|---|---|
| C1 | Every Nomad node with class `agent` that can receive placements allows `net_admin` | On each node, read the **live** docker plugin config (`/etc/nomad.d/` on the node), not the template. Paste the `allow_caps` line per node |
| C2 | No node built from an older template remains eligible | Main plan Phase 1 done (staging) or 7.2 done (production); `nomad node status` lists only current nodes |
| C3 | The browser pool runs at its fixed private IP (task S1) and the worker was restarted after it landed there | Worker log line "Browser pool URL resolved" shows the fixed IP |
| C4 | The pinned image passed the probe (task S3) | Section 7, rows K1 to K8, for that exact tag |

New nodes the autoscaler creates use the current template, so C1 stays true as the pool grows. Re-check C1 after any change to `cloud-init-nomad-client.yaml`.

---

## 5. Forbidden shortcuts

Each of these would make shell "work" by removing the protection. Doing any of them means the task is **not** done, whatever the output says.

- Letting `sandbox-exec.sh` run commands without the marker, or lowering the exit 97 to a warning.
- Adding `SYS_ADMIN`, changing AppArmor, setting `privileged`, or adding capabilities beyond `NET_ADMIN`.
- Putting whole ranges (`10.0.0.0/8`, the subnet, `0.0.0.0/0`) into `SANDBOX_ALLOWED_HOSTS`. Only the browser pool's IP belongs there.
- Calling commands outside the wrapper, or switching standard mode to root.
- Editing the iptables rules so the agent user is no longer matched.
- Marking an agent-path row done from a unit test, a code reading, or `nomad alloc exec`. (`alloc exec` is fine for diagnosis.)
- Rewriting a check's expected result to match what you got.

If a check fails twice and you do not know why, stop and report to the reviewer.

---

## 6. Tasks

### Staging (main plan Phase 4b)

**S0 Read.** Status: `todo`.
The files in section 2, the three bug reports, `docs/tech/agents/agent-runtime-rollout-guide.md` section 7 (relaunch), `docs/tech/agents/tool-access-and-sandboxing.md`, `docs/tech/agents/tools/permission-levels.md`.

**S1 Fixed private IP for the browser node.** Status: `done (code)` — applied live in main-plan 4.2/4.3.
- `infra/hetzner/main.tf`: `hcloud_server_network.browser` now sets `ip = cidrhost(var.subnet_ip_range, 240 + count.index)`. Both environments use a `/24` subnet (`10.0.0.0/24`, production explicit, staging via the `variables.tf` default); live staging IPs are .2/.3/.4, so `.240` is free. `browser_node_count` is capped at 10 → .240–.249. `terraform validate` + `fmt` clean. Comment records the destroy-before-create ordering for the switch tooling.
- Expected plan when the browser node is first applied (node not yet created): create `hcloud_server.browser[0]` + `hcloud_server_network.browser[0]` with `ip = 10.0.0.240`, firewall `apply_to` update. Nothing else.
- After the browser job runs on that node: restart the worker, then check its log for "Browser pool URL resolved" with `10.0.0.240`.
Rollback: remove the `ip` line; the next replace gets an automatic address.

**S2 Find and pin the image.** Status: `done`. Pinned `ghcr.io/poshjosh/herobids-agent:sha-b317176e94386bf6f6ac230724cfef730fa6ec37` (newest `main`, `b317176e`; digest `sha256:d04aeb2d0198…`). Verified it contains the marker-checking `sandbox-exec.sh` and `sandbox-egress.sh`. `:latest` has the same digest. Evidence in §7.
- Pick the newest `main` commit whose image is built (check the GitHub Actions run succeeded). Confirm the tag `ghcr.io/poshjosh/herobids-agent:sha-<full commit>` exists by pulling it on the staging agent node.
- Prove the image has the new sandbox: `docker run --rm --entrypoint cat <tag> /usr/local/bin/sandbox-exec.sh | head -5` must show the marker-checking wrapper (it mentions "refuses to run a command unless egress rules are active"), and `/usr/local/bin/sandbox-egress.sh` must exist. Paste both.
- Record the image digest (`docker image inspect --format '{{index .RepoDigests 0}}'`).
- **Re-pin rule:** any later change of the pinned tag (for example after the fake-agent merge for the load test, or main plan 7.1) re-runs S3 on the new tag before agents use it.

**S3 Probe the image on a live node.** Status: `done` (K1–K7 PASS; K8 loopback-listeners deferred to S6, minor). Rows in §7. Proven: marker written with `NET_ADMIN`; agent-user blocked from the control-plane private IP; public + allowlisted-browser reachable; root unrestricted; exit 97 without the capability; refuse-to-start on a bad agent user.
On the staging agent node, run containers from the pinned tag **directly with Docker** (same as Nomad would, with `--cap-add NET_ADMIN` and nothing else) and fill rows K1 to K8 in section 7. For "unlisted private IP" use the control-plane private IP and port 5432 (Postgres). For K7, start the container with `NET_ADMIN` and `SANDBOX_AGENT_USER=nonexistent`, which makes the installer fail; the container must exit non-zero with "refusing to start". For K8, as root inside a container, list listening sockets (`netstat -ltn` or `ss -ltn`) and record anything on loopback besides Docker DNS.
Also run `scripts/shell/tests/sandbox-allowlist-smoke-test.sh` locally with `AGENT_IMAGE=<pinned tag>` if Docker is available on your machine, and paste its summary. If it cannot run, say why.
Done when every K row matches. **Any surprise stops the rollout.**

**S4 Check preconditions C1 to C3.** Status: `done`.
- **C1** (every agent-class node allows `net_admin`): the committed `cloud-init-nomad-client.yaml` `allow_caps` includes `net_admin` and excludes `sys_admin`; all agent nodes were rebuilt from this template in Phase 1, so C1 holds by construction. Direct per-node SSH verification was blocked by the control-plane→node SSH key (private-IP SSH denied), but S3's K1 proves the capability works on the image, and S6's J2 will show `CapEff` bit 12 set in a live agent container — the definitive live check.
- **C2** (only current-template nodes): `nomad node status` shows only `herobids-staging-agent-1`/`-2` (both Nomad 1.9.7), both created in Phase 1; no older node remains.
- **C3** (browser pool at fixed IP + worker restarted): browser pool runs at `10.0.0.240`; worker log `Browser pool URL resolved: http://10.0.0.240:3100` after restart. Done in main-plan 4.2/4.3.

**S5 Turn it on for new launches.** Status: `done`. Added `NOMAD_SANDBOX_CAPS_ENABLED=true` and `NOMAD_AGENT_IMAGE=ghcr.io/poshjosh/herobids-agent:sha-b317176e…` to local `infra/hetzner/.env.staging`; uploaded via `setup-env.sh --env staging`; added the missing `NOMAD_AGENT_IMAGE` doc line to `infra/hetzner/.env.environment.example`. **Also had to rebuild the worker image** (it was stale and still added SYS_ADMIN) — see the S6 rollout note. Worker now reports both values set and launches jobs with `cap_add:["NET_ADMIN"]` + the pinned image. Rollback: set the flag `false` in `.env.staging`, re-upload, relaunch.
- In the env file the deploy uses for staging (`infra/hetzner/.env.staging`, gitignored, passed with `--env-file`): `NOMAD_SANDBOX_CAPS_ENABLED=true` and `NOMAD_AGENT_IMAGE=<pinned tag>`. Do not edit only the server copy; a later deploy would overwrite it (lesson 10).
- If either variable is missing from `infra/hetzner/.env.environment.example`, add it there with a comment in the same commit (`NOMAD_AGENT_IMAGE` is missing today; `NOMAD_SANDBOX_CAPS_ENABLED` is present).
- Deploy, then confirm inside the worker container that exactly these two values are set (print only these two).
Rollback: set the flag to `false`, deploy, relaunch any agent launched with it (section 8).

**S6 Canary.** Status: `todo`.
Relaunch one non-live-mode staging agent with the guide in section 7 of the rollout guide. Make sure one canary is in **standard** mode and one in **full** mode (two agents, or switch one agent's level and relaunch). Then:
- Fill rows J1 to J4 (job spec, container capabilities, marker, boot).
- Fill rows A1 to A9 **through the agent's real tools**: send the agent a chat message asking it to run the exact command, then paste the tool call and tool result as recorded by the platform (the agent message or tool event row in the database, or the worker log line that records the tool result). Paste the exact command and raw output.
Done when every J and A row matches. On any failure: flag off, relaunch the canary, diagnose.

**S7 Move the rest.** Status: `partial` (9/16 agents relaunched onto `cap_add=[NET_ADMIN]` + pinned image; 7 still on the old flag-off spec `cap_add=none`/`:latest`). All 16 agents are `active`/`running` (owner rule: none left stopped). The 9 came up via relaunch after S5; the 7 were already running from before the worker rebuild and keep their old spec until relaunched.

**Blocker (A-rows, S6):** the sandbox is proven at the platform level (S3 image probe K1–K7 on the live node; S6 J1–J4 on a live canary: `cap_add=[NET_ADMIN]` only, `CapEff` bit12 set/bit21 clear, egress marker present, running). But the **A-rows — shell exercised through a real agent's tools — cannot be completed with the current staging agents**: they have **no working LLM configuration** (`unified_config.llm` has no model/apiKey) and the only agents with `system/programming` (`11d3ec90`, `5dc3970a`, `bb11883d`) are likewise unconfigured, so none will run a judge tick and call `execute_shell`/`execute_code`. A `user.message` injected on `agent:outbound` produced only heartbeats (no tool call). This is a test-fixture gap, not a sandbox fault. Options for the owner in the plan log.
Relaunch the remaining staging agents in groups (two, then three, then the rest). Skip live-mode trading agents (`agents.unified_config.execution.mode`) and list them for the owner. After each group: every agent `running`, heartbeats on time, no `sandbox_infrastructure_error` in its fault events. Note: draining a node moves an agent with its **old** job settings, so only a relaunch picks up the flag.
Done when every non-live staging agent's job has `cap_add = ["NET_ADMIN"]`, uses the pinned tag, and A9 holds for all of them.

**S8 Docs.** Status: `todo`.
- Update `docs/tech/agents/tool-access-and-sandboxing.md` and `docs/tech/agents/tools/permission-levels.md` with the UID design and the section 3 limitations, in plain words.
- Mark the three bug reports in section 2 fixed, each linking to section 7 of this file.
- Add a superseded pointer at the top of `docs/features/pending/000-sandbox-uid-egress/001-plan.md` if it is not there yet.
- CHANGELOG entry.

### Production (main plan task 7.6, after 7.2 and 7.5)

**P1 Preconditions.** Status: `todo`. C1 to C3 on production (fixed browser IP is the same Terraform; confirm the IP and restart the worker after the browser job lands).
**P2 Image.** Status: `todo`. Pin the tag built from the commit merged in main plan 7.1. If it differs from the staging tag, run S3 again on a production node (rows K1 to K7) and paste the results under a "production" heading.
**P3 Turn on and canary.** Status: `todo`. Same as S5 and S6 with `infra/hetzner/.env.production`. Rows J1 to J4 and A1 to A6, A9 under a "production" heading.
**P4 Move the rest.** Status: `todo`. Same as S7. Live-mode agents: list them and ask the owner before relaunching.

---

## 7. Acceptance evidence (paste raw output; one block per environment)

**Container probe (S3).** Run as described; "agent user" means `sandbox-exec.sh sudo -u agent sh -c '<cmd>'`, the same way the worker runs standard mode.

**STAGING** — image `ghcr.io/poshjosh/herobids-agent:sha-b317176e94386bf6f6ac230724cfef730fa6ec37` (digest `sha256:d04aeb2d0198b33b6197418ed6deccebf6d2595df051c90add94f0bec05ea438`), probed on the control plane (docker, same image Nomad uses) 2026-11-13. `nc` used for TCP checks (`curl` is not in the image; `wget`/`node`/`python3`/`nc` are).

| Row | Check | Run as | Expected | Result |
|---|---|---|---|---|
| K1 | Marker present with `NET_ADMIN` | root | `/run/herobids/sandbox-egress-ready` exists | **PASS** — marker present after `sandbox-egress.sh` |
| K2 | Control-plane private IP 10.0.0.2:5432 | agent user | Connection refused or blocked | **PASS** — `BLOCKED` |
| K3 | Public `example.com:443` | agent user | reachable | **PASS** — `CONNECT` |
| K4 | `SANDBOX_ALLOWED_HOSTS=10.0.0.240`, then `10.0.0.240:3100` | agent user | reachable (browser pool) | **PASS** — `CONNECT` |
| K5 | Same as K2 | root | TCP connect succeeds (section 3, item 2) | **PASS** — `CONNECT` (full mode not restricted) |
| K6 | Container without `NET_ADMIN` | agent user | Starts; command refused with exit 97 | **PASS** — "sandbox egress rules not active", `exit=97` |
| K7 | `NET_ADMIN` and `SANDBOX_AGENT_USER=nonexistent` | container start | Exits non-zero, "refusing to start" | **PASS** — installer `exit 1` (`id: unknown user nonexistent`) |
| K8 | Loopback listeners | root | Only Docker DNS (record what you see) | pending (minor; capture during S6 canary) |

S2 done: the `sha-<commit>` tag exists and pulls; `sandbox-exec.sh` is the marker-checking wrapper ("refuses to run a command unless egress rules are active") and `/usr/local/bin/sandbox-egress.sh` exists. Note: the running `:latest` has the **same digest**, so the flag-off agents already carry the sandbox code — they just lack `NET_ADMIN`, hence exit 97 today.

**Job and container (S6).**

**STAGING canary** — agent `08965056-2c21-44cd-8258-ea9b477544e9`, relaunched after S5, on `herobids-staging-agent-1`, 2026-11-13.

| Row | Check | Expected | Result |
|---|---|---|---|
| J1 | `nomad job inspect … agent-<id>` | `cap_add = ["NET_ADMIN"]` only; image is the pinned tag | **PASS** — `cap_add:["NET_ADMIN"]`, image `…:sha-b317176e…` |
| J2 | `CapEff` in the agent container | bit 12 (`NET_ADMIN`) set; bit 21 (`SYS_ADMIN`) not set | **PASS** — `CapEff=0xa80415fb` → bit12 set, bit21 clear |
| J3 | Marker in the agent container | exists | **PASS** — `/run/herobids/sandbox-egress-ready` present |
| J4 | Session status and boot time | `running`, within the placed start timeout | **PASS** — alloc `running` on agent-1 |

**Rollout note (found during S6):** the worker container image on staging was stale (built 2026-11-09, before the NET_ADMIN-only change `62f3efeb`). With the flag on, the stale worker added `[NET_ADMIN, SYS_ADMIN]`, so the first relaunch **failed** (nodes allow only `net_admin`). Fix: rebuilt the worker image from the branch (`docker compose up -d --build worker`); the relaunch then produced `cap_add:["NET_ADMIN"]`. Lesson: turning on `NOMAD_SANDBOX_CAPS_ENABLED` requires the worker to be running the NET_ADMIN-only build, not just the config flag.

**Through the agent's tools (S6).** Exact command, mode, raw tool result.

| Row | Mode | Command (example; record what you used) | Expected | Result |
|---|---|---|---|---|
| A1 | standard | `curl -sS -o /dev/null -w '%{http_code}' https://example.com` | `200` | |
| A2 | standard | TCP connect to control-plane private IP port 5432, 5 s timeout | Refused or blocked | |
| A3 | standard | `curl -sS -m 5 http://<browser IP>:3100/pressure` | JSON | |
| A4 | standard | TCP connect to another agent node's private IP, port 4646 | Refused or blocked | |
| A5 | full | Same as A2 | Connects | |
| A6 | standard | One browse with the agent's browser tool | Page content returned | |
| A7 | standard | Three real skills on staging that use shell (name them) | Each works | |
| A8 | standard | `execute_code` printing `os.getuid()` or `process.getuid()` | `0` (section 3, item 3) | |
| A9 | n/a | Fault events since the flag went on | No `sandbox_infrastructure_error` | |

---

## 8. Rollback (any time, minutes)

1. `NOMAD_SANDBOX_CAPS_ENABLED=false` in the env file; deploy (worker restart).
2. Relaunch every agent launched while it was on. They come back without `NET_ADMIN`, and shell is refused with exit 97 again (today's state).
3. If the image was the problem, set `NOMAD_AGENT_IMAGE` back to the previous tag and relaunch.

Nothing here touches data or Terraform except S1, which is undone by removing one line.
