# Skill Tool Validation Plan

Ensure every `requiredTools` entry in a skill refers to a real agent tool before
it can reach runtime.

System skills should fail fast at worker startup if they reference a missing
tool. User-authored skills should be rejected by the API on create and update if
they reference unknown tool names.

## Background

- `packages/domain/src/skills.ts` defines built-in skills with `requiredTools`
  as plain string arrays.
- `apps/worker/src/tools/index.ts` builds the actual runtime tool registry from
  tool implementations.
- `apps/api/src/routes/skills.ts` currently validates `requiredTools` only as an
  array of strings.
- `packages/db/src/agent-runtime-descriptor.ts` copies stored `requiredTools`
  into runtime skill definitions without checking that they exist.
- `apps/worker/src/agent.ts` currently drops unknown tool schemas from the LLM
  tool list and only returns `unknown tool` if a missing tool is invoked.
- The current web app lists and selects skills, but does not yet expose a custom
  skill authoring flow. This is primarily an API trust-boundary gap today.

## Scope

### In scope

- A shared canonical agent-tool-name manifest in a package both API and worker
  can import.
- A worker startup assertion for built-in skills.
- API validation for `POST /skills` and `PUT /skills/:id`.
- Handling of invalid tools encountered through `POST /skills/:id/fork`.
- A backstop for already-persisted invalid user-authored skills.
- Focused tests for the manifest, API validation, and runtime behavior.

### Out of scope

- A full custom skill authoring UI.
- Dynamic discovery of worker tools directly from the API process.
- Changes to the existing agent skill picker, which only selects stored skill
  IDs.
- Broad redesign of tool categories or skill capability families.

## Constraints

### API cannot depend on worker implementation code

The repo dependency rules do not allow `apps/api` to import `apps/worker`.
Whatever defines the allowed tool names must live in a shared package, most
naturally `packages/domain`.

### Fail loud, not silent

Once a skill is accepted, its tool surface should be trustworthy. Unknown tool
names should not be silently tolerated in stored skills.

### Existing bad rows may already exist

Write-time validation prevents new bad data only. The implementation needs a
clear strategy for legacy skill rows that already contain unknown tool names.

## Proposed Design

### Shared source of truth

Add a small shared manifest for valid tool names in `packages/domain`, for
example `KNOWN_AGENT_TOOL_NAMES`, plus helper functions such as
`isKnownAgentToolName()` and `findUnknownSkillToolNames()`.

Keep this manifest name-focused rather than moving full worker tool
implementations into a shared package. The worker remains the source of runtime
behavior; the shared manifest becomes the source of allowed names.

### Worker validation

At worker startup, validate two things:

1. the registry built in `apps/worker/src/tools/index.ts` matches the shared
   manifest
2. every built-in skill in `packages/domain/src/skills.ts`, including `BASE_SKILL`,
   references only known tool names

If either check fails, throw a clear startup error listing the missing or extra
tool names.

### API validation

After Zod shape validation in `apps/api/src/routes/skills.ts`, validate
`requiredTools` against the shared manifest for:

1. `POST /skills`
2. `PUT /skills/:id`
3. `POST /skills/:id/fork` when copying from an existing skill

Reject unknown tool names with `400 validation_error` and include structured
details listing the offending tool names.

### Legacy stored-skill backstop

Add a runtime validation step when resolving user-authored skills from the DB in
`packages/db/src/agent-runtime-descriptor.ts`.

Recommended behavior:

- detect unknown tool names before the skill is turned into a runtime skill
- fail loudly with a descriptive error that includes the skill ID and the bad
  tool names
- do not silently drop invalid tools for persisted user-authored skills

This backstop is primarily for rows created before the API validation ships.

## Plan

1. Introduce a shared tool-name manifest and validation helpers.
   Files: `packages/domain/src/tools.ts` or a new `packages/domain/src/tool-catalog.ts`, `packages/domain/src/index.ts`.
   Change: export the canonical tool-name set plus helper functions for unknown-name detection. Keep the API-facing surface simple so it can be reused anywhere skill data is accepted or resolved.
   Dependency: none.

