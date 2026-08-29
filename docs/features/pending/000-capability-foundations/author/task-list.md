# `/Coordinator` Operational Checklist

Use this checklist only to prepare the Capability Foundations documentation set and the supporting `program/` coordination docs. Do not implement product code while working through it.

Purpose:

1. prepare the staged Capability Foundations feature documents and their supporting `program/` coordination docs;
2. prepare the guide that future spec-based implementation agents will follow for Capability Foundations;
3. leave the Capability Foundations implementation path ready for handoff.

Execution rule:

1. work only in the recommended order detailed below.
2. complete one task fully before starting the next;
3. when a task produces a real program document, place that document outside
   `author/` at the exact output path listed in the checklist;
4. keep all work scoped to `000-capability-foundations/` and the supporting
	`program/` docs that coordinate this feature;
5. keep historical or superseded notes clearly separated from active docs;
6. stop and escalate if a task cannot be completed without changing an already
   fixed taxonomy, boundary, or roadmap invariant.

Definition of success:

1. the repo has one staged Capability Foundations documentation path from start to finish;
2. Capability Foundations has a readable high-level doc path plus the supporting `program/` coordination docs;
3. large Capability Foundations slices have middle-level phase docs only where needed;
4. implementation-ready Capability Foundations slices have low-level task lists;
5. a spec-based agent has one unambiguous Capability Foundations starting point.

## Recommended Order

### C01. [DONE] Create the documentation tree

- Expected output file: `docs/features/pending/000-capability-foundations/program/000-document-tree.md`
- Completion criteria:
	- defines the exact folder structure for program docs;
	- defines high-level, middle-level, low-level, active, and historical doc tiers;
	- defines exact naming rules and creation order.

### C02. [DONE] Rewrite the master program roadmap

- Expected output file: `docs/features/pending/000-capability-foundations/program/001-master-roadmap.md`
- Completion criteria:
	- coordinates only the internal Capability Foundations doc path plus the supporting `program/` handoff flow;
	- records the dependency edges and global invariants needed inside that narrowed scope;
	- states what is fixed now versus what remains open for later Capability Foundations documentation work.

### C03. [DONE] Create the authoring rules and feature template

- Expected output file: `docs/features/pending/000-capability-foundations/program/002-feature-doc-template.md`
- Completion criteria:
	- defines the standard structure every feature doc must use;
	- requires purpose, scope, non-goals, dependencies, fixed decisions, open latitude, acceptance criteria, and validation.

### C04. [DONE] Create the implementation playbook for spec-based agents

- Expected output file: `docs/features/pending/000-capability-foundations/program/003-spec-agent-playbook.md`
- Completion criteria:
	- tells an implementation agent how to read the doc system;
	- states where to start;
	- states what to do when code disagrees with plan;
	- states when to update docs and when to stop and escalate.

### C05. [DONE] Create the validation and change-control rules

- Expected output file: `docs/features/pending/000-capability-foundations/program/004-validation-and-change-control.md`
- Completion criteria:
	- defines status values for docs;
	- defines required validation evidence before a feature can be marked complete;
	- defines how plan changes are handled when implementation discoveries occur.

### C06. [DONE] Rewrite the feature inventory

- Expected output file: `docs/features/pending/000-capability-foundations/program/005-feature-inventory.md`
- Completion criteria:
	- lists every active Capability Foundations slice that must exist on the internal handoff path;
	- assigns each slice its exact controlling document or document set;
	- identifies which slices require middle-level phase docs and which do not.

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

### C08. [DONE] Verify the canonical high-level docs within Capability Foundations

- Expected output files: remaining high-level docs within `docs/features/pending/000-capability-foundations/` plus any supporting updates needed in `docs/features/pending/000-capability-foundations/program/`
- Completion criteria:
	- every Capability Foundations slice listed in `005-feature-inventory.md` has its required high-level doc;
	- each high-level doc uses the canonical shape assigned in `005-feature-inventory.md` and follows `002-feature-doc-template.md`.

### C09. [DONE] Verify and tighten middle-level phase docs only where Capability Foundations requires them

- Expected output file pattern: phase docs inside `docs/features/pending/000-capability-foundations/`
- Completion criteria:
	- only large or risky Capability Foundations slices remain split into phases;
	- the internal order of those phases is explicit;
	- the existing phase split reduces implementation ambiguity rather than creating duplicate or competing child docs.

### C10. [DONE] Verify low-level task-list coverage for implementation-ready Capability Foundations slices

- Expected output file pattern: task lists inside `docs/features/pending/000-capability-foundations/tasks/`
- Completion criteria:
	- each execution-ready Capability Foundations slice or phase has one ordered task list;
	- each task list names exact targets, exact validations, and stop conditions;
	- an implementation agent can follow it without guessing the next move.

### C11. [DONE] Link the Capability Foundations doc path end to end

- Expected output files: updates across the `program/` docs, Capability Foundations docs, phase docs, task lists, and playbook
- Completion criteria:
	- the `program/` roadmap links to the Capability Foundations entrypoint and controlling high-level docs;
	- Capability Foundations high-level docs link to phases where needed;
	- phases link to task lists;
	- task lists and playbook link back to their parent docs.

### C12. [DONE] Separate active and historical material within Capability Foundations and its supporting program docs

- Expected output files: updates or moves within `docs/features/pending/000-capability-foundations/` and supporting `docs/features/pending/000-capability-foundations/program/` docs
- Completion criteria:
	- superseded or historical docs are archived or clearly labeled;
	- active docs are the obvious default reading path.

### C13. [DONE] Run the coherence pass

- Expected output file: `docs/features/pending/000-capability-foundations/program/006-coherence-review.md`
- Completion criteria:
	- checks the Capability Foundations doc path for naming drift, broken links, conflicting decisions, missing dependencies, and missing validation;
	- records any remaining blockers before handoff.

### C14. [DONE] Mark the single Capability Foundations starting point for implementation handoff

- Expected output file: `docs/features/pending/000-capability-foundations/program/007-implementation-entrypoint.md`
- Completion criteria:
	- points to the exact first Capability Foundations slice, phase, and task list a spec-based agent should execute;
	- removes ambiguity about where autonomous implementation begins.

## Outstanding Issues

None.