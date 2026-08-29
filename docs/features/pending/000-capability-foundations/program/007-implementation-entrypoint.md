# Capability Foundations Implementation Entrypoint

**Status:** complete  
**Created:** 2026-08-29  
**Depends on:** [001-master-roadmap.md](./001-master-roadmap.md), [003-spec-agent-playbook.md](./003-spec-agent-playbook.md), [004-validation-and-change-control.md](./004-validation-and-change-control.md), [../000-README.md](../000-README.md), [../001-roadmap.md](../001-roadmap.md), [../013-native-capabilities-and-external-backends.md](../013-native-capabilities-and-external-backends.md), [../tasks/002-external-backend-boundary-implementation-tasks.md](../tasks/002-external-backend-boundary-implementation-tasks.md)

## Purpose

Provide one unambiguous starting point for spec-based implementation of the
current Capability Foundations slice.

## Current Scope

1. This entrypoint applies only to the narrowed Capability Foundations path under `docs/features/pending/000-capability-foundations/`.
2. Do not start from sibling top-level pending folders.
3. Do not treat `author/`, `archive/`, or the derivative [005-feature-inventory.md](./005-feature-inventory.md) as controlling implementation authority.

## Start Here

Read and follow these docs in order:

1. [../000-README.md](../000-README.md)
2. [../001-roadmap.md](../001-roadmap.md)
3. [../013-native-capabilities-and-external-backends.md](../013-native-capabilities-and-external-backends.md)
4. [../tasks/002-external-backend-boundary-implementation-tasks.md](../tasks/002-external-backend-boundary-implementation-tasks.md)

## First Executable Slice

1. Feature: Capability Foundations
2. Current slice: Native Capabilities And External Backends
3. First task list: External Backend Boundary Implementation Tasks
4. Immediate objective: implement the repo-local external-service boundary and
	the generic platform contract that lets the platform treat a same-repo
	external service as if it already lived in another repository and domain.

## Authority Order

Use these docs in descending authority for the current slice:

1. [../013-native-capabilities-and-external-backends.md](../013-native-capabilities-and-external-backends.md) for slice scope, fixed decisions, and acceptance criteria;
2. [../tasks/002-external-backend-boundary-implementation-tasks.md](../tasks/002-external-backend-boundary-implementation-tasks.md) for concrete work items and validation commands under that slice;
3. [../001-roadmap.md](../001-roadmap.md) for phase order, gates, and the later execution path;
4. [../000-README.md](../000-README.md) for navigation and historical classification;
5. [004-validation-and-change-control.md](./004-validation-and-change-control.md) for status normalization, completion evidence, and stop-versus-update rules;
6. [003-spec-agent-playbook.md](./003-spec-agent-playbook.md) for implementation behavior when the code surface disagrees with the docs.

## Do Not Skip Ahead

1. Do not jump directly to 002 through 007 because those later phase docs exist.
2. Do not collapse the external-service boundary because the first backend is
	temporarily in the same repository.
3. Do not use 008 through 011 unless an active controlling doc for the current slice explicitly points to them.
4. Do not widen scope beyond the external-backend boundary slice without an active doc update.

## After This Slice

After T4 in [../tasks/002-external-backend-boundary-implementation-tasks.md](../tasks/002-external-backend-boundary-implementation-tasks.md)
is complete and its narrow validations are green, run the full
`test-and-fix` skill using the explicit IDE path for the current environment:

1. GitHub Copilot: `$HOME/.copilot/skills/test-and-fix/`
2. Visual Studio Code: `$HOME/.copilot/skills/test-and-fix/`
3. AWS Kiro: `$HOME/.kiro/skills/test-and-fix/`

Do not assume the implementation agent will discover that skill automatically.

If that checkpoint passes, return to [../001-roadmap.md](../001-roadmap.md)
and continue only through the later draft phase docs that are explicitly
unblocked by their own phase gates under the external-backend boundary model.

## Stop And Escalate

Stop and escalate instead of improvising when:

1. active docs disagree about scope, sequencing, ownership, or validation;
2. the code can satisfy the slice only by changing a fixed decision or reordering the roadmap;
3. no active task list or active doc authorizes the next move;
4. a required dependency is missing and the current docs did not authorize creating it here.

## Validation

1. derived this entrypoint from the final coherence pass recorded in [006-coherence-review.md](./006-coherence-review.md);
2. matched the start sequence against [001-master-roadmap.md](./001-master-roadmap.md), [003-spec-agent-playbook.md](./003-spec-agent-playbook.md), and [../001-roadmap.md](../001-roadmap.md);
3. confirmed that the first executable slice remains `013 -> tasks/002` across the active narrowed control-doc set.
