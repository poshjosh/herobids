# Traderton Staging Infrastructure Plan

**Status:** proposed; no infrastructure change authorized.
**Date:** 2026-09-25
**Parent:** [Staging-First External Backend Roadmap](./001-staging-first-external-backend-roadmap.md), Phase 1, steps 1-4

> **SUPERSEDED (2026-09-25): public/independent model.** The private-network
> handoff between Herobids and Traderton was dropped in favour of independent
> deployability: Traderton owns its own VM and exposes the boundary over the
> public interface, authenticated by HMAC. Herobids provisions independently
> and points `TRADERTON_BOUNDARY_URL` at Traderton's public `api_url`
> output. There is no cross-repo value movement, no shared network, no
> `network_handoff`, and no ordering constraint between the two repos. Ordering
> items 1's network-handoff body and the private-path parts of this plan are
> therefore obsolete; items 2/3/5 and the firewall/alerts/state-locking
> decisions remain valid. See the Traderton `infra/hetzner/README.md`
> for the implemented public model.
>
> **TLS (2026-09-25):** the boundary is served over HTTPS via Caddy on a
> dedicated hostname (`api.staging.traderton.com`), and the future human
> frontend on `staging.traderton.com`. The boundary publishes no host port; it
> is reachable only through Caddy on the compose network and HMAC-authenticates
> every call. This supersedes the earlier plain-HTTP `http://<ip>:8080` public
> bound.

## Objective

Run Traderton staging as an independently deployable service with no runtime or
deployment dependency on Herobids Terraform state. Herobids and Traderton meet
only at a URL: Herobids configures `TRADERTON_BOUNDARY_URL` to Traderton's
public boundary endpoint and authenticates every call with HMAC.

## Scope And Non-Goals

- Add Traderton-owned Hetzner provisioning and deployment code in the
  `traderton` repository, with its own remote state, VM, persistent Postgres
  and Redis, secret injection, migrations, health checks, logs and backup
  policy. Use the existing Traderton container build as input, not its local
  Compose port mapping as a remote security policy.
- Add only the minimal Herobids-side configuration and network-output handoff
  needed to consume the independent service. Its Terraform state owns the
  staging network; Traderton's state only looks up and attaches to it.
- No cloud apply/destroy, DNS/TLS change, deployment, live probe, or secret
  rotation is authorized by writing this plan. A public
  `staging.traderton.com` site is a separate site/TLS concern; its public DNS
  must not become the execution-boundary routing mechanism.
- Do not build the eventual generic External Backend refactor here. Do not
  attach production Herobids to staging infrastructure.

## Ordered Work

1. **DONE (code preparation; live verification pending approval) - Resolve the network handoff before an apply.** Inspect the actual staging
   Terraform plan and intended provider project, region and network zone.
   Confirm `enable_nomad` creates one `hcloud_network` plus subnet, and that
   the control-plane and any actual boundary callers attach to it. Confirm
   effective staging CIDR does not overlap production or host/container routes.
   Record the network ID, subnet and caller private IP outputs for the later
   Traderton lookup; never assume a value from a commented-out tfvars example.
   The Herobids staging state is the sole owner of this network. Traderton
   must use an explicit network ID or validated read-only lookup and own only
   its server attachment, not a second network resource or remote-state writes.
   Check that both VMs are in a compatible Hetzner project/network zone.
2. **DONE (code preparation; live verification pending approval) - Prepare the Traderton-owned code before Herobids provisioning.** Add
   staging-only Terraform, isolated remote backend key and plan guard, cloud
   firewall, private network attachment, cloud-init or equivalent host setup,
   deployment scripts, environment templates and focused tests in Traderton.
   Define persistence and backup/restore procedures for its Postgres and Redis,
   handling of HMAC and encryption secrets, and the VM destroy/dependency
   order. Neither a Traderton destroy nor a Herobids teardown may silently
   remove a network still used by the other service. Review the Herobids
   staging plan and the Traderton plan together before either apply.
3. **DONE (code preparation; live verification pending approval) - Make the boundary private.** Bind/publish the Traderton execution port
   only on the private interface and allow only the actual Herobids caller
   private IPs through host and cloud firewalls. Check routing from both the
   API and worker containers, including container-to-host/Hetzner private
   network forwarding. Do not copy local Compose's `8080:8080` publication
   unchanged. Keep HMAC authentication; define the separate public site proxy
   so it cannot route to the execution endpoints.
4. **BLOCKED (requires explicit operator approval) - Apply in controlled order, each with separate explicit approval.** First
   provision and verify Herobids staging and its network (step 1), including
   network outputs and known-healthy baseline. Then provision the Traderton VM
   and attachment from its separate state (step 2). Deploy pinned release SHAs
   and image digests, apply Traderton migrations, and check `/health/ready`
   privately (step 3). Set the private boundary URL and matching HMAC
   credentials for Herobids API and worker; then verify cross-stack flows
   (step 4). DNS and public-site changes require their own approval.
5. **DONE (plan) - Keep production independent.** Before production implementation, write a
   separate Traderton production plan with its own VM/state/secrets and an
   attachment to a production-owned private network reachable from production
   Herobids. Verify the *effective* production network CIDR: the production
   tfvars currently comments out `10.1.0.0/16` while the Terraform default is
   `10.0.0.0/16`. Resolve overlap before any production plan/apply; do not
   reuse the staging network, ID, private IP or signing credentials.
   See [004-traderton-production-infrastructure-plan.md](./004-traderton-production-infrastructure-plan.md).

## Verification And Exit Criteria

