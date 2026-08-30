# Capability Foundations Program Documentation Tree

**Status:** complete  
**Created:** 2026-08-29

## Purpose

This document defines the canonical local coordination tree for Capability
Foundations under `docs/features/pending/000-capability-foundations/`.

It is grounded in the current repo state:

- `000-capability-foundations/` is the active feature root for capability
   isolation, route alignment, tool ownership, activation, and service
   extraction;
- `program/` now sits inside that feature root as the local coordination,
   handoff, and validation folder for this feature only;
- the Capability Foundations feature root already demonstrates the broader
   active shape: `000-README.md`, `001-roadmap.md`, numbered design docs,
   `tasks/`, `diagrams/`, `author/`, `archive/`, and now `program/`.

This step defines the normalized local structure for Capability Foundations.

## Canonical Tree

Capability Foundations root: `docs/features/pending/000-capability-foundations/`

### Program Folder

| Path | Role | Required |
| --- | --- | --- |
| `program/000-document-tree.md` | canonical tree definition | yes |
| `program/001-master-roadmap.md` | current coordination order | yes |
| `program/002-feature-doc-template.md` | feature authoring template | yes |
| `program/003-spec-agent-playbook.md` | implementation-agent playbook | yes |
| `program/004-validation-and-change-control.md` | status and validation rules | yes |
| `program/005-feature-inventory.md` | derivative coordination index for the current scope | yes |
| `program/006-coherence-review.md` | final coherence review | yes |
| `program/007-implementation-entrypoint.md` | single handoff entrypoint | yes |
| `program/author/` | non-authoritative working material | optional |
| `program/archive/` | superseded or historical program docs | optional |

### Capability Foundations Feature Root

The active feature root for this coordination set is
`docs/features/pending/000-capability-foundations/`.

| Path inside `000-capability-foundations/` | Role | Required |
| --- | --- | --- |
| `000-README.md` | folder guide for complex feature folders | optional |
| `001-overview.md` | canonical high-level doc for a single-slice feature | exactly one of this row or the next row |
| `001-roadmap.md` | canonical high-level doc for a multi-phase feature | exactly one of this row or the previous row |
| `002-<phase-or-design>.md` and later sequential root docs | middle-level phase or design docs | optional when the high-level doc requires a split |
| `tasks/001-<implementation-slice>.md` and later sequential task docs | low-level execution checklists | optional when a slice is implementation-ready |
| `diagrams/<supporting-diagram>.md` | referenced support diagrams | optional |
| `author/<working-notes>.md` | non-authoritative preparation material | optional |
| `archive/<historical-doc>.md` | superseded or historical feature docs | optional |

## Interpretation Of The Tree

The tree above is interpreted as follows:

1. `program/` is the structural local coordination folder for Capability
   Foundations.
2. Its live execution scope is defined by the active master roadmap and
   implementation entrypoint inside this same feature root.
3. `author/` is for preparation material only. It is not part of the active
   implementation path.
4. `archive/` is for historical, superseded, or retained-reference material.
   It is not part of the active implementation path.
5. `diagrams/` is a support surface. It may exist only when an active document
   explicitly references a diagram inside it.
6. `tasks/` contains low-level execution checklists. It exists only when a
   feature or phase is implementation-ready.

## Document Tiers

### Active Tier

The active tier is the active control surface a future implementation agent may
need to follow or consult.

Active status alone does not place a doc on the first-read sequence. The
current master roadmap, playbook, and eventual implementation entrypoint
decide the live entry path.

It includes:

- all numbered documents in `program/` except anything later moved under
  `archive/`;
- the active top-level numbered docs in a feature folder;
- active task lists under `tasks/`;
- supporting diagrams only when referenced by an active document.

It excludes:

- anything under `author/`;
- anything under `archive/`;
- any file explicitly marked historical or superseded, even if it still sits at
  feature root during transition.

### High-Level Tier

The high-level tier fixes scope, order, and handoff boundaries.

Program-folder level:

- `program/001-master-roadmap.md`
- `program/007-implementation-entrypoint.md`

`program/005-feature-inventory.md` may exist as a derivative coordination
index for the current scope, but it is not a second source of high-level
program authority unless a later roadmap explicitly makes it one.

Feature level:

- `001-overview.md` for a single-slice feature; or
- `001-roadmap.md` for a feature that is intentionally split into multiple
  active phase or design documents.

Only one of `001-overview.md` or `001-roadmap.md` should be the canonical
high-level doc for a newly normalized feature folder.

`000-README.md` is an active entrypoint helper, not the canonical high-level
spec. Use it only when a folder needs a reading guide because it contains
multiple active top-level docs or support directories.

### Middle-Level Tier

The middle-level tier decomposes a feature after the high-level tier has fixed
its boundaries.

It uses:

- `002-*.md`, `003-*.md`, and later numbered root docs in the same feature
  folder.

Newly normalized docs should usually use numeric order as the live reading
order. When legacy numbering is intentionally preserved, the parent
`001-roadmap.md` may explicitly designate a later-numbered child doc as the
current executable slice and classify lower-numbered root docs as later phases
or supporting references. In that case, the parent roadmap controls the live
reading order.

Use this tier only when the split reduces ambiguity. Valid reasons include:

