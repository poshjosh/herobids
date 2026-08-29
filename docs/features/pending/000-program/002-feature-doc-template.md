# Feature Document Template

**Status:** proposed  
**Created:** 2026-08-29  
**Depends on:** [000-document-tree.md](./000-document-tree.md), [001-master-roadmap.md](./001-master-roadmap.md)

## Purpose

This document defines the canonical authoring template for new active feature
docs under `docs/features/pending/`.

It is grounded in the current pending docs, especially the recurring structure
already visible in capability foundations, marketplace pricing, advanced live
limit order management, and i18n expansion. It standardizes those patterns for
future canonical docs. It does not rename legacy feature docs in this step.

## Canonical Doc Types

- `001-overview.md`: use when one high-level doc can bound the feature without
  child phase docs.
- `001-roadmap.md`: use when the feature intentionally decomposes into `002+`
  active docs and needs an explicit internal sequence.
- `002-*.md` and later root docs: use only when the `001-roadmap.md` split
  reduces ambiguity. These middle-level docs inherit the template below and
  narrow it to their own slice.
- `000-README.md`: optional folder guide only. It does not replace the
  canonical high-level doc.

## Required Header

Every active `001-overview.md`, `001-roadmap.md`, and `002+` middle-level doc
must start with:

1. title
2. `Status`
3. `Created`
4. one parent or prerequisite line when applicable, such as `Parent roadmap:`,
   `Parent overview:`, or `Prerequisite:`
5. `Normative inputs:` only when another active doc fixes decisions this doc
   relies on

## Required Sections

Every active feature doc must use the sections below in this order.

| Section | Requirement | How to use it |
| --- | --- | --- |
| `## Purpose` | State why the feature or slice exists. | One short paragraph. For `001-roadmap.md`, explain why the feature needs decomposition. |
| `## Scope` | State what this doc authorizes. | Use explicit includes and excludes, or an equivalent boundary statement. |
| `## Non-Goals` | State what this doc does not authorize. | Prevent adjacent work from being pulled in implicitly. |
| `## Dependencies` | Link upstream docs, prerequisites, and blockers. | These must agree with [001-master-roadmap.md](./001-master-roadmap.md) unless this doc is adding a strictly local child dependency. |
| `## Fixed Decisions` | Record decisions that implementation must treat as locked. | Use this for product, architecture, sequencing, and boundary decisions that should not be reopened during implementation. |
| `## Open Latitude` | Record choices left intentionally to implementation. | This is the bounded space where an implementation agent may choose without escalation. |
| `## Acceptance Criteria` | Define observable completion conditions. | Describe behavior or outcomes, not just files touched. |
| `## Validation` | Define the evidence that proves the acceptance criteria. | Prefer focused tests, commands, UAT steps, or other executable checks. |

## Roadmap-Only Required Section

A canonical `001-roadmap.md` must also include `## Child Docs And Sequence`
between `## Open Latitude` and `## Acceptance Criteria`.

This section must:

1. list the `002+` child docs in reading and execution order
2. distinguish active executable child docs from supporting inputs
3. link to `tasks/` only for implementation-ready slices

## Middle-Level Inheritance Rules

Every active `002+` middle-level doc inherits the parent roadmap structure and
must still include all required sections.

Use inheritance as follows:

1. `Purpose` and `Scope` must be rewritten for the child slice.
2. `Non-Goals` must be explicit for the child slice, even if they mostly match
   the parent.
3. `Dependencies` must still link the controlling parent doc and must restate
   any inherited blockers or prerequisites that remain binding on the child
   slice.
4. `Fixed Decisions` may say that parent decisions remain binding, then add
   child-specific locked decisions.
5. `Open Latitude` must be local to the child slice.
6. `Acceptance Criteria` and `Validation` must always be child-local and must
   never be omitted by reference.

## Open Latitude

`Open latitude` means bounded implementation choice that does not require
escalation.

An implementation agent may choose within open latitude only if the choice:

1. stays inside this doc's scope and non-goals
2. preserves dependencies and fixed decisions
3. still satisfies the acceptance criteria and validation
4. does not create a new product policy, cross-feature dependency, or user
   visible contract change

Typical open latitude includes:

1. helper or module boundaries
2. naming of private internals
3. exact test placement and test shape
4. adapter-local implementation details
5. whether to add a supporting optional section for clarity

Not open latitude:

1. changing feature order from [001-master-roadmap.md](./001-master-roadmap.md)
2. expanding scope into an adjacent feature
3. weakening acceptance criteria or validation
4. reopening a fixed decision
5. proceeding past an unresolved prerequisite or blocker

If a choice is still unresolved and requires a product or architecture decision,
it is an `Open Question`, not open latitude.

## Optional Sections

Optional sections are allowed only when they reduce ambiguity. They do not
replace any required section.

Common optional sections:

- `## Summary` or `## TL;DR` for large docs that need a quick entrypoint
- `## Goals` when the doc benefits from a short positive outcome list, but this
   does not replace `## Scope`
- `## Problem`, `## Current Baseline`, or `## Current Code Truth` when the
  current state must be made explicit before proposing changes
- `## Deliverables` or `## Files` when specific artifacts need to be named
- `## Proposed Design` or `## Architecture Direction` when the design needs
  explanation beyond scope and decisions
- `## Implementation Order` when execution sequencing inside one doc matters
- `## Risks` or `## Risks And Mitigations` when the feature has meaningful
  failure modes or tradeoffs
- `## Open Questions` when unresolved decisions still require escalation before
  implementation can begin
- `## Historical Context` when superseded material matters for transition but
  should not control the active path

## Authoring Rules

1. New canonical feature docs must use the exact required section names from
   this template.
2. Legacy headings such as `## Goals`, `## Validation Plan`, and
   `## Validation And Verification` may still exist in older pending docs, but
   new canonical docs should normalize to `## Scope` and `## Validation`.
3. Keep required sections concise and normative. They should remove ambiguity,
   not restate everything known about the feature.
4. Link dependencies to the controlling doc instead of naming them loosely.
5. Use `001-overview.md` unless the feature genuinely needs `002+` child docs.
6. If a feature uses `001-roadmap.md`, that roadmap owns feature-wide scope,
   sequence, fixed decisions, and top-level dependencies. Child docs own their
   slice-local scope, latitude, acceptance criteria, and validation.
7. Do not hide blockers inside `Open Latitude`. Real blockers belong under
   `Dependencies` or `Open Questions`.
8. `Validation` must name concrete evidence. Prefer targeted tests and commands
   over broad statements such as "verify it works."
9. Do not rename legacy feature docs while applying this template. Normalize
   them in later program-control work.

## Minimal Skeleton

Use this skeleton for new canonical docs. Omit the roadmap-only section when
writing `001-overview.md` or a `002+` middle-level doc that does not own child
docs.

```md
# <Feature Title>

**Status:** proposed
**Created:** YYYY-MM-DD
**Parent roadmap:** <optional>
**Parent overview:** <optional>
**Prerequisite:** <optional>
**Normative inputs:** <optional>

## Purpose

## Scope

This doc includes:
1. ...

This doc does not include:
1. ...

## Non-Goals

1. ...

## Dependencies

1. ...

## Fixed Decisions

1. ...

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. ...

## Child Docs And Sequence

Include this section only in `001-roadmap.md`, or in the rare case where a
middle-level orchestration doc explicitly owns downstream child docs.

1. [002-<slug>](./002-<slug>.md)
2. [003-<slug>](./003-<slug>.md)

## Acceptance Criteria

1. ...

## Validation

1. ...
2. `pnpm lint`
```