- Before an apply: reviewed, narrow Terraform plans and focused tests show
  staging-only resources, isolated backend keys, attach-only Traderton network
  ownership, CIDR/zone compatibility and no public execution port. Review
  teardown and backup/restore procedures. Record the intended network handoff.
- After separately approved applies: confirm outputs match the inspected
  network ID and both VMs have private IPs on the intended network. Probe the
  boundary from Herobids API and worker containers, test HMAC rejection and
  health/read/write flows, and show the execution port cannot be reached via
  the Traderton VM's public interface. Record the deployed SHAs/digests.
- For public staging checks, account for local Zscaler blocking
  `openaidom.com`: verify DNS ownership and TLS from an independent vantage
  point or a controlled host probe rather than treating a local failed curl
  as proof of service failure. No Zscaler bypass is part of this plan.
- Phase 1 step 5 then measures latency, restart recovery and rollback per
  the roadmap. This plan alone does not mark staging operationally proven.

## Approval Gates

Writing and reviewing this plan does not authorize infrastructure-code edits.
Obtain explicit operator approval before adding/changing provisioning code or
configuration, and separate explicit approvals for each Terraform apply,
deployment, DNS/TLS change, secret change, traffic exercise or teardown. If
the inspected Hetzner network cannot be shared as assumed, stop and revise
this plan before provisioning.

## Decisions Applied (align to the existing Herobids conventions)

The user's guidance is to stick with what already works in Herobids rather than
invent new approaches. These five decisions were applied to the Traderton
staging code to match the existing conventions:

1. **Firewall — UFW, not an iptables `DOCKER-USER` chain.** The staging
   `cloud-init.sh.tftpl` now mirrors Herobids `cloud-init.yaml` (`ufw default
   deny incoming`, `ufw allow 22/tcp`, `ufw allow from <caller> to any port
   8080 proto tcp`, `ufw --force enable`). UFW rules persist across reboots
   before Docker resumes containers, so the earlier reboot/container-resume
   ordering decision (the `PartOf`/`WantedBy` unit) is removed entirely.
2. **Boundary port — Docker publish on the private IP, gated by UFW.** Kept
   the existing host-published port; the host UFW `from <caller>` rule is the
   private-path control, matching how Herobids gates internal services. No
   host-network rebinding.
3. **CIDR — production stays `10.1.0.0/16`, staging `10.0.0.0/16`** (already
   the documented convention in `production.tfvars`/`staging.tfvars`). The
   `variables.tf` default of `10.0.0.0/16` is a footgun only for a bare
   production apply without the var file; no code change, only documented.
4. **State locking — reuse the Herobids S3 + DynamoDB lock table.** Added
   `TF_BACKEND_DYNAMODB_TABLE` to `.env.terraform.example` and documented the
   `-backend-config=dynamodb_table=...` init arg, mirroring Herobids
   `provision.sh`.
5. **Alerts — SMTP email via `sendmail`/`mail`, not an HTTPS webhook.** The
   backup alert now uses `ALERT_FROM`/`ALERT_TO` + `ALERT_SMTP_*`, mirroring
   Herobids `send-alert.sh`/`alert-common.sh`, with a `logger` fallback.

## Outstanding Issues

- Item 1 (MEDIUM): Verify any agent-node attachments used by actual boundary
  callers reference the reviewed network and server in the Herobids plan guard;
  add a rejection fixture when the caller topology is known.
- Item 1 (MEDIUM): Include the network CIDR and applicable agent private IPs
  in the post-apply handoff output or explicit retrieval instructions.
- Item 1 (live gate): Actual network identity, project, zone, route overlap,
  and caller private IPs must be checked against an approved plan and outputs
  before Traderton attachment. Offline fixtures do not prove these values.
- Item 2 (MEDIUM): Expand the independent approved handoff record to cover
  project, network CIDR, zone, and both locations; pin its identity between
  the saved-plan review and apply.
- Item 2 (MEDIUM): Confirm supported state locking or an enforceable
  single-operator apply procedure before touching live remote state.
  **Resolved:** reuse the Herobids S3 + DynamoDB `TF_BACKEND_DYNAMODB_TABLE`
  lock table (decision 4); still requires the operator to supply the table
  at `terraform init` time before any live apply.
- Item 2 (LOW): Exclude generated Python bytecode from the Traderton test tree.
- Item 3 (live gate): Confirm the approved Herobids staging API and worker
  container egress routes and observed source IPs match the reviewed caller
  /32 allowlist. Probe private readiness, signed read/write, unsigned HMAC
  rejection, and public-IP port 8080 non-reachability after separately approved
  deployment. The public site proxy is a separate, inactive template until
  its own site host, frontend, DNS and TLS are approved and provisioned; verify
  its execution-path rejection from an independent public vantage point.
- Item 3 (RESOLVED — firewall ordering): The earlier `DOCKER-USER`/iptables
  unit (`PartOf`/`WantedBy`/`After`) and its reboot/container-resume window are
  removed by adopting UFW (decision 1). UFW rules are installed by cloud-init
  and persist across reboots before Docker resumes containers, so there is no
  ordering decision left.
- Item 3 (MEDIUM): Strengthen the public-site proxy test to assert the upstream
  is exactly the site service and that the denylist covers every path the
  boundary actually serves, rather than a sample of paths.
- Item 3 (MEDIUM): Replace the hand-rolled `%{ for ... }` template
  re-implementation in `guard-plan.py` and `test_firewall_proxy.py` with a
  committed Terraform-rendered `user_data` fixture so the guard cannot drift
  from Terraform's real output.
- Item 3 (MEDIUM): Wire the staging offline guards and Python suite into a
  `test:staging` script and CI so the pre-apply evidence cannot rot silently.