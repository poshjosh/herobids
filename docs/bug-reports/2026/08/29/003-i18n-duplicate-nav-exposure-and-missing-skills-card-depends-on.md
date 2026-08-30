# Bug 003 — i18n: duplicate `nav.exposure` key and missing `skills.card.dependsOn` in ar/hi locales

**Date:** 2026-08-29
**Severity:** Medium
**Status:** Fixed

## Symptoms

Two unit tests failed during the validation run:

1. `catalog-consistency.test.ts` — "keep Arabic and Hindi keys aligned with English"
   - Expected 1082 keys, found 1081 (missing `skills.card.dependsOn`)
2. `i18n-regressions.test.ts` — "all en keys are present in every other locale"
   - Missing key `skills.card.dependsOn` in `ar`

## Root cause

Two issues in the Arabic (`ar.ts`) and Hindi (`hi.ts`) locale files:

1. **Duplicate `nav.exposure` key.** The key appeared twice — once in the initial Navigation section (line ~11) and again in a later nav block (line ~35). The second occurrence shadows the first in the JS object. Since both values were identical translations, this was functionally harmless but caused the key count to differ from English (1082 unique keys in en vs 1081 effective keys in ar/hi).

2. **Missing `skills.card.dependsOn` key.** The English locale had `'skills.card.dependsOn': 'Depends on:'` but neither Arabic nor Hindi had a corresponding entry.

## Fix

- Removed the duplicate `nav.exposure` entry (second occurrence) from both `ar.ts` and `hi.ts`.
- Added `skills.card.dependsOn` with appropriate translations:
  - Arabic: `'skills.card.dependsOn': 'يعتمد على:'`
  - Hindi: `'skills.card.dependsOn': 'निर्भर करता है:'`

## Files changed

- `apps/web/src/app/i18n/locales/ar.ts`
- `apps/web/src/app/i18n/locales/hi.ts`

## Verification

Both `catalog-consistency.test.ts` and `i18n-regressions.test.ts` pass after the fix. Full `pnpm test` (7333 passed, 330 skipped) and `run-all-tests.sh --e2e` (all 8 tiers passed) confirmed green.
