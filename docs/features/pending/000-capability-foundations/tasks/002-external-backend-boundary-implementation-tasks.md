# External Backend Boundary Implementation Tasks

**Status:** ready
**Created:** 2026-08-29
**Parent docs:** [Capability Implementation Roadmap](../001-roadmap.md), [Native Capabilities And External Backends](../013-native-capabilities-and-external-backends.md)

## Purpose

Turn the repo-local external-backend model into concrete implementation work
so the platform can host an intermediate `externals/<domain>/` service while
treating it everywhere else as if it already lived in another repository and
domain.

Read this task list after [Capability Implementation Roadmap](../001-roadmap.md)
and [Native Capabilities And External Backends](../013-native-capabilities-and-external-backends.md).

## Execution Rules

1. Do not import implementation modules from `externals/<domain>/` into
   `apps/api`, `apps/worker`, `apps/web`, or shared platform packages.
2. Use direct API calls first. Do not block on skill or MCP packaging.
3. Keep the platform-core side generic: transport, auth, readiness, health,
   audit, and visibility composition only.
4. Keep domain-specific policy, persistence semantics, and tool meaning inside
   the external service boundary.

## Task List

### T1. Define the generic external-backend invocation contract

**Status:** `not-started`

Touchpoints:

1. `packages/domain/src/external-backend-contract.ts`
2. `packages/domain/src/index.ts`
3. `packages/domain/src/external-backend-contract.test.ts`

Work:

1. define a versioned request-response contract for repo-local or remote
   external tool backends
2. keep the contract generic over backend identity and tool name
3. add auth, correlation, deadline, and health-envelope fields needed by the
   platform core
4. avoid embedding domain-specific provider, family, or policy semantics in
   the shared contract

Validation:

1. add or update `packages/domain/src/external-backend-contract.test.ts`
2. run `pnpm test -- packages/domain/src/external-backend-contract.test.ts`
3. run `rg -n "trading|messaging" packages/domain/src/external-backend-contract.ts`
4. run `pnpm lint`

### T2. Create the first repo-local external service boundary

**Status:** `not-started`

Touchpoints:

1. `externals/trading/package.json`
2. `externals/trading/src/`
3. `docker-compose.dev.yaml`
4. `docker-compose.yaml`
5. `Dockerfile` or an external-service-specific Docker target

Work:

1. create `externals/trading/` as a standalone runtime with its own entrypoint
2. give it its own config surface and health endpoints
3. wire it into local compose as a separate service
4. ensure the platform only reaches it over the shared boundary contract

Validation:

1. run `rg -n "externals/trading" docker-compose.dev.yaml docker-compose.yaml Dockerfile`
2. run `rg -n "from .*externals/trading|from '../externals/trading|from '../../externals/trading" apps packages`
3. run `pnpm lint`

### T3. Add a transport-only platform client adapter

**Status:** `not-started`

Touchpoints:

1. `apps/worker/src/external-backends/`
2. `apps/api/src/external-backends/` if API needs the same boundary
3. platform config that stores the external base URL and auth references

Work:

1. add a client adapter that knows only base URL, auth, timeout, retry, and
   response mapping
2. keep backend-specific business semantics out of the client adapter
3. make the configured base URL swappable so the same client can later point to
   another repository and domain without semantic rewrites

Validation:

1. add or update client boundary tests under the touched package
2. run the narrow test command for the new client test file or files
3. run `rg -n "http://|https://|baseUrl" apps/worker/src/external-backends apps/api/src/external-backends`
4. run `pnpm lint`

### T4. Enforce the repo boundary rule

**Status:** `not-started`

Touchpoints:

1. repo linting, architecture checks, or test helpers that can fail on direct
   imports
2. docs or guard scripts that define forbidden import directions

Work:

1. add an enforceable check that platform-core code cannot import
   implementation modules from `externals/trading/`
2. fail loudly on future direct-import regressions
3. document the allowed shared-module categories near the enforcement surface

Validation:

1. run the architecture or lint check that enforces the import boundary
2. run `rg -n "externals/trading" apps packages | sed -n '1,120p'`
3. run `pnpm lint`

## Stop And Escalate

Stop and escalate instead of widening this task list when any of the following
becomes necessary:

1. a platform-core module needs to import business logic from
   `externals/trading/`
2. the shared contract needs domain-specific provider, family, or policy terms
3. a direct-API-first integration is blocked solely because skills or MCP do
   not exist yet
4. the platform wants to treat the first external domain as a native capability
   in UX, readiness, or route semantics without an explicit doc update

## Suggested Order

1. T1 external-backend contract
2. T2 repo-local external service boundary
3. T3 platform client adapter
4. T4 boundary enforcement

## Full Validation Skill Checkpoints

Use narrow task-level validation while implementing each item above.

Run the full `test-and-fix` skill at these checkpoints:

1. after T4 is complete and its narrow validations are green, before treating
   the repo-local external backend boundary as ready for later route and
   visibility phases

Explicit skill paths by IDE:

1. GitHub Copilot: `$HOME/.copilot/skills/test-and-fix/`
2. Visual Studio Code: `$HOME/.copilot/skills/test-and-fix/`
3. AWS Kiro: `$HOME/.kiro/skills/test-and-fix/`

Do not assume a spec-driven implementation agent will find that skill
automatically. Provide the exact path when invoking the full validation step.

## Completion Check

This task list is complete only when:

1. the platform can call a repo-local `externals/<domain>/` service only over
   the shared boundary contract
2. platform-core code does not directly import external-service
   implementation modules
3. the client base URL can later move off-repo without changing platform-core
   semantics
4. the repo-local external backend boundary is ready for later route and
   visibility phases owned by [../003-capability-resolution-and-route-migration.md](../003-capability-resolution-and-route-migration.md)
   and [../004-worker-tool-visibility-enforcement.md](../004-worker-tool-visibility-enforcement.md)
5. `pnpm lint` passes
