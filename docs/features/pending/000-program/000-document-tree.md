# Program Documentation Tree

**Status:** proposed  
**Created:** 2026-08-29

## Purpose

This document defines the canonical document tree for the staged program under
`docs/features/pending/`.

It is grounded in the current repo state:

- pending features already exist as top-level folders such as
  `000-capability-foundations`, `001-hyperliquid-perp-preset-tuning`,
  `002-blank-slate-agents`, `003-agent-chat-sessions`, and
  `007-llm-cost-attribution-metrics`;
- `000-capability-foundations/` already demonstrates the richest current shape:
  `000-README.md`, `001-roadmap.md`, numbered design docs, `tasks/`,
  `diagrams/`, `author/`, and `archive/`;
- several other pending features still use legacy names such as `001-plan.md`,
   `000-note.md`, and `000-preamble.md`.

This step defines the normalized target structure. It does not require renaming
or moving existing feature docs yet.

## Canonical Tree

Program root: `docs/features/pending/`

### Program-Control Folder

| Path | Role | Required |
| --- | --- | --- |
| `000-program/000-document-tree.md` | canonical tree definition | yes |
| `000-program/001-master-roadmap.md` | program execution order | yes |
| `000-program/002-feature-doc-template.md` | feature authoring template | yes |
| `000-program/003-spec-agent-playbook.md` | implementation-agent playbook | yes |
| `000-program/004-validation-and-change-control.md` | status and validation rules | yes |
| `000-program/005-feature-inventory.md` | assigned feature inventory | yes |
| `000-program/006-coherence-review.md` | final coherence review | yes |
| `000-program/007-implementation-entrypoint.md` | single handoff entrypoint | yes |
| `000-program/author/` | non-authoritative working material | optional |
| `000-program/archive/` | superseded or historical program docs | optional |

### Feature Folder

Every feature folder lives directly under `docs/features/pending/` and uses the
form `NNN-kebab-case-title/`.

| Path inside `NNN-kebab-case-title/` | Role | Required |
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

1. `000-program/` is the program-control folder for the whole staged pending
   documentation set.
2. Every implementation feature lives in its own top-level feature folder under
   `docs/features/pending/`.
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

The active tier is the default reading path a future implementation agent must
follow.

It includes:

- all numbered documents in `000-program/` except anything later moved under
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

Program level:

- `000-program/001-master-roadmap.md`
- `000-program/005-feature-inventory.md`
- `000-program/007-implementation-entrypoint.md`

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

### Historical Tier

The historical tier preserves context without competing with the active path.

Canonical location:

- `archive/` inside `000-program/` or a feature folder.

Historical docs must not consume active root numbering once they are known to
be superseded. Move them under `archive/` and update active docs to reference
them there.

## Naming Rules

### Folder Names

1. The program-control folder is exactly `000-program/`.
2. Feature folders use `NNN-kebab-case-title/`.
3. `NNN` is always a three-digit, zero-padded feature ID.
4. The feature ID is assigned once and is stable after publication.
5. Existing pending feature IDs are preserved. C01 does not renumber them.
6. New feature IDs come from the program inventory once that file exists.

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

### Program-Level Creation Order

Create the program-control docs in this exact order:

1. `000-program/000-document-tree.md`
2. `000-program/001-master-roadmap.md`
3. `000-program/002-feature-doc-template.md`
4. `000-program/003-spec-agent-playbook.md`
5. `000-program/004-validation-and-change-control.md`
6. `000-program/005-feature-inventory.md`
7. normalize the first executable model feature under these rules
8. create the remaining feature high-level docs
9. add middle-level docs only where the high-level docs require them
10. add low-level task lists only for implementation-ready slices
11. separate or archive superseded material
12. `000-program/006-coherence-review.md`
13. `000-program/007-implementation-entrypoint.md`

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

## Normalization Rules For Current Pending Docs

This repo already contains legacy pending docs. Until later checklist items
normalize them, interpret them as follows:

1. `001-plan.md` is treated as a provisional equivalent of `001-overview.md`.
2. `000-note.md` and `000-preamble.md` are treated as preparation material,
   equivalent in role to `author/` inputs unless later promoted.
3. Existing unnumbered or irregular feature folders remain untouched in C01.
   Later inventory and coherence steps decide whether they stay, rename, or
   archive.
4. Do not create new pending docs using the legacy `001-plan.md` naming once
   this tree spec exists.

## Fit With `000-capability-foundations/`

`000-capability-foundations/` is the current reference example for a rich,
multi-document feature folder.

Under this tree spec:

1. `000-README.md` remains the active folder guide.
2. `001-roadmap.md` remains the canonical high-level roadmap.
3. `002` through the active numbered design docs are the middle-level tier.
4. `tasks/001-shared-trading-taxonomy-implementation-tasks.md` is the low-level
   execution tier.
5. `diagrams/` remains a support directory.
6. `author/` remains non-authoritative preparation material.
7. historical transition notes belong under `archive/` and are not part of the
   default implementation path.

That means this spec reads with the current structure rather than requiring a
destructive reset before the rest of the program docs can be written.