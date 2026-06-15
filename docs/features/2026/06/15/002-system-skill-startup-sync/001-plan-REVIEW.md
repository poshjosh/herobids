# Review: System Skill Startup Sync

## Verdict

Mostly implemented and aligned with the plan.

The branch adds a dedicated [apps/api/src/sync-system-skills.ts](../../../apps/api/src/sync-system-skills.ts), calls it during API startup in [apps/api/src/index.ts](../../../apps/api/src/index.ts), reuses it from [apps/api/src/__tests__/functional/helpers.ts](../../../apps/api/src/__tests__/functional/helpers.ts), adds a focused unit test, and updates the skill-authoring docs. The main remaining concern is that the sync responsibility now lives in two places instead of one.

## Findings

1. Medium: `skillsRoutes()` still performs database mutation during route registration.
   [apps/api/src/routes/skills.ts](../../../apps/api/src/routes/skills.ts) still calls `await syncSystemSkills(db)` when the route module is mounted. That duplicates the startup call in [apps/api/src/index.ts](../../../apps/api/src/index.ts) and makes route registration a hidden write path. The plan explicitly described a startup-time synchronization point before route registration; keeping the extra route-level sync blurs ownership and makes the behavior harder to reason about.

2. Low: there is no focused proof that the top-level startup path is the one guaranteeing correctness.
   [apps/api/src/sync-system-skills.test.ts](../../../apps/api/src/sync-system-skills.test.ts) verifies helper behavior well, but there is no integration-level test showing startup performs the sync before the first request. Today that gap is masked because `skillsRoutes()` also syncs.

## Suggested Change List

1. Medium: modify [apps/api/src/routes/skills.ts](../../../apps/api/src/routes/skills.ts) to remove the redundant `syncSystemSkills(db)` call and keep synchronization owned by API startup.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: if other test or bootstrap paths instantiate `skillsRoutes()` without going through [apps/api/src/index.ts](../../../apps/api/src/index.ts), those paths will need an explicit startup sync call.
   Test expectation: integration-test an app bootstrap path that performs startup sync before serving requests.

2. Low: add an integration-style startup test around [apps/api/src/index.ts](../../../apps/api/src/index.ts) or the functional app builder to prove system skills exist immediately after bootstrap.
   Change: add.
   Dependencies: step 1 if the route-level fallback is removed.
   Risks/Open questions: if the repo avoids testing the top-level entrypoint directly, use the functional `buildApp()` helper as the nearest equivalent and make the startup sync explicit there.
   Test expectation: integration test only; no visual verification needed.

3. Low: document the intended single owner for skill synchronization in [docs/tech/agents/skill-authoring.md](../../../docs/tech/agents/skill-authoring.md) or a nearby startup note.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: without this, future refactors may reintroduce multiple implicit sync entry points.
   Test expectation: documentation review only.