2. Bind the worker registry to the shared manifest and assert built-in skill validity.
   Files: `apps/worker/src/tools/index.ts`, `packages/domain/src/skills.ts`, and a focused worker test file.
   Change: add a validation routine that compares registered tool names against the shared manifest, then validates `BASE_SKILL` and `SYSTEM_SKILLS` against the same set. Run this during worker startup so drift fails fast.
   Dependency: step 1.

3. Reject invalid user-authored skill tools at the API boundary.
   Files: `apps/api/src/routes/skills.ts`, `apps/api/src/routes/skills.test.ts`, and any related functional skill-route tests.
   Change: after Zod parsing, validate `requiredTools` on create and update, and validate copied tool names on fork. Return `400 validation_error` with a stable error shape and the list of unknown tool names.
   Dependency: step 1.

4. Add a read-time backstop for legacy invalid skill rows.
   Files: `packages/db/src/agent-runtime-descriptor.ts` and its tests.
   Change: validate stored user-authored `requiredTools` before constructing runtime skill definitions. Throw a descriptive error instead of letting invalid tool names flow deeper into runtime.
   Dependency: steps 1 and 3.

5. Add focused tests and deployment checks.
   Files: worker registry tests, API route tests, runtime descriptor tests, and this plan's eventual task list.
   Change: cover manifest/registry drift, invalid built-in skill names, API rejection of unknown tools, fork behavior, and legacy stored-skill rejection. Before rollout, run a one-time query or audit script against the `skills` table to detect existing invalid rows.
   Dependency: steps 1 through 4.

## Test Strategy

- Domain-level unit tests for tool-name validation helpers.
- Worker tests proving startup validation catches built-in skill drift and
  manifest/registry mismatches.
- API route tests proving create, update, and fork reject unknown tool names.
- Runtime descriptor tests proving legacy invalid stored skills fail loudly.
- Validation command: `pnpm lint`.

## Rollout Notes

1. Ship the shared manifest and worker built-in-skill assertion first so any
   checked-in drift is caught immediately.
2. Ship API validation next to stop new invalid skill rows from entering the DB.
3. Run a one-time audit for existing `skills.required_tools` rows before or with
   deployment.
4. Keep the runtime descriptor backstop in place even after the audit so older
   environments or manual DB writes cannot silently reintroduce bad data.

## Open Decisions

1. Fork behavior for invalid legacy skills: reject the fork outright, or allow
   the request only after the source skill is repaired. Recommended: reject.
2. Error code naming for invalid tool names: either reuse `validation_error`
   with rich issue details or add a stable sub-code such as
   `skills.unknown_required_tools`. Recommended: keep `validation_error` as the
   top-level error and include a stable issue code in the details payload.
3. Whether to expose the shared tool manifest through an API endpoint for a
   future custom-skill editor. Recommended: out of scope for this slice unless a
   skill authoring UI starts immediately.

## Exit Criteria

- The worker fails fast if a built-in skill references a non-existent tool.
- `POST /skills`, `PUT /skills/:id`, and fork flows cannot persist unknown tool
  names.
- Legacy invalid stored skills are surfaced loudly instead of being silently
  degraded.
- The allowed tool-name source lives in a shared package rather than creating an
  API-to-worker dependency.
- Focused tests and `pnpm lint` pass.# Skill Tool Validation Plan

## Status
`todo`

## Goal

Ensure every `requiredTools` entry in a skill refers to a real agent tool before
the skill can be used.

This rollout should cover both sources of truth:

1. built-in system skills defined in `packages/domain/src/skills.ts`
2. user-authored skills submitted through the API and later selected by agents

The target behavior is fail-fast and loud:

- system skill drift should stop the worker at startup
- invalid user-authored skill payloads should be rejected at API write time
- already-persisted invalid user skills should be surfaced explicitly rather than
  silently degrading at runtime

## Why This Needs A Planned Rollout

The current behavior is split across layers and leaves a validation gap:

- `packages/domain/src/skills.ts` stores tool names as plain strings
- `apps/api/src/routes/skills.ts` only validates `requiredTools` as `string[]`
- `apps/worker/src/tools/index.ts` builds the real runtime registry from tool
  implementations
- the worker currently drops unknown tool schemas from LLM tool definitions and
  only returns `unknown tool` if a call reaches execution

