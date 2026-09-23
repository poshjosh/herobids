# Staging-First External Backend Roadmap

**Status:** accepted sequencing; detailed implementation plans remain to be written.
**Date:** 2026-09-24
**Related decision:** [ADR 015](../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md)
**Agent continuity:** start at [the program ENTRYPOINT](./000-program/ENTRYPOINT.md), then read [PROGRESS](./000-program/PROGRESS.md) and [DECISIONS](./000-program/DECISIONS.md).

## Objective

Run Traderton as an independently deployable trading service while Herobids
remains the generic agent platform. First prove that split operationally on
staging; then remove Herobids' first-party trading ownership through the
generic External Backend architecture.

The current REST boundary is sufficient for the staging operational proof. It
is not the target generic External Backend design and must not be presented as
the final legal or payment-provider boundary.

## Phase 1: Restore And Prove Staging

1. **Recover Herobids staging.** Diagnose Terraform state, server lifecycle,
   DNS, TLS, SSH, Docker Compose, migrations, and container health. Restore
   the known Herobids baseline before adding Traderton.

2. **Create Traderton staging infrastructure.** Provision a dedicated Traderton
   VM in the same Hetzner location and private network as Herobids staging.
   Give it independent Postgres, Redis, secrets, deployment lifecycle, health
   checks, logs, backup policy, and isolated Terraform state. Configure public
   `staging.traderton.com` for the site while keeping the execution boundary
   private. **Resolve shared-network ownership in this step's plan first:**
   confirm the network actually exists (Herobids' `hcloud_network` is gated on
   `enable_nomad` and may be absent), designate a single owning Terraform state
   (so the consuming state cannot destroy it), and define attach-only
   consumption, firewall source rules, and destroy-lifecycle before any apply.

3. **Deploy the Traderton boundary.** Freeze and record the exact herobids +
   traderton release SHAs (D2) and deploy those immutable refs onto the new VM,
   run migrations, provision the HMAC signing identity and credential-
   encryption key, and verify `/health/ready` and the private-only reachability
   of the boundary.

4. **Integrate Herobids with Traderton.** Configure the current Herobids
   boundary URL and HMAC credentials. Validate account provisioning, read
   tools, `submit_decision`, bot lifecycle, and failure mapping end to end.

5. **Operational readiness and rollback.** Measure latency, simulate boundary
   restart, verify health-gating and idempotent retry, record both deployed
   commit SHAs, rehearse routing/deployment rollback, and write the staging
   runbook and a staging soak.

### Phase 1 Exit Criteria

- Herobids and Traderton run independently on staging.
- The Traderton execution boundary is reachable only over the intended private
  path and authenticates callers.
- Operational readiness evidence covers health, latency, restart, idempotency,
  and rollback, measured against traderton `005-consumer-boundary-contract.md`
  §Required Verification and `007-operational-readiness.md` as the baseline.
- Equivalence/shadow validation and full-scale load testing are full-cutover
  obligations and are explicitly deferred to Step 16 (final staging proof),
  not required for this interim operational milestone.
- No infrastructure mutation occurs without explicit operator approval.

## Phase 2: Traderton Product Surface

6. **Move trading documentation.** Establish Traderton as the canonical home
   for trading reference material, venue guides, and wallet-funding guidance.
   Herobids retains only permitted generic or referential documentation.

7. **Build the minimal Traderton frontend.** Serve documentation, venue guides,
   service status, and product identity at `staging.traderton.com`. A trading
   dashboard is later work. This public site does not expose the execution
   boundary.

8. **Audit the legal/product boundary.** Inventory Herobids trading-specific
   UI, API, setup, credential, billing, SEO, skill, and marketplace surfaces.
   Decide what becomes generic, moves to Traderton, or is removed. Obtain
   payment-provider and legal guidance for any retained orchestration or link.

## Phase 3: Generic External Backend And Skill Model

9. **External Backend Genericization Discovery.** Satisfy all six ADR 015
   Discovery Exit Criteria: (1) symbol-level disposition for every export in
   `packages/domain/src/traderton/` and `packages/domain/src/trading/`; (2) an
   importer inventory (genericize / move / delete / defer); (3) the concrete
   External Backend Definition, descriptor trust, key rotation, revocation, and
   failure behaviour; (4) an end-to-end trace from skill install through
   descriptor resolution, tool visibility, invocation, and result mapping;
   (5) the MCP comparison (deferred vs revised, with evidence); (6) the
   legal/product questions engineering cannot settle.

10. **External Backend contract and trust plan.** Draft the implementation
    plan from Step 9's discovery: `ExternalBackendDefinition`,
    `ExternalBackendClient`, descriptor signing and pinning, source-skill
    matching, key rotation/revocation, availability, and generic
    invocation/status/health behavior.

11. **Generic client migration.** Replace Traderton-specific consumer client,
    configuration, contracts, and context ports with generic External Backend
    infrastructure.

12. **External skill deep integration.** Preserve ordinary skills.sh skills as
    instruction-only. An installed skill receives backend tools only when it
    matches an enabled External Backend Definition and verified descriptor.

13. **Traderton skill publication.** Publish Traderton-owned `SKILL.md`,
    descriptors, tool descriptions/schemas, and trading documentation.

14. **Remove Herobids first-party trading ownership.** Delete system seeds,
    presets, instructions, static tool ownership, and fallback resolution for
    `system/trading`; no compatibility period is required because no active
    deployment or agent data exists.

15. **Trading-domain module cleanup.** Move
    `trading/venue-capability.ts` to Traderton. Split
    `trading/trading-protocol.ts` so generic agent wake mechanics can remain
    in Herobids while trading payload semantics move to Traderton. Apply the
    discovery disposition to the remaining modules.

16. **Final staging proof.** Register Traderton only through the generic
    External Backend path. Validate descriptor trust/expiry/rotation, health
    based visibility, generic skill resolution, restart/idempotency, and the
    absence of first-party Herobids trading ownership.

## Dependencies And Guardrails

- Phases 1 and 2 can overlap where work does not mutate shared infrastructure.
- **Step 9 (discovery) begins only after Phase 1 operational proof.** Phase 3
  implementation steps 10–16 begin only after Step 9 satisfies all six ADR 015
  Discovery Exit Criteria. (Step 9 is the discovery itself; it is not gated on
  already-completed discovery.)
- MCP remains a future packaging option and is not a Phase 3 prerequisite.
- The superseded RemoteBoundary draft is historical only and must not drive
  implementation.