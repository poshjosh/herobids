# Traderton Production Infrastructure Plan

**Status:** proposed; no infrastructure change authorized.
**Date:** 2026-09-25
**Parent:** [Traderton Staging Infrastructure Plan](./003-traderton-staging-infrastructure-plan.md), item 5
**Related:** [Staging-First External Backend Roadmap](./001-staging-first-external-backend-roadmap.md); [ADR 015](../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md)

## Objective

Define how Traderton production will run independently of staging: its own VM,
state, secrets, persistence and lifecycle, attached to a **production-owned**
private network reachable from production Herobids. Production must never
depend on the staging network, VM, private IPs or signing credentials.

## Scope And Non-Goals

- This plan is written before any production implementation. It does not
  authorize code changes, applies, deployments, DNS/TLS changes, secret
  changes or traffic exercises.
- Do not reuse the staging network ID, subnet, private IPs, Terraform state
  key, signing identity or credential-encryption key.
- Do not provision production before the staging operational proof (roadmap
  Phase 1) is complete and reviewed, unless the operator explicitly reorders.
- Mirror the staging design (attach-only network consumption, private-only
  boundary, pinned releases, backups, plan guard) rather than inventing a new
  shape; differences must be justified in this plan.

## Ordered Work

1. **PENDING - Resolve the production network owner and CIDR before an apply.**
   Inspect the actual production Terraform plan and confirm which resources
   create the production private network. The production tfvars currently
   comments out `network_ip_range = "10.1.0.0/16"` while
   `variables.tf` defaults to `10.0.0.0/16` — the same default staging uses.
   Determine the *effective* production network CIDR from the plan, not from
   the commented example. If production and staging would share `10.0.0.0/16`,
   the two networks are not isolated: assign production a distinct range
   (e.g. `10.1.0.0/16`) and confirm it does not overlap staging, host routes or
   container networks. Record the production network ID, subnet and caller
   private IPs as the handoff for Traderton production.
2. **PENDING - Prepare Traderton production code as a separate state.** Add a
   production Terraform root (or environment) with its own remote backend key
   (e.g. `traderton/production/terraform.tfstate`), its own VM, firewall,
   attach-only network consumption and plan guard. Reuse the staging module
   shape; parameterize environment, network handoff, locations and secrets.
   Do not fork logic that can be shared.
3. **PENDING - Keep production secrets and identity separate.** Generate a
   distinct production HMAC signing identity and credential-encryption key.
   Store them only in the production env file (root-owned, mode 600) with a
   committed `.example` twin. Never copy staging secrets into production.
4. **PENDING - Apply in controlled order, each with separate explicit
   approval.** Provision production Herobids and its production network first,
   verify the known-healthy baseline and record the network outputs, then
   provision the Traderton production VM and attachment from its separate
   state, deploy pinned release SHAs and image digests, and verify the private
   boundary path from production API and worker containers.
5. **PENDING - Production readiness and rollback.** Before production cutover,
   satisfy the roadmap Phase 1 exit criteria and traderton
   `007-operational-readiness.md`: latency budget, restart resilience,
   idempotent retry, health gating, and a rehearsed rollback. Record both
   deployed SHAs/digests and the rollback procedure.

## Verification And Exit Criteria

- Before an apply: reviewed, narrow production plans and focused tests show
  production-only resources, an isolated backend key, attach-only Traderton
  network ownership, a production CIDR that does not overlap staging, and no
  public execution port.
- After separately approved applies: confirm production outputs match the
  inspected network ID, both production VMs have private IPs on the production
  network, the boundary is reachable only over the private path, and HMAC
  rejection works.
- Production must remain reachable and correct even if staging is destroyed;
  verify this explicitly by confirming no production resource references a
  staging network, ID, IP or credential.

## Approval Gates

Writing and reviewing this plan does not authorize infrastructure-code edits
or any apply. Obtain explicit operator approval before adding/changing
provisioning code or configuration, and separate explicit approvals for each
Terraform apply, deployment, DNS/TLS change, secret change, traffic exercise
or teardown. If the inspected production network cannot be isolated from
staging, stop and revise this plan before provisioning.