That means a typo in a built-in skill or a bad API payload can survive until an
agent tick, which is too late for a capability contract.

## Confirmed Baseline

1. the worker tool registry is assembled in `apps/worker/src/tools/index.ts`
2. shared tool types already live in `packages/domain/src/tools.ts`
3. built-in skill definitions live in `packages/domain/src/skills.ts`
4. skill create/update routes live in `apps/api/src/routes/skills.ts`
5. current web flows select existing skills by ID; there is no shipped custom
   skill-authoring UI yet
6. invalid user-authored skill rows may already exist because prior writes were
   not validated against real tool names

## Scope

### In scope

1. a shared canonical agent-tool name catalog in a package both API and worker
   can import
2. worker startup assertions for registry/catalog parity and built-in skill tool
   validity
3. API validation for `POST /skills` and `PUT /skills/:id`
4. a safety path for already-stored invalid user-authored skills
5. unit and route-test coverage for the new validation rules

### Out of scope

1. a new custom skill-authoring UI
2. dynamic runtime discovery of worker tools by the API across process
   boundaries
3. broader validation of `contextRequirements` or `requiredGuardrails`
4. automatic repair or mutation of already-invalid skill rows in the database

## Working Rules

1. API write-time validation is the trust boundary for user-authored skills.
2. Worker startup validation is the trust boundary for built-in skill
   definitions.
3. Unknown tool names must fail loud; they must not be silently ignored.
4. Shared validation inputs must respect repo dependency direction, so the API
   must not import worker tool modules.
5. Validation failures should preserve the existing structured API pattern:
   `validation_error` plus actionable details.

## Target Architecture

### Shared canonical tool catalog

Add a new shared module under `packages/domain/src/` that exports:

- the set of valid agent tool names
- a small helper to diff a proposed `requiredTools` array against that set

This should be a domain-level manifest, not an API-local constant and not a
worker-only helper. The worker will still own executable tool implementations,
but both apps will validate against the same catalog.

Preferred shape:

```ts
export const KNOWN_AGENT_TOOL_NAMES = [
  'send_message',
   'publish_artifact',
  'set_memory',
  // ...
] as const;

export function findUnknownSkillTools(requiredTools: string[]): string[] {
  // returns unknown names, de-duped and sorted for stable errors
}
```

### Worker startup assertions

At worker bootstrap or registry construction time, add two fail-fast checks:

1. the shared catalog exactly matches the names registered in the worker tool
   registry
2. every tool referenced by `BASE_SKILL` and `SYSTEM_SKILLS` exists in that
   catalog and registry

If either check fails, the worker should throw a clear startup error listing the
missing or extra names.

### API validation for user-authored skills

Extend the skill create/update validation path so `requiredTools` is refined
against the shared catalog.

Expected behavior:

- valid tools continue normally
- unknown tools return `400`
- the response remains `validation_error`
- details identify the specific invalid tool names so the caller can correct the
  payload

### Existing data safety path

Because invalid rows may already exist, add a read-time guard when resolving
stored skills into runtime capabilities.

Preferred behavior:

- do not block the whole worker process on one bad user-authored row
- do block the affected agent or capability-resolution path loudly
- emit a clear error that identifies the invalid skill ID and unknown tool names

This keeps rollout safe for existing data without silently mutating persisted
rows.

## Ordered Delivery Phases

Ship in this order.

Do not start by patching `skillsRoutes` directly with a duplicated inline list.
Set the shared catalog first so the worker and API cannot drift immediately.

### Phase 0: Shared catalog and validation helper

Goal:
Create one shared source of truth for valid tool names.

Primary files:

- `packages/domain/src/tools.ts` or a new sibling module such as
  `packages/domain/src/tool-catalog.ts`
- `packages/domain/src/index.ts`

Deliverables:

1. add the shared tool-name catalog
2. add a helper that returns unknown tool names from a proposed skill payload
3. export the new symbols from the domain package
4. document in code comments that this catalog exists for skill validation and
   registry parity checks

Acceptance checks:

1. both API and worker can import the catalog from `@herobids/domain`
2. the helper returns stable, de-duplicated, deterministic results
3. no app-to-app imports are introduced

### Phase 1: Worker fail-fast checks for built-in skills

