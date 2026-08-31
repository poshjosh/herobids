# Capability Implementation Roadmap

**Status:** ready  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Foundations Program Master Roadmap](./program/001-master-roadmap.md)
**Normative inputs:** [ADR 008](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md), [ADR 009](../../../tech/architecture/adrs/2026/08/009-automation-as-external-backend.md)

## Purpose

Decompose capability implementation into bounded, phase-specific docs so the
platform can separate native capabilities from external backends, establish a
repo-local intermediate service boundary, and keep later service extraction or
repository splits on one explicit path.

## Scope

This roadmap includes:

1. the ordered executable slices for capability foundations through external-
   backend boundary hardening and later native-capability cleanup
2. the active supporting references and the first ready low-level slice inside
   this feature
3. the phase gates, extraction strategy, and cross-phase invariants that keep
   implementation order stable
4. automation backend extraction as the second external backend, validating the
   generic boundary contract
5. MCP as the third registration and transport mechanism, completing the
   registration story (direct API, skills, MCP)

This roadmap does not include:

1. direct product-code changes
2. unrelated new top-level capabilities during this rollout
3. renaming persisted fields before service extraction is complete
4. treating historical notes as active implementation authority

## Non-Goals

1. Do not combine service extraction with naming cleanup.
2. Do not promote unrelated skill domains into product capabilities during this
   roadmap.
3. Do not let repo-local placement erase the external boundary for a domain the
   platform does not want to own natively.
4. Do not force skills or MCP as the first registration layer when direct API
   integration is sufficient.

## Dependencies

1. [Capability Foundations Program Master Roadmap](./program/001-master-roadmap.md)
   fixes this feature's place in the staged program.
2. [ADR 008](../../../tech/architecture/adrs/2026/08/008-native-capabilities-and-external-backends.md)
   fixes the architecture boundary this roadmap implements. ADR 008 supersedes
   the earlier ADRs 002–004 from July 2026.
3. [ADR 009](../../../tech/architecture/adrs/2026/08/009-automation-as-external-backend.md)
   establishes automation as the second external backend and defines tool
   ownership for `browse_interactive`.
