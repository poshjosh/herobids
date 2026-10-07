# Private Agent Nodes: stop agent nodes consuming Hetzner Primary IPs

**Status:** Ready for implementation
**Created:** 2026-10-07
**Area:** `infra/hetzner/` (Terraform, cloud-init, deploy scripts, infra docs). No application code changes are expected; see WP4.4 for the one config check.
**Prerequisite:** [Bug 2026-10-07/001](../../../../bug-reports/2026/10/07/001-production-env-points-at-wrong-control-plane-private-ip.md) must be fixed first. Until then the production worker can't reach Nomad, so no production validation in this plan can pass.

## How to use this plan

This document is self-contained: you need this file and the repo's `AGENTS.md`. Line
numbers are approximate (`~`); find code by the names given. Do the work packages (WP) in
order. **WP1 is the required first step and ships on its own.** WP2–WP6 are the durable
fix. Each WP has a verification block, and you shouldn't start the next WP until it passes.

Ground rules:
- **Do not commit or push unless the user asks.** The autoscaler on each control plane
  runs Terraform from its own git checkout of `origin/main`. See "Rollout safety", which
  is mandatory.
- Staging and production are greenfield (operator test accounts only). Agent nodes and
  even control planes may be torn down and recreated. Still, roll out to staging first,
  then production.
- Never print secrets. The Hetzner token is `hcloud_token` in `infra/hetzner/<env>.tfvars`.
  To use it in a shell without echoing it:
  ```sh
  export HCLOUD_TOKEN="$(sed -nE 's/^hcloud_token *= *"([^"]+)".*/\1/p' infra/hetzner/staging.tfvars)"
  ```
- SSH keys: staging `~/.ssh/herobids_deploy_key`, production `~/.ssh/herobids_deploy_key_prod`.
  Scripts that take `--env` pick the key automatically (`scripts/_ssh_opts.sh`).
- `terraform fmt -check` and `terraform validate` must pass in `infra/hetzner`.
  `infra/hetzner/scripts/tests/run-all.sh` must pass. Run `pnpm lint` before declaring done.

## Problem

`terraform apply` of a new server in the shared Hetzner project fails with
`Primary IP limit exceeded (resource_limit_exceeded)`.

Facts, verified 2026-10-07:

| Fact | Evidence |
|---|---|
| Project limits are **Primary IPs 10/10** and Floating IPs 0/10. IPv4 and IPv6 primary IPs both count. | Hetzner Console → project limits (checked by the operator) |
| herobids and Traderton share one Hetzner project and token. | `GET /v1/servers` lists both repos' servers |
| 5 servers × (1 IPv4 + 1 IPv6) = 10 primary IPs: `herobids-production`, `herobids-staging`, `herobids-production-agent-1`, `herobids-staging-agent-1`, `traderton-staging` | `GET /v1/primary_ips` |
| Agent nodes get dual-stack public IPs only because `hcloud_server.agent` has no `public_net` block. The provider then auto-creates IPv4 + IPv6. | `infra/hetzner/main.tf`; provider docs, "Primary IPs" |
| **The herobids autoscaler hits this limit too.** `scale-out.sh` runs `terraform apply -var agent_node_count=N+1`. Production allows `max_agent_nodes = 9`. | `scripts/scale-out.sh`, `production.tfvars` |
| Traderton production (a new server, 2 primary IPs) is blocked. | Traderton `plan-apply.sh --env production` failed |

What agent nodes actually need:

| Need | Path today | Needs a public IP? |
|---|---|---|
| Nomad RPC/HTTP/Serf to the control plane (4646–4648) | private network | no |
| Redis/Postgres on the control plane (`SHARED_*_HOST`) | private network | no |
| Operator SSH | in practice a hop through the control plane (`ssh root@<cp> 'ssh -i /root/.ssh/deploy_key root@<agent-private-ip>'`). The control plane's `/root/.ssh/deploy_key` is the same keypair as the operator key (public halves match, verified on staging). | no |
| **Outbound internet during cloud-init:** apt mirrors, `download.docker.com`, `apt.releases.hashicorp.com`, `docker login ghcr.io` | public `eth0` | yes, unless NAT |
| **Outbound internet at runtime:** Nomad's docker driver pulls `ghcr.io/poshjosh/herobids-agent:latest`, and **agent containers make outbound calls** (LLM providers, web search and browsing, the Traderton boundary, etc.) | public `eth0`, IPv4 only | yes, unless NAT |