- multi-phase execution order;
- risky boundary changes that need isolated design docs;
- one feature that contains several independently verifiable slices.

Do not create middle-level docs just to mirror implementation modules.

### Low-Level Tier

The low-level tier is the execution surface for implementation agents.

It uses:

- `tasks/001-*.md`, `tasks/002-*.md`, and later task-list files.

Each low-level doc must have one parent in the active high-level or
middle-level tier. A task list must not exist without an upstream feature or
phase doc that fixes scope and validation.

When a parent roadmap declares the legacy-numbering exception above, a task
list may hang from that explicitly designated current slice even if some
lower-numbered root docs remain active later phases or supporting references.

### Historical Tier

The historical tier preserves context without competing with the active path.

Canonical location:

- `archive/` inside `program/` or a feature folder.

Historical docs must not consume active root numbering once they are known to
be superseded. Move them under `archive/` and update active docs to reference
them there.

## Naming Rules

### Folder Names

1. The local coordination folder is exactly `program/`.
2. The active feature folder is `000-capability-foundations/`.
3. Numbered root docs inside the feature folder keep their existing published
   IDs unless a later active doc explicitly renumbers them.

### Root File Names

1. `000-README.md` is reserved for a folder guide.
2. `001-overview.md` is reserved for the canonical high-level doc of a
   single-slice feature.
3. `001-roadmap.md` is reserved for the canonical high-level doc of a
   multi-phase feature.
4. `002-*.md` and above are reserved for active middle-level docs in reading
   order.
5. Do not create a new active root document without the next sequential number.
6. Do not leave gaps in the active root sequence.
7. Do not use status words such as `draft`, `old`, or `final` in active file
   names. Status belongs inside the document, not in the slug.

### Task File Names

1. All low-level docs live under `tasks/`.
2. Task files use `NNN-kebab-case-title.md`.
3. Task numbering starts at `001` inside each `tasks/` directory.
4. Task numbering is local to the feature folder; it does not need to match the
   parent feature ID.

### Author And Historical Names

1. `author/` may contain working material with flexible names.
2. `archive/` may contain historical material with flexible names.
3. Flexible naming inside `author/` and `archive/` does not make those files
   part of the active tier.

## Creation Order

### Program-Folder Creation Order

Create the local coordination docs in this exact order:

1. `program/000-document-tree.md`
2. `program/001-master-roadmap.md`
3. `program/002-feature-doc-template.md`
4. `program/003-spec-agent-playbook.md`
5. `program/004-validation-and-change-control.md`
6. `program/005-feature-inventory.md`
7. normalize the first executable model feature under these rules
8. create the remaining in-scope feature high-level docs named by the active
   master roadmap
9. add middle-level docs only where those in-scope high-level docs require
   them
10. add low-level task lists only for implementation-ready in-scope slices
11. separate or archive superseded material
12. `program/006-coherence-review.md`
13. `program/007-implementation-entrypoint.md`

The numbering is fixed even though documents 006 and 007 are created late.

### Feature-Level Creation Order

Create docs inside each feature folder in this exact order:

1. create the feature folder with its assigned `NNN-kebab-case-title/` name;
2. create the canonical high-level doc:
   `001-overview.md` for a single-slice feature or `001-roadmap.md` for a
   multi-phase feature;
3. add `000-README.md` only if the folder needs a reading guide because it has
   multiple active root docs or support directories;
4. add `002-*.md`, `003-*.md`, and later middle-level docs only after the
   high-level doc justifies the split;
5. create `tasks/` and add `tasks/001-*.md` only after the parent feature or
   phase is stable enough for implementation handoff;
6. add `diagrams/` only after an active doc references a concrete diagram;
7. move superseded or purely historical material into `archive/`.

The reading order remains `000`, then `001`, then `002+`, then `tasks/`.
Creation order allows step 3 after step 2 because `000-README.md` is a guide to
the active set, not the canonical spec itself.

## Normalization Rules For This Feature

This feature already contains legacy and transitional docs. Until later
checklist items normalize them further, interpret them as follows:

1. root files under `archive/` are historical even when they preserve older
   naming or pre-normalization structure;
2. root files under `author/` are preparation material only;
3. a later-numbered ready slice such as `012-shared-capability-taxonomy-revision.md`
   may be the live entry slice when the parent roadmap explicitly declares the
   legacy-numbering exception.
4. Existing unnumbered or irregular feature folders remain untouched in C01.
   Later inventory and coherence steps decide whether they stay, rename, or
   archive.
5. Do not create new pending docs using the legacy `001-plan.md` naming once
   this tree spec exists.

## Fit With `000-capability-foundations/`

`000-capability-foundations/` is the current reference example for a rich,
multi-document feature folder.

Under this tree spec:

1. `000-README.md` remains the active folder guide.
2. `001-roadmap.md` remains the canonical high-level roadmap.
3. `002` through the active numbered design docs are the middle-level tier.
4. `tasks/002-external-backend-boundary-implementation-tasks.md` is the
   current low-level execution tier. (`tasks/001` is superseded.)
5. `diagrams/` remains a support directory.
6. `author/` remains non-authoritative preparation material.
7. historical transition notes belong under `archive/` and are not part of the
   default implementation path.

That means this spec reads with the current structure rather than requiring a
destructive reset before the rest of the program docs can be written.