# POST /skills Returns 500 in Functional Tests

**Date**: 2026-08-03
**Severity**: MEDIUM → **FIXED** (duplicate of 005)
**Plan**: [001-fix-skills-500-functional-tests](../../../features/2026/03/001-fix-skills-500-functional-tests/001-plan.md)
**Found during**: test-and-fix validation run

## Summary

Same root cause as [005-skills-creation-500-build-skill-views-crash](./005-skills-creation-500-build-skill-views-crash.md): `skills.published_revision_id` FK constraint violated when inserting the skills row before the `skillRevisions` row.

## Fix

Same 3-step insert pattern applied to `POST /skills` and `POST /skills/:id/fork`: insert with null FK pointers → insert revision → UPDATE FK pointers.