Why IPv6-only agents won't work (verified with `dig` on 2026-10-07): `ghcr.io`,
`api.tavily.com` and `api.staging.traderton.com` have **no AAAA record**. Docker's default
bridge is IPv4-only (`docker0` has no IPv6, and there's no `daemon.json`). On an IPv6-only
host, agent containers would have no egress at all.

Why fully private agents need NAT: a Hetzner Cloud server with no public IP has no
internet access unless traffic is routed through a server that has one
([Hetzner tutorial: NAT for Cloud Networks](https://community.hetzner.com/tutorials/how-to-set-up-nat-for-cloud-networks/)).

## Goal

1. **WP1 (first step).** Agent nodes become IPv4-only. That frees 1 primary IP per agent
   immediately with no change in connectivity, since agent egress is already IPv4. After
   WP1 on both environments the count is 8/10, and Traderton production can be provisioned.
2. **WP2–WP6 (durable).** Agent nodes get **no public IPs**. Their egress goes through the
   control plane, which acts as a NAT gateway for its own private network. After rollout,
   agent nodes use 0 primary IPs, so the autoscaler is limited by the server quota and
   `max_agent_nodes`, not by Primary IPs. It also stops paying for one IPv4 per agent.

## Non-goals

- Traderton changes. Traderton can optionally set `public_net { ipv6_enabled = false }` on
  its own server if `api.traderton.com` won't get an AAAA record; that belongs in a separate
  Traderton change.
- Removing IPv6 from the control planes. `openaidom.com` and `staging.openaidom.com` have
  AAAA records pointing at them.
- A dedicated or HA NAT server, or per-agent egress IPs. See Risks.
- Requesting a Primary IP quota increase. It isn't needed after this plan. **Do** check the
  *server* limit in WP0.

## Design decisions

- **D1. IPv4-only first.** `public_net { ipv4_enabled = true, ipv6_enabled = false }` on
  agents. It's zero-risk and unblocks Traderton the same day.
- **D2. The control plane is the NAT gateway.** Agents already depend on the control plane
  (Nomad server, Redis, Postgres), so this adds no new failure domain, no extra server and
  no extra IP. Mechanism: a Hetzner network route `0.0.0.0/0 → <control-plane private IP>`,
  plus IPv4 masquerading on the control plane.
- **D3. One Terraform toggle,** `agent_nodes_private_only` (bool). `true` gives the D2
  behaviour. `false` gives the D1 behaviour (IPv4-only) and is the rollback path. After
  WP6 the default is `true`.
- **D4. Inline `network {}` on `hcloud_server.agent`.** It replaces the separate
  `hcloud_server_network.agent` resource. A server with no public network must be attached
  to a private network **at creation** (provider issue
  [#555](https://github.com/hetznercloud/terraform-provider-hcloud/issues/555)). Use it in
  both toggle modes so there's only one code path.
- **D5. The NAT script lives in the repo** and is installed two ways:
  - by control-plane cloud-init (new control planes), and
  - by an idempotent installer that `deploy.sh` runs on every deploy (existing control
    planes).

  Both are needed because `hcloud_server.default` has `lifecycle { ignore_changes =
  [user_data] }`, so cloud-init edits never reach an existing control plane.
- **D6. Agent egress plumbing in agent cloud-init:**
  - default route via the network gateway (`cidrhost(network_ip_range, 1)`, verified as
    `10.0.0.1`)
  - Hetzner resolvers
  - remove `hc-utils`
  - Docker MTU matched to the private NIC (1450)
  - a bounded wait-for-egress before the first network use
- **D7. No Hetzner firewall on private-only agents.** Hetzner Cloud Firewalls filter public
  interfaces, and a private-only agent has none. The agent's UFW stays.
- **D8. Operator access is a hop through the control plane,** using `ssh -J` or the
  existing double-hop. The `agent_ssh_commands` output changes to match.

## Verified environment details (staging, 2026-10-07)

Control plane:
- `eth0` is public (MTU 1500); `enp7s0` is private (MTU 1450, `10.0.0.2`).
- `net.ipv4.ip_forward=1`, enabled by Docker.
- The iptables FORWARD policy is **DROP** (set by Docker). The first FORWARD rule jumps to
  `DOCKER-USER`.
- UFW: `deny (routed)`.
- NAT POSTROUTING has only Docker's own MASQUERADE rules.

Agent node:
- `eth0` public; `enp7s0` private (MTU 1450, `10.0.0.3`).
- The default route goes via `eth0`.
- `docker0` MTU is 1500 and there's no `/etc/docker/daemon.json`.
- `hc-utils` 0.0.8 is installed.
- `/etc/netplan/50-cloud-init.yaml` defines `enp7s0` (matched by MAC, `dhcp4: true`, `set-name: enp7s0`) and `eth0`.
- Routes on `enp7s0`: `10.0.0.0/16 via 10.0.0.1`.

Hetzner networks:
- `herobids-staging-net` and `herobids-production-net` are both `10.0.0.0/16`, with subnet gateway `10.0.0.1` and no routes.
- Agents in a given environment only use that environment's network.

Known platform caveat: servers created with `public_net` fully disabled on Ubuntu 24.04
take ~4 minutes longer to boot. cloud-init's early metadata fetch and
`systemd-networkd-wait-online` time out first
([provider issue #1074](https://github.com/hetznercloud/terraform-provider-hcloud/issues/1074)).
This delays scale-out but doesn't break it.

## Rollout safety (mandatory; read before WP1)

Each control plane's autoscaler (systemd timers below) runs `terraform apply -auto-approve`
from `/opt/herobids/infra/hetzner`. That's a checkout of `origin/main`, refreshed by
`scripts/push.sh` with `git reset --hard origin/main`, and it uses the tfvars uploaded by
`deploy.sh`. If you apply an uncommitted `main.tf` from your machine, the next autoscale or
scale-in run applies the **old** `main.tf` and reverts your change.

Before any `terraform apply` from a working tree, stop the timers on that environment's
control plane:

```sh
ssh root@<cp-ip> 'systemctl stop nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer'
```

Keep them stopped until the change is merged to `main` **and** deployed to that control
plane with `deploy.sh`, which pulls `origin/main`. Then restart them:

```sh
ssh root@<cp-ip> 'systemctl start nomad-autoscale.timer nomad-scale-in.timer nomad-placement-failure-watcher.timer'
```

Tell the user the timers are stopped, and whenever you hand back control. Manual scripts
(`scale-out.sh --force`) still work with the timers stopped.

Use `scripts/provision.sh` for these changes, not `scripts/provision-staging.sh`. The
latter only allows create/no-op actions and refuses updates and replacements (see WP5).

---

## WP0: Preflight (read-only)

1. Record the baseline primary IPs:
   ```sh
   curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/primary_ips \
     | jq -r '.primary_ips[] | [.type, .ip, .assignee_id] | @tsv'
   ```
   Expect 10 rows.
2. Ask the user for the project's **Servers** limit (Hetzner Console → project → Limits).
   For the autoscaler to reach its ceilings you need
   2 control planes + 2 Traderton servers + `max_agent_nodes` (production 9 + staging 3) = 16
   servers. If the limit is lower, tell the user. It's a separate quota request, outside
   this plan.
3. Confirm the prerequisite bug is fixed. From the production worker container,
   `wget -qO- --timeout=5 http://<cp-private-ip>:4646/v1/status/leader` must return the
   leader.
4. Confirm the production control plane's deploy key pairs with the operator key:
   ```sh
   ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 'ssh-keygen -y -f /root/.ssh/deploy_key | cut -d" " -f1-2 | md5sum'
   cut -d" " -f1-2 ~/.ssh/herobids_deploy_key_prod.pub | md5sum
   ```
   The hashes must match. If they don't, the double-hop and `-J` access in D8 won't work
   for production; stop and tell the user.

## WP1: IPv4-only agent nodes (first step; ship on its own)

### 1.1 Terraform

In `infra/hetzner/main.tf`, inside `resource "hcloud_server" "agent"`, add:

```hcl
  # Agent nodes don't need public IPv6: their egress is IPv4 (ghcr.io has no AAAA
  # and Docker's default bridge is IPv4-only). Each primary IP counts against the
  # Hetzner project's Primary IP limit. See docs/features/2026/10/07/001-private-agent-nodes.
  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }
```

Leave everything else in WP1 unchanged.

### 1.2 Rollout (staging, then production)

1. Stop the timers (Rollout safety).
2. Drain the agent node so in-flight agents get rescheduled. Greenfield, so this is optional:
   ```sh
   ssh root@<cp-ip> 'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); for n in $(nomad node status -quiet); do nomad node drain -enable -yes -deadline 5m "$n"; done'
   ```
3. Run `infra/hetzner/scripts/provision.sh --env <env> --var-file infra/hetzner/<env>.tfvars --backend-env-file infra/hetzner/.env.backend`.
   Read the plan before answering the prompts. The **only** changes should be to
   `hcloud_server.agent[*]`, either in-place or a replacement; both are fine. If anything
   else changes (control plane, network, firewall), answer `N` and investigate.
4. Note the cloud-init flow: a replacement node runs cloud-init from scratch, so wait 3–5
   minutes and then check:
   ```sh
   ssh root@<cp-ip> 'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); nomad node status'
   ```
   It should show one `ready` node. Disable draining on any surviving node with
   `nomad node drain -disable <id>`.

### 1.3 Verify WP1

- `GET /v1/primary_ips` shows one fewer IPv6 per agent node. After both environments: 8 rows.
- From the agent (via the control plane), the image pull still works:
  `ssh root@<cp-ip> 'ssh -i /root/.ssh/deploy_key root@<agent-private-ip> "docker pull ghcr.io/poshjosh/herobids-agent:latest"'`
- Start a test agent; it reaches `running` with no `Stale agent start detected`. See
  `infra/hetzner/docs/runbooks/reprovision-runbook.md` step 9.

### 1.4 Hand-off

Tell the user WP1 is complete in both environments and Primary IPs are at 8/10. Traderton
production (2 IPs) can now be provisioned. That puts the count back at 10/10, and herobids
autoscaling stays blocked until WP2–WP6 ship. Merge timing is the user's call; until it's
merged, keep the timers stopped.

---

## WP2: Spike: observe a private-only server on Hetzner (throwaway)

The exact netplan interface id and the boot behaviour of a server with **no public NIC**
decide how WP4 is written. Observe them before you write WP4. This server needs **0** primary
IPs, so it works even at 10/10.

1. Create a throwaway server in the **staging** network with no public net and a marker
   cloud-init:
   ```sh
   NET_ID=$(cd infra/hetzner && terraform workspace select staging >/dev/null && terraform output -raw private_network_id)
   SSH_KEY_ID=$(curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/ssh_keys?name=herobids-staging" | jq -r '.ssh_keys[0].id')
   curl -s -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" \
     https://api.hetzner.cloud/v1/servers -d "$(jq -n --arg net "$NET_ID" --arg key "$SSH_KEY_ID" '{
       name:"herobids-staging-spike-private", server_type:"cx23", image:"ubuntu-24.04", location:"fsn1",
       public_net:{enable_ipv4:false, enable_ipv6:false}, networks:[($net|tonumber)], ssh_keys:[($key|tonumber)],
       labels:{app:"herobids", environment:"staging", role:"spike"},
       user_data:"#cloud-config\nruncmd:\n  - touch /root/cloud-init-ran\n"}')" | jq '.server.id, .error'
   ```
   The SSH key name defaults to `var.server_name` (`herobids-staging`). If the lookup
   returns `null`, list `/v1/ssh_keys` and pick the staging key.
2. After ~6 minutes, reach it through the staging control plane. Find its private IP with
   `GET /v1/servers?name=herobids-staging-spike-private` (`.private_net[0].ip`). Then record:
   - `ip -br link` and `ip -4 route`: the private NIC name, and whether there's a default route
   - `cat /etc/netplan/50-cloud-init.yaml`: **the netplan id and match keys of the private NIC**
   - `ls /root/cloud-init-ran`: did user_data run at all?
   - `cloud-init analyze show | tail -20` and `systemd-analyze`: boot delay
   - `resolvectl status | head -20`: which DNS servers, if any
   - `dpkg -l hc-utils | tail -1` and `systemctl list-units | grep -i hc-`
3. With no NAT yet, confirm it has no egress: `curl -m 5 -sI https://ghcr.io/v2/` fails.
4. **Delete the spike server:** `curl -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers/<id>`.
   Confirm it's gone.
5. Write the findings into this plan's WP4.2 (replace the "assumed" values) before starting
   WP3.

If user_data did **not** run on the private-only server, stop. Report to the user; that
breaks this design.

## WP3: Control plane as NAT gateway

### 3.1 New script: `infra/hetzner/scripts/nat-gateway.sh`

This runs **on the control plane** as root. It must be idempotent (safe on every boot and
every deploy) and exit non-zero with a clear message if the interfaces can't be found.

```bash
#!/usr/bin/env bash
# nat-gateway.sh — make this control plane the IPv4 egress NAT for private-only
# agent nodes on its Hetzner private network. Idempotent: safe on every boot/deploy.
#
# Environment:
#   PRIVATE_SUBNET   Private subnet CIDR of this environment (e.g. 10.0.0.0/24). Required.
#
# Why DOCKER-USER: Docker sets the FORWARD policy to DROP and evaluates DOCKER-USER
# first. Rules there survive `ufw reload`, and Docker doesn't flush that chain.
set -euo pipefail

PRIVATE_SUBNET="${PRIVATE_SUBNET:?PRIVATE_SUBNET is required (e.g. 10.0.0.0/24)}"
prefix="$(printf '%s' "${PRIVATE_SUBNET}" | cut -d. -f1-2)."

pub_if="$(ip -4 route show default | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
priv_if="$(ip -4 -o addr show | awk -v p="${prefix}" 'index($4, p) == 1 {print $2; exit}')"
if [[ -z "${pub_if}" || -z "${priv_if}" ]]; then
  echo "ERROR: could not detect interfaces (public='${pub_if}', private='${priv_if}', subnet=${PRIVATE_SUBNET})" >&2
  exit 1
fi

sysctl -qw net.ipv4.ip_forward=1
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-herobids-nat.conf

ensure() { local table="$1"; shift; iptables -t "${table}" -C "$@" 2>/dev/null || iptables -t "${table}" -A "$@"; }
ensure_first() { iptables -C "$@" 2>/dev/null || iptables -I "$1" 1 "${@:2}"; }

ensure nat POSTROUTING -s "${PRIVATE_SUBNET}" -o "${pub_if}" -j MASQUERADE
iptables -N DOCKER-USER 2>/dev/null || true
ensure_first DOCKER-USER -i "${pub_if}" -o "${priv_if}" -d "${PRIVATE_SUBNET}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ensure_first DOCKER-USER -i "${priv_if}" -o "${pub_if}" -s "${PRIVATE_SUBNET}" -j ACCEPT

echo "NAT gateway ready: ${PRIVATE_SUBNET} via ${priv_if} -> ${pub_if}"
```

Notes:
- `ensure_first` is called as `ensure_first DOCKER-USER <rule...>`, where `$1` is the
  chain. Check the argument handling with a quick test (3.5).
- The control plane's Hetzner Cloud Firewall (`hcloud_firewall.default`) allows outbound
  TCP/UDP only. Forwarded ICMP is blocked, so **use `curl`, not `ping`, to verify.**

### 3.2 systemd unit (installed by both paths below)

`/etc/systemd/system/herobids-nat-gateway.service`:

```ini
[Unit]
Description=Herobids: IPv4 NAT for private-only agent nodes
Wants=network-online.target
After=network-online.target docker.service ufw.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PRIVATE_SUBNET=<private_subnet>
ExecStart=/usr/local/sbin/herobids-nat-gateway.sh

[Install]
WantedBy=multi-user.target
```

The script is installed to `/usr/local/sbin/herobids-nat-gateway.sh` (mode 0755). The unit
doesn't point at the git checkout, so later checkout changes can't silently alter routing.

### 3.3 Installer for existing control planes: `infra/hetzner/scripts/setup-nat-gateway.sh`

A local script, following the conventions of the other scripts:
- source `_ssh_opts.sh`, call `parse_env_flag "$@"` first, take an optional `<server-ip>`
  (default `terraform_output -raw server_ipv4`), and support `--help`.

Behaviour:
1. Read `agent_nodes_private_only` and `private_subnet_ip_range` with `terraform_output`.
   If private-only isn't `true`, print a message and exit 0.
2. `scp ${SSH_OPTS}` the repo's `scripts/nat-gateway.sh` to the control plane as
   `/usr/local/sbin/herobids-nat-gateway.sh`, and write the unit with the real
   `PRIVATE_SUBNET`.
3. Run `systemctl daemon-reload && systemctl enable --now herobids-nat-gateway.service`.
   If the unit was already active, `systemctl restart` it to re-apply (the script is
   idempotent).
4. Verify remotely with `iptables -t nat -C POSTROUTING -s <subnet> -o <pub_if> -j MASQUERADE`.
   Exit non-zero on failure.

Call it from `infra/hetzner/deploy.sh` as a new step after "Upload autoscale.env" and
before "Push". Every deploy then converges the control plane. Keep the step's output style
consistent with the other `deploy.sh` steps.

### 3.4 cloud-init for new control planes

In `infra/hetzner/cloud-init.yaml`, inside the `if [ "${enable_nomad}" = "true" ]` runcmd
block (~line 470, next to the UFW Nomad rules), add a new section that runs **after** the
repo clone (the clone happens earlier in runcmd):

```sh
      # ── NAT gateway for private-only agent nodes ─────────
      if [ "${agent_nodes_private_only}" = "true" ] && [ -f /opt/herobids/infra/hetzner/scripts/nat-gateway.sh ]; then
        install -m 0755 /opt/herobids/infra/hetzner/scripts/nat-gateway.sh /usr/local/sbin/herobids-nat-gateway.sh
        systemctl daemon-reload
        systemctl enable --now herobids-nat-gateway.service || logger -t cloud-init "WARNING: herobids-nat-gateway failed — private agents have no egress"
      fi
```

Add the unit from 3.2 to `write_files`, with `Environment=PRIVATE_SUBNET=${private_subnet}`.
In `main.tf`, pass `agent_nodes_private_only = tostring(var.agent_nodes_private_only)`
into the `templatefile("${path.module}/cloud-init.yaml", { ... })` map.

The new control plane's checkout is `var.git_branch`. The script must exist on that branch
before a fresh provision relies on it. Until it's merged, a fresh provision gets NAT from
the `deploy.sh` step (3.3) instead. Agent cloud-init waits for egress (WP4), so it tolerates
that delay.

Keep additions small. Hetzner caps `user_data` at 32 KiB, and this template is already
large. Don't inline the script.

### 3.5 Terraform: variable, route, output

`variables.tf`, in the "Agent Node Pool" section:

```hcl
variable "agent_nodes_private_only" {
  type        = bool
  description = "Agent nodes get no public IPs; their IPv4 egress is NATed through the control plane. false = IPv4-only public agents (rollback path). Each public primary IP counts against the Hetzner project Primary IP limit."
  default     = false # flipped to true in WP6 after staging + production validation
}
```

`main.tf`:

```hcl
# Default route for private-only agent nodes: the network gateway forwards
# 0.0.0.0/0 to the control plane, which masquerades it (scripts/nat-gateway.sh).
resource "hcloud_network_route" "agent_egress" {
  count       = var.enable_nomad && var.agent_nodes_private_only ? 1 : 0
  network_id  = hcloud_network.private[0].id
  destination = "0.0.0.0/0"
  gateway     = hcloud_server_network.control_plane[0].ip
}
```

The provider doc's text on `destination` is ambiguous about `0.0.0.0/0`. Hetzner's NAT
tutorial uses exactly this route. If the API rejects it on staging, stop and report; don't
work around it.

`outputs.tf`:
- add `output "agent_nodes_private_only" { value = var.agent_nodes_private_only }`.

## WP4: Private-only agent nodes

### 4.1 Terraform: `hcloud_server.agent`

Replace the WP1 `public_net` block and the network attachment:

```hcl
resource "hcloud_server" "agent" {
  # ...existing name/server_type/location/image/ssh_keys/user_data/labels/lifecycle...

  firewall_ids = var.enable_nomad && !var.agent_nodes_private_only ? [hcloud_firewall.agent[0].id] : []

  public_net {
    ipv4_enabled = !var.agent_nodes_private_only
    ipv6_enabled = false
  }

  # Attach at creation: a server without public networking must have a network
  # at create time (provider issue #555). alias_ips = [] avoids a perpetual diff.
  network {
    network_id = hcloud_network.private[0].id
    alias_ips  = []
  }

  depends_on = [hcloud_network_subnet.private, hcloud_network_route.agent_egress]
}
```

- **Delete** `resource "hcloud_server_network" "agent"`.
- `hcloud_firewall.agent`: change `count` to `var.enable_nomad && !var.agent_nodes_private_only ? 1 : 0`.
- Pass these extra variables into the `cloud-init-nomad-client.yaml` templatefile map:
  ```hcl
    private_only       = tostring(var.agent_nodes_private_only)
    network_gateway_ip = cidrhost(var.network_ip_range, 1)
    dns_servers        = join(" ", var.agent_dns_servers)
  ```
- Add to `variables.tf`:
  ```hcl
  variable "agent_dns_servers" {
    type        = list(string)
    description = "Recursive DNS resolvers for private-only agent nodes (no DHCP-provided DNS without a public NIC). Defaults to Hetzner's resolvers."
    default     = ["185.12.64.1", "185.12.64.2"]
  }
  ```

The `nomad_server_addr` and `control_plane_private_ip` template values still come from
`hcloud_server_network.control_plane[0].ip`. Leave them unchanged.

### 4.2 cloud-init: `cloud-init-nomad-client.yaml`

The values marked "assumed" below must match the WP2 spike findings. Update them first.

The file is a Terraform `templatefile`. `${name}` is a Terraform variable, so any literal
shell `${VAR}` must be written `$${VAR}`. Follow the existing escaping in this file (e.g.
`$${1:-}` in the embedded health script). Run `terraform validate`, and render a plan, after
editing.

1. **Move packages out of the module stage.** Remove `package_update`, `package_upgrade`
   and `packages:` from the top of the file. cloud-init runs them before `runcmd`, which
   is before egress exists. Install them in `runcmd` after the egress wait (step 4), in
   both modes:
   `apt-get update -y && apt-get upgrade -y && apt-get install -y ca-certificates curl gnupg jq redis-tools ufw fail2ban unattended-upgrades`.
2. **`bootcmd` (every boot, private-only only): routing and DNS.** Detect the private NIC
   the same way `nomad-private-ip.service` does (by subnet prefix). Write
   `/etc/netplan/60-herobids-egress.yaml`, merging into the cloud-init netplan id (assumed
   `enp7s0`, confirm in WP2):
   ```yaml
   network:
     version: 2
     ethernets:
       enp7s0:            # MUST equal the id used in /etc/netplan/50-cloud-init.yaml
         routes:
           - to: default
             via: ${network_gateway_ip}
             on-link: true
         nameservers:
           addresses: [<each of ${dns_servers}>]
   ```
   Set mode 0600 (netplan warns about wider permissions), then run `netplan apply`.

   Use netplan rather than a bare `ip route add`: `systemd-networkd` manages "foreign"
   routes by default and can remove routes it didn't configure.

   Guard all of this with `if [ "${private_only}" = "true" ]`. In public mode the agent
   keeps its DHCP default route via `eth0`. bootcmd runs in POSIX `sh`, so no bash-isms;
   follow the comment at the file's `runcmd:` header.
3. **Remove `hc-utils` (private-only):** `dpkg --purge hc-utils || true`, early in
   runcmd. It's offline-safe. The Hetzner NAT tutorial requires this on private clients.
4. **Wait for egress (both modes), as the first runcmd step that needs the internet:**
   ```sh
   - |
     i=0
     until curl -fsS -o /dev/null --max-time 5 https://download.docker.com/; do
       i=$((i+1)); [ "$i" -ge 120 ] && { logger -t cloud-init "ERROR: no egress after 20 min — check the control-plane NAT (herobids-nat-gateway.service) and the hcloud network route"; break; }
       sleep 10
     done
   ```
   It's bounded (~20 min) so a broken NAT shows up as a clear log line, and the following
   steps fail loudly instead of hanging forever.
5. **Docker MTU (private-only).** After Docker is installed, detect the private NIC's MTU.
   Write `/etc/docker/daemon.json` with `{"mtu": <that value>}` (1450 on Hetzner; don't
   hardcode it), then `systemctl restart docker`. Do this **before** the `docker login`
   and `nomad` start steps.

   Reason: `docker0` defaults to MTU 1500, but the egress path is now the 1450-byte private
   NIC. Oversized packets from containers would stall large downloads such as image layers
   and big TLS responses. `config/default.yaml` → `nomad.dockerNetwork` is empty, so agent
   tasks use the default bridge and `daemon.json`'s `mtu` covers them. If someone later sets
   `dockerNetwork`, that network needs `com.docker.network.driver.mtu` too; say so in a
   comment next to the `dockerNetwork` key.
6. Keep everything else: the Docker/Nomad install, the GHCR login, UFW (`allow 22/tcp` is
   still needed for the control-plane hop), fail2ban, Nomad and the health timer. Update
   the header comment's template-variable list.

### 4.3 Outputs (`outputs.tf`)

- `agent_node_private_ips` → `var.enable_nomad ? [for s in hcloud_server.agent : tolist(s.network)[0].ip] : []`
- Delete `agent_node_public_ips`. In private-only mode it would be a list of empty strings.
  Update every doc reference (WP5).
- `agent_ssh_commands` → `"ssh -J root@${hcloud_server.default.ipv4_address} root@${ip}"` over the private IPs.

### 4.4 Application config check

Search the repo (`apps/`, `packages/`, `config/`) for anything that reads agent nodes'
**public** IPs or `agent_node_public_ips`. As of 2026-10-07 there's nothing. If you find
something, stop and report.

## WP5: Scripts, tests, examples

1. `infra/hetzner/scripts/provision-staging.sh`, the jq allowlist (~line 115):
   - add `"hcloud_network_route.agent_egress[0]"`
   - remove `"hcloud_server_network.agent[0]"`

   Firewall `hcloud_firewall.agent[0]` is now absent when private-only; the allowlist
   permits absence, so keep the entry. This script only provisions fresh environments
   (create-only), so don't relax its action guard. Update
   `scripts/tests/test-provision-staging.sh` to match, then run
   `infra/hetzner/scripts/tests/run-all.sh`.
2. Add a test for `nat-gateway.sh` argument and interface detection if the harness allows
   it without root iptables, for example by stubbing `ip`/`iptables`/`sysctl` on `PATH` as
   other tests stub commands. At minimum test:
   - a missing `PRIVATE_SUBNET` exits non-zero
   - when no interface matches, it exits 1 with the error message
   - a second run adds no duplicate rules (the stubbed `iptables -C` succeeds)
3. `infra/hetzner/environment.tfvars.example` and `terraform.tfvars.example`: add a
   commented, explained `# agent_nodes_private_only = true` and `# agent_dns_servers = [...]`.
4. `scripts/agent-node-health.sh` (the standalone copy) doesn't need changes.

## WP6: Rollout and validation (staging, then production)

For each environment:

1. Stop the timers (Rollout safety).
2. Set `agent_nodes_private_only = true` in `<env>.tfvars`.
3. Install the NAT on the existing control plane **before** agents switch:
   `infra/hetzner/scripts/setup-nat-gateway.sh --env <env>`.
   This needs the new `agent_nodes_private_only` output. If that output doesn't exist in
   state yet, run `setup-nat-gateway.sh` after step 4's apply, and accept a short window in
   which the new agent waits for egress.
4. Apply with `scripts/provision.sh --env <env> ...`. Expected changes:
   - `hcloud_network_route.agent_egress[0]` created
   - `hcloud_server_network.agent[*]` destroyed
   - `hcloud_firewall.agent[0]` destroyed
   - `hcloud_server.agent[*]` replaced

   Anything touching `hcloud_server.default`, `hcloud_network.private` or the subnet means
   **stop**.
5. Validate. All of these must pass:

| # | Check | Command (via `ssh root@<cp-ip>`; agent commands through `ssh -i /root/.ssh/deploy_key root@<agent-private-ip>`) | Expected |
|---|---|---|---|
| V1 | Primary IPs freed | `GET /v1/primary_ips` | no IPs assigned to any `*-agent-*` server |
| V2 | NAT active on the control plane | `systemctl is-active herobids-nat-gateway; iptables -t nat -S POSTROUTING \| grep <subnet>; iptables -S DOCKER-USER` | `active`; MASQUERADE + 2 ACCEPT rules |
| V3 | Agent route/DNS | agent: `ip -4 route show default; resolvectl dns` | `default via <gw> dev <priv_if>`; Hetzner resolvers |
| V4 | Agent host egress | agent: `curl -sS -o /dev/null -w '%{http_code}\n' https://ghcr.io/v2/` | `401` |
| V5 | Egress IP is the control plane's | agent: `docker run --rm alpine:3 wget -qO- https://api.ipify.org` | the control plane's public IPv4 |
| V6 | MTU / large transfers from a container | agent: `docker run --rm alpine:3 sh -c 'wget -qO /dev/null https://releases.hashicorp.com/nomad/1.9.7/nomad_1.9.7_linux_amd64.zip && echo OK'` | `OK` within ~1 min |
| V7 | Image pull | agent: `docker pull ghcr.io/poshjosh/herobids-agent:latest` | succeeds |
| V8 | Nomad | cp: `NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token) nomad node status` | node `ready` |
| V9 | End-to-end agent | start a non-trading test agent (reprovision runbook step 9) and send it a message | `running`, it replies (proves the LLM egress path), no `Stale agent start detected` |
| V10 | Control-plane reboot resilience | `systemctl reboot` the control plane, wait, rerun V2, V4, V8 | all pass with no manual steps |
| V11 | Agent reboot resilience | reboot the agent, rerun V3, V4, V8 | all pass |
| V12 | Autoscale path | cp: `/opt/herobids/infra/hetzner/scripts/scale-out.sh --force` (needs the merged code on the control plane, see Rollout safety; on staging you may instead run `provision.sh` with `agent_node_count` +1 from your machine), then V3–V8 on the new node, then scale back | new private-only node joins; 0 new primary IPs |
| V13 | Boot time | creation → Nomad `ready` for the new node | record it (expect ~4 min more than before, issue #1074) |
| V14 | Operator access | from your laptop: `terraform output -json agent_ssh_commands`, run one (with the right `-i`, or a `~/.ssh/config` `ProxyJump` entry) | shell on the agent |

6. Merge, deploy (`deploy.sh`), and restart the timers when the user approves. Then flip
   the `agent_nodes_private_only` default in `variables.tf` to `true` and remove the
   explicit tfvars lines (or leave them, if the user prefers explicit tfvars). Confirm with
   `provision.sh` that the plan shows no changes.

## WP7: Docs

Update these files under `infra/hetzner/`. Follow `infra/hetzner/docs/README.md` (one
canonical doc per scenario; production-only notes go in `runbooks/production-notes.md`):

- `README.md`:
  - "Agent Nodes" section: no public IPs; egress NATed via the control plane; SSH via the
    control-plane hop; the firewall line is gone.
  - Add a short "Agent egress (NAT)" subsection: route + `herobids-nat-gateway.service` + DOCKER-USER rules + MTU.
  - "Provisioning with Nomad" and "Verifying the Cluster": the agent SSH examples use the hop.
- `docs/auto-scaling/useful-commands.md`:
  - SSH section: `ssh -J` and the double-hop.
  - Replace `agent_node_public_ips` with `agent_node_private_ips`.
  - Add a "Private agent has no egress" troubleshooting table: V2 → V3 → V4 → V5, with
    causes such as a missing route, an inactive NAT unit, DNS, or MTU.
- `docs/auto-scaling/setup-auto-scaling.md` quick reference: replace `agent_node_public_ips`.
- `docs/runbooks/reprovision-runbook.md`:
  - after step 6a, add "6b. Verify agent egress (private-only)" (V2–V5).
  - step 10's image pull check is unchanged.
- `docs/runbooks/production-notes.md`: add a "Hetzner Primary IP quota" section (the 10/10
  facts, agents use 0, what each server costs).
- `docs/auto-scaling/lessons-learnt.md`: add a new numbered entry. Primary IP quota hit;
  IPv6-only agents ruled out (ghcr.io has no AAAA, Docker bridge is IPv4-only); NAT gotchas
  (Docker FORWARD DROP → DOCKER-USER, UFW routed deny, 1450 MTU, `ignore_changes=[user_data]`
  keeps cloud-init from existing control planes, the autoscaler applies `origin/main`).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The control plane becomes the egress path for all agents | Agents already depend on it (Nomad, Redis, Postgres). Reboot resilience is tested in V10. |
| All agent outbound traffic shares the control plane's IPv4, so third-party per-IP rate limits and IP reputation (e.g. agents browsing the web) now affect the control plane's own outbound calls | Accepted for now; note it in `production-notes.md`. A dedicated NAT server is the later escape hatch, but it costs 1 primary IP. |
| Agent egress counts against the control plane's included traffic | Note it in `production-notes.md`; check Hetzner traffic stats after a week. |
| ~4 min slower boot for private-only nodes (#1074) | Accepted; recorded in V13. Revisit the scale-out thresholds only if real demand needs it. |
| Hetzner rejects a `0.0.0.0/0` route | Stop and report (WP3.5). |
| Interface naming or netplan id differs without a public NIC | WP2 spike decides; WP4.2 uses the observed values. |
| An uncommitted apply is reverted by the autoscaler | Rollout safety procedure (timers stopped until merged and deployed). |
| `user_data` > 32 KiB | Scripts live in the repo, not inline; keep additions minimal. |

## Rollback

Set `agent_nodes_private_only = false`, then apply with `provision.sh`. Agents come back
IPv4-only (1 primary IP each), the route and agent firewall are recreated, and the NAT unit
is harmless when left enabled. To remove it anyway:
`systemctl disable --now herobids-nat-gateway` on the control plane.

## Acceptance criteria

- [ ] WP1 is live on staging and production; Primary IPs went from 10 to 8 before Traderton production.
- [ ] With `agent_nodes_private_only = true`, agent nodes hold **0** primary IPs (V1). `scale-out.sh` adds nodes without `primary_ip_limit` errors (V12).
- [ ] V2–V14 pass on staging and production.
- [ ] `terraform fmt -check`, `terraform validate`, `scripts/tests/run-all.sh` and `pnpm lint` pass.
- [ ] The docs in WP7 are updated, and no doc references `agent_node_public_ips`.
- [ ] Autoscale timers are running again on both control planes after merge and deploy, or the user has been told explicitly that they're stopped.
