# Marketplace Pricing for Skills and Blueprints

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose marketplace pricing into ordered slices so the platform can finish
paid skill access first, then add blueprint monetization on top of a stable
shared purchase contract without breaking the existing free-only blueprint
dependency boundary.

## Scope

This roadmap includes:

1. the shared marketplace purchase contract and ledger for paid assets
2. end-to-end pricing and entitlement flow for skills
3. blueprint pricing and entitlement flow limited to dependency-simple v1
4. audit, refund, and supportability surfaces for paid marketplace assets

This roadmap does not include:

1. automated creator payouts in the first version
2. bundling paid skill dependencies inside priced blueprints in v1
3. redesign of plan subscriptions or runtime usage billing
4. product-code implementation in this documentation step

## Non-Goals

1. Do not price immutable revisions as the primary purchased asset.
2. Do not mix one-time marketplace purchases with ongoing runtime billing.
3. Do not let blueprint pricing pre-empt completion of the missing skill
   pricing flow.
4. Do not let refund or revocation semantics corrupt already assigned or
   already instantiated user state.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after blank-slate agents, LLM cost attribution, and
   unified skill discoverability.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [001-plan.md](./001-plan.md) remains the legacy source for the commercial
   contract, phased skill-first sequencing, and v1 blueprint limits.
4. [../../2026/08/02/001-blueprint-marketplace-likes/001-plan.md](../../2026/08/02/001-blueprint-marketplace-likes/001-plan.md),
   [../../2026/08/01/003-agent-bot-config-harmonization/003-agent-blueprint-marketplace-phase-1-implementation.md](../../2026/08/01/003-agent-bot-config-harmonization/003-agent-blueprint-marketplace-phase-1-implementation.md),
   and [../../2026/06/13/002-skills-management/001-skills-model-normalization-plan.md](../../2026/06/13/002-skills-management/001-skills-model-normalization-plan.md)
   remain supporting background inputs.

## Fixed Decisions

1. Marketplace purchases grant access to the stable catalog asset, not only the
   published revision present at checkout time.
2. Skill and blueprint pricing use one shared marketplace purchase
   infrastructure.
3. Runtime usage billing remains separate from one-time asset purchase pricing.
4. Priced blueprints in v1 may depend only on system skills or free published
   user skills.
5. Refund and revocation may block future new use but must not silently break
   already assigned skills or already instantiated assets.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact table and route naming for the shared purchase ledger and checkout
   flow
2. exact read-model shape used to expose purchase state in the UI and APIs
3. exact support and audit surfaces, as long as purchase provenance and
   entitlement lineage remain explicit

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-commercial-contract-and-purchase-ledger.md`
2. `003-shared-marketplace-checkout-and-entitlements.md`
3. `004-end-to-end-skill-pricing.md`
4. `005-blueprint-pricing-with-free-only-dependencies.md`
5. `006-observability-audit-and-refund-support.md`

Supporting task lists should start only after the first child docs fix the
catalog-level purchase contract and the skill-first sequence.

## Acceptance Criteria

1. The roadmap fixes the skill-first sequence and keeps blueprint pricing as a
   second stage on top of shared purchase infrastructure.
2. The feature-wide decisions keep marketplace pricing separate from runtime
   billing and preserve the current blueprint dependency boundary.
3. The child-doc order matches the source plan's Phase A through Phase E
   rollout.
4. Later C09 and C10 work can decompose the feature without guessing the
   commercial contract or refund semantics.

## Validation

1. Compared the child-doc sequence and fixed decisions against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