4. The first executable slice in this feature is controlled by
   [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   and [tasks/002-external-backend-boundary-implementation-tasks.md](./tasks/002-external-backend-boundary-implementation-tasks.md).
5. Documents 002 through 011 remain draft phase or supporting docs that must be
   interpreted through the external-backend boundary rule set before later
   execution resumes.

## Fixed Decisions

1. The platform must distinguish native capabilities from external backends.
2. A repo-local external service may live under `externals/<domain>/` while the
   platform core treats it as external from day one.
3. Registration mechanism, capability semantics, and backend location are
   separate concerns.
4. Platform-to-external communication must cross one explicit boundary
   contract.
5. Platform-core tool visibility and health gating must stay generic.
6. Messaging may remain a native capability even when another domain is kept
   external.
7. No direct platform-core imports of external-service implementation are
   allowed.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. helper and module boundaries inside each executable phase
2. the exact service name, auth shape, and client-adapter placement used for
   the first repo-local external backend
3. whether a supporting design reference is consulted directly or summarized in
   the active task list, as long as the controlling ready docs stay unchanged
4. the later packaging path for skill or MCP registration over the same
   boundary contract

Implementation may not use open latitude to collapse the external boundary,
reopen the native-versus-external model, or promote a supporting reference into
a controlling doc silently.

## Child Docs And Sequence

Current executable entry slice:

1. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
2. [tasks/002-external-backend-boundary-implementation-tasks.md](./tasks/002-external-backend-boundary-implementation-tasks.md)

Draft phase docs that require rewrite under the external-backend model before
later execution resumes:

1. [002-capability-foundations.md](./002-capability-foundations.md)
2. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
3. [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md)
4. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
5. [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md)
6. [007-capability-naming-cleanup.md](./007-capability-naming-cleanup.md)
7. [015-automation-backend-extraction.md](./015-automation-backend-extraction.md)
8. [016-mcp-registration-layer.md](./016-mcp-registration-layer.md)

### Draft-To-Ready Reconciliation Rule

Before any draft phase doc (002–007, 015–016) moves to `ready`, it must pass a
reconciliation check confirming its scope, fixed decisions, acceptance
criteria, and validation are consistent with
[013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
and the external-backend boundary model established by ADR 008.

Reconciliation must verify:

1. the doc does not treat the first external domain as a native capability
2. the doc's acceptance criteria and validation do not assume platform-core
   ownership of external-domain business semantics
3. the doc's fixed decisions do not conflict with the separation rules in 013
4. any normative inputs listed in the doc's header are still active and
   unsuperseded

The reconciliation evidence is recorded inside the doc itself, either as a
note in the `## Validation` section or as an inline `**Reconciled:**` line
in the header. A phase gate cannot be entered while its governing doc is
still `draft`.

Supporting references for later phase detail and rewrite:

1. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
2. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
3. [010-capability-activation-model.md](./010-capability-activation-model.md)
4. [011-capability-route-and-response-migration-manifest.md](./011-capability-route-and-response-migration-manifest.md)
5. [014-operational-readiness-for-external-backends.md](./014-operational-readiness-for-external-backends.md)

Historical context only:

1. [archive/002-shared-trading-taxonomy-delta.md](./archive/002-shared-trading-taxonomy-delta.md)
2. [archive/003-taxonomy-impact-map.md](./archive/003-taxonomy-impact-map.md)
3. [012-shared-capability-taxonomy-revision.md](./012-shared-capability-taxonomy-revision.md)
4. [tasks/001-shared-trading-taxonomy-implementation-tasks.md](./tasks/001-shared-trading-taxonomy-implementation-tasks.md)

## Acceptance Criteria

This roadmap is fit for implementation handoff only when:

1. the ordered executable phases are explicit and do not mix with historical
   context
2. the first executable slice is explicit and controlled by docs marked ready
3. the cross-phase invariants and gates prevent platform-core code from
   collapsing the external boundary or special-casing an external domain as
   native by accident
4. the active path distinguishes controlling docs, supporting references, and
   historical docs clearly enough for a spec-based implementation agent to
   follow without guessing
5. the completion condition for the overall capability program remains explicit

## Validation

1. the folder guide in [000-README.md](./000-README.md) points to the same
   first executable slice and classifies historical material consistently
2. the playbook in
   [program/003-spec-agent-playbook.md](./program/003-spec-agent-playbook.md)
   routes an implementation agent through the same current path
3. the first task list in `tasks/` names only ready controlling docs as
   parents and does not require 008 through 011 to enter the slice
4. no superseded `012 -> tasks/001` path remains on the default implementation
   path

## Full Validation Checkpoints

Use narrow validation after each local change, but use the full
`test-and-fix` skill only at implementation milestones.

Run the full skill at these checkpoints:

1. after the current executable slice reaches its boundary-ready checkpoint
   and before later phase execution resumes; for `tasks/002`, this is after T4
   and before later route and visibility phases begin
2. after each later phase that changes shared runtime, routing, visibility,
   integration, or boundary enforcement behavior
3. before the overall Capability Foundations rollout is marked complete

Explicit skill paths by IDE:

1. GitHub Copilot: `$HOME/.copilot/skills/test-and-fix/`
2. Visual Studio Code: `$HOME/.copilot/skills/test-and-fix/`
3. AWS Kiro: `$HOME/.kiro/skills/test-and-fix/`

Do not assume a spec-driven LLM agent will discover that skill automatically.
When handing off implementation, provide the exact path for the current IDE.

## Extraction Strategy

Two boundary patterns are mandatory in this roadmap:

1. **Repo-local external boundary first.** The platform must talk to a
   repo-local external backend over the same explicit contract it would use for
   a later off-repo domain.
2. **Move-by-repointing later.** Once the boundary contract, config, auth, and
   health model are stable, moving the external service to its own repository
   and domain should require base-URL and deployment changes rather than a
   platform semantic rewrite.

## Phase Gates

### Gate 1: Boundary model complete

Required before implementation spreads beyond the first slice:

1. the governing phase doc has passed the draft-to-ready reconciliation check
   and is at status `ready`
2. native capabilities and external backends are explicitly distinguished
3. the repo-local external service model is explicit
4. allowed shared modules and forbidden import directions are explicit
5. direct API is accepted as the first registration mechanism

### Gate 2: Repo-local external service boundary complete

Required before later phase rewrites or execution:

1. the governing phase doc has passed the draft-to-ready reconciliation check
   and is at status `ready`
2. `externals/<domain>/` exists as its own runtime boundary
3. the platform reaches it only over the shared boundary contract
4. the service has its own config, health, and compose wiring
5. no direct platform-core imports of external-service implementation remain

### Gate 3: Generic platform integration complete

Required before native-capability cleanup and later route or visibility work:

1. the governing phase doc has passed the draft-to-ready reconciliation check
   and is at status `ready`
2. the platform client adapter is transport-only
3. visibility and health gating stay generic for external backends
4. auth, timeout, retry, and audit rules are generic rather than domain-owned

### Gate 4: Native capability cleanup complete

Required before feature completion:

1. the governing phase doc has passed the draft-to-ready reconciliation check
   and is at status `ready`
2. any remaining native capability behavior is explicit and justified
3. messaging can remain native without forcing the same model on external
   domains
4. later phase docs have been rewritten to stop assuming the platform owns the
   external domain as a native capability

### Gate 5: Second external backend (automation) boundary complete

Required before the generic boundary contract is considered proven:

1. the governing phase doc
   ([015-automation-backend-extraction.md](./015-automation-backend-extraction.md))
   has passed the draft-to-ready reconciliation check and is at status `ready`
2. `externals/automation/` exists as its own runtime boundary with family-based
   internal structure
3. the same generic boundary contract used for trading works for automation
   without domain-specific extensions in the generic envelope
4. `browse_interactive` executes through the boundary contract
5. the automation backend has its own health, config, compose wiring, and
   billing
6. no direct platform-core imports of `externals/automation/` implementation
   remain

### Gate 6: MCP registration layer complete

Required before the registration story is considered complete:

1. the governing phase doc
   ([016-mcp-registration-layer.md](./016-mcp-registration-layer.md))
   has passed the draft-to-ready reconciliation check and is at status `ready`
2. agents can connect to MCP servers and use their tools through the platform
3. MCP-surfaced tools pass through the existing skill gating and visibility
   model
4. MCP server connections respect an operator-configured allowlist
5. MCP tool names are namespaced to avoid collisions with platform tools

## Completion Condition

The roadmap's governed capability rollout is complete only when:

1. the platform distinguishes native capabilities, external backends, and
   registration mechanisms clearly
2. a repo-local external service can live under `externals/<domain>/` while the
   platform core interacts with it only over the shared boundary contract
3. platform-core code does not import external-service implementation modules
4. generic auth, health, visibility, and audit plumbing support external
   backends without domain-specific platform assumptions
5. moving the first external backend to another repository and domain would
   require deployment and configuration changes, not a platform semantic
   rewrite
6. native capability behavior remains explicit and limited to domains the
   platform intentionally keeps native
7. the generic boundary contract is validated by at least two external backends
   (trading and automation) with different domain characteristics
8. the platform supports three registration mechanisms (direct API, skills,
   MCP) over the same boundary contracts