Goal:
Catch drift between built-in skill definitions and the executable registry before
the worker starts serving ticks.

Primary files:

- `apps/worker/src/tools/index.ts`
- `packages/domain/src/skills.ts`
- worker test files around the registry/bootstrap path

Deliverables:

1. add a parity assertion between the shared catalog and the registry assembled
   by `createToolRegistry()`
2. add a built-in skill assertion covering `BASE_SKILL` and `SYSTEM_SKILLS`
3. make startup errors enumerate missing or unexpected tool names for fast
   diagnosis

Acceptance checks:

1. a typo in a built-in skill tool name fails worker startup immediately
2. a tool registered in worker but missing from the shared catalog fails worker
   startup immediately
3. a tool listed in the shared catalog but not registered in worker fails worker
   startup immediately

### Phase 2: API write-time validation for user-authored skills

Goal:
Reject invalid tool names before they are persisted.

Primary files:

- `apps/api/src/routes/skills.ts`
- `apps/api/src/routes/skills.test.ts`
- functional skill route tests as needed

Deliverables:

1. validate `requiredTools` in `CreateSkillSchema`
2. validate `requiredTools` in `UpdateSkillSchema`
3. return `400 validation_error` with details that include the unknown names
4. keep valid payload behavior unchanged

Acceptance checks:

1. `POST /skills` rejects unknown tools
2. `PUT /skills/:id` rejects unknown tools
3. valid create and update flows still pass
4. forking an existing valid skill remains unchanged

### Phase 3: Existing-data safety guard

Goal:
Prevent previously persisted invalid skills from degrading silently at runtime.

Primary files:

- `packages/db/src/agent-runtime-descriptor.ts`
- tests covering stored-skill resolution

Deliverables:

1. validate stored `requiredTools` when converting DB skill rows into runtime
   skill descriptors
2. fail the affected descriptor-resolution path with a clear error containing
   the skill ID and invalid tool names
3. keep the failure scoped to the affected agent or API action, not global
   worker startup

Acceptance checks:

1. a legacy invalid user-authored skill cannot be resolved into a runnable agent
   silently
2. logs or surfaced errors identify which stored skill is invalid
3. valid stored skills still resolve normally

### Phase 4: Optional API/UI affordance follow-through

Goal:
Make future skill-authoring clients consume the same canonical set without
guessing.

Primary files:

- API route layer if a catalog endpoint is added
- web API client only if a custom skill form is introduced

Deliverables:

1. decide whether to expose a read-only tool catalog endpoint for future skill
   editors
2. if not implemented now, leave an explicit note that current scope stops at
   server-side validation because the web app does not yet submit freeform skill
   definitions

Acceptance checks:

1. scope remains explicit
2. no current implementation step depends on a UI that does not exist yet

## Test Strategy

- Domain-level unit tests for the shared catalog helper.
- Worker tests for registry/catalog parity and built-in skill validation.
- API route tests for `POST /skills` and `PUT /skills/:id` rejection paths.
- Stored-skill resolution tests for legacy invalid rows.
- Validation command: `pnpm lint`.
- Focused test command: targeted `vitest` suites for the touched API, worker,
  and runtime-descriptor files.

## Exit Criteria

- Every built-in skill tool name is validated against the live worker registry
  at startup.
- User-authored skills with unknown `requiredTools` are rejected at API write
  time.
- Pre-existing invalid stored skills fail loudly when resolved, without causing
  silent runtime degradation.
- The API and worker both validate against the same shared catalog.
- Focused tests exist for success and failure paths.
- `pnpm lint` passes.

## Implementation Provenance

This feature was implemented in the `backlog-implementation` branch (commit `b440c9e`).

Key files changed:
- `packages/domain/src/tools.ts` — `KNOWN_AGENT_TOOL_NAMES`, `isKnownAgentToolName`, `findUnknownSkillTools`
- `apps/worker/src/tools/index.ts` — registry/catalog parity assertion and built-in skill validation at startup
- `apps/api/src/routes/skills.ts` — `buildUnknownToolValidationError` applied to create, update, and fork paths
- `packages/db/src/agent-runtime-descriptor.ts` — `assertKnownRequiredTools` backstop before converting stored skill rows to runtime descriptors