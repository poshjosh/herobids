# `/Coordinator` Operational Checklist

Use this checklist only to prepare the documentation program. Do not implement product code while working through it.

Purpose:

1. prepare the staged feature program documents;
2. prepare the guide that future spec-based implementation agents will follow;
3. leave the actual implementation folders ready for handoff.

Execution rule:

1. work only in the recommended order detailed below.
2. complete one task fully before starting the next;
3. when a task produces a real program document, place that document outside
   `author/` at the exact output path listed in the checklist;
4. keep historical or superseded notes clearly separated from active docs;
5. stop and escalate if a task cannot be completed without changing an already
   fixed taxonomy, boundary, or roadmap invariant.

Definition of success:

1. the repo has one staged feature program from start to finish;
2. every active feature has a readable high-level doc;
3. large features have middle-level phase docs only where needed;
4. implementation-ready features have low-level task lists;
5. a spec-based agent has one unambiguous starting point.

## Recommended Order

### C01. [DONE] Create the documentation tree

- Expected output file: `docs/features/pending/000-program/000-document-tree.md`
- Completion criteria:
	- defines the exact folder structure for program docs;
	- defines high-level, middle-level, low-level, active, and historical doc tiers;
	- defines exact naming rules and creation order.

### C02. [DONE] Create the master program roadmap

- Expected output file: `docs/features/pending/000-program/001-master-roadmap.md`
- Completion criteria:
	- lists all major features in execution order;
	- records feature dependencies and global invariants;
	- states what is fixed now versus what remains open for later implementation.

### C03. [DONE] Create the authoring rules and feature template

- Expected output file: `docs/features/pending/000-program/002-feature-doc-template.md`
- Completion criteria:
	- defines the standard structure every feature doc must use;
	- requires purpose, scope, non-goals, dependencies, fixed decisions, open latitude, acceptance criteria, and validation.

### C04. [DONE] Create the implementation playbook for spec-based agents

- Expected output file: `docs/features/pending/000-program/003-spec-agent-playbook.md`
- Completion criteria:
	- tells an implementation agent how to read the doc system;
	- states where to start;
	- states what to do when code disagrees with plan;
	- states when to update docs and when to stop and escalate.

### C05. [DONE] Create the validation and change-control rules

- Expected output file: `docs/features/pending/000-program/004-validation-and-change-control.md`
- Completion criteria:
	- defines status values for docs;
	- defines required validation evidence before a feature can be marked complete;
	- defines how plan changes are handled when implementation discoveries occur.

### C06. [DONE] Create the feature inventory

- Expected output file: `docs/features/pending/000-program/005-feature-inventory.md`
- Completion criteria:
	- lists every major feature that must exist between current state and target state;
	- assigns each feature an exact folder name and title;
	- identifies which features require middle-level phase docs and which do not.

### C07. [DONE] Normalize Capability Foundations as the first executable model

- Expected output files:
	- `docs/features/pending/000-capability-foundations/000-README.md`
	- `docs/features/pending/000-capability-foundations/001-roadmap.md`
	- `docs/features/pending/000-capability-foundations/012-shared-capability-taxonomy-revision.md`
	- `docs/features/pending/000-capability-foundations/tasks/001-shared-trading-taxonomy-implementation-tasks.md`
- Completion criteria:
	- Capability Foundations clearly fits the document-tree rules;
	- active docs and historical docs are clearly separated;
	- the first executable slice is explicit.

### C08. [DONE] Create one canonical high-level doc for every remaining feature

- Expected output file pattern: `docs/features/pending/<feature-folder>/001-overview.md` or `docs/features/pending/<feature-folder>/001-roadmap.md`
- Completion criteria:
	- every feature listed in `005-feature-inventory.md` has one high-level doc;
	- each high-level doc uses the exact canonical shape assigned in `005-feature-inventory.md` and follows `002-feature-doc-template.md`.

### C09. [PENDING] Create middle-level phase docs only where required

- Expected output file pattern: `docs/features/pending/<feature-folder>/002-*.md`, `003-*.md`, and so on
- Completion criteria:
	- only large or risky features are split into phases;
	- the internal order of those phases is explicit;
	- the phase split reduces implementation ambiguity rather than creating more of it.

### C10. [PENDING] Create low-level task lists only for implementation-ready slices

- Expected output file pattern: `docs/features/pending/<feature-folder>/tasks/001-*.md`
- Completion criteria:
	- each execution-ready feature or phase has one ordered task list;
	- each task list names exact targets, exact validations, and stop conditions;
	- an implementation agent can follow it without guessing the next move.

### C11. [PENDING] Link the whole doc system end to end

- Expected output files: updates across the roadmap, feature docs, phase docs, task lists, and playbook
- Completion criteria:
	- roadmap links to features;
	- features link to phases where needed;
	- phases link to task lists;
	- task lists and playbook link back to their parent docs.

### C12. [PENDING] Separate active and historical material everywhere

- Expected output files: updates or moves across affected folders
- Completion criteria:
	- superseded or historical docs are archived or clearly labeled;
	- active docs are the obvious default reading path.

### C13. [PENDING] Run the coherence pass

- Expected output file: `docs/features/pending/000-program/006-coherence-review.md`
- Completion criteria:
	- checks naming drift, broken links, duplicated features, conflicting decisions, missing dependencies, and missing validation;
	- records any remaining blockers before handoff.

### C14. [PENDING] Mark the single starting point for implementation handoff

- Expected output file: `docs/features/pending/000-program/007-implementation-entrypoint.md`
- Completion criteria:
	- points to the exact first feature, phase, and task list a spec-based agent should execute;
	- removes ambiguity about where autonomous implementation begins.

## Outstanding Issues

None.