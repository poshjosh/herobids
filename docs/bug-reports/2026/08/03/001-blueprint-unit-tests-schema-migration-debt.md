# Blueprint Unit Tests — Schema Migration Debt

**Date**: 2026-08-03
**Severity**: MEDIUM (unit tests only, no runtime impact)
**Found during**: test-and-fix validation run

## Summary

`apps/api/src/routes/blueprints.test.ts` has 17 failing tests because the test mock data and assertions were not updated when the blueprint table schema was migrated as part of the agent-bot config harmonization (commit `44e4788d`).

## Root Cause

The blueprint schema changed from old columns (`userId`, `visibility`, `configData`, `configVersion`, `strategyPreset`) to new columns (`authorId`, `publicationStatus`, `kind`, `currentRevisionId`, `publishedRevisionId`, `payload` via revisions, etc.). The CreateBlueprintSchema now uses `.strict()` validation and expects `payload: BlueprintRevisionPayloadSchema` instead of flat `name`/`configData` fields.

The tests still reference old column names and payload formats.

## Affected Tests

17 tests in `apps/api/src/routes/blueprints.test.ts`:
- GET /blueprints, POST /blueprints
- GET /blueprints/:id, PUT /blueprints/:id
- DELETE /blueprints/:id
- POST /blueprints/:id/clone
- POST /blueprints/:id/publish, /unpublish
- POST /bots with blueprintId

## Partial Fix Applied

- Added `transaction`, `$dynamic`, `innerJoin`, `leftJoin` methods to mock `makeChain`
- Updated `stubBlueprint` to use new schema fields (authorId, publicationStatus, kind, etc.)
- Updated `from-preset` tests to expect 501 (stubbed endpoint)

## What Remains

- All test payloads need `payload: { kind, name, ... }` format
- Response assertions need new field names (`publicationStatus` instead of `visibility`, etc.)
- Mock needs to return revision data for `resolveTargetRevision` calls
- PUT/DELETE/clone/publish tests need to understand revision-based workflow
