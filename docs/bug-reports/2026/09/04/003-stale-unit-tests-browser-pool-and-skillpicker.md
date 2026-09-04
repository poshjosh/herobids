# Bug Report: two stale unit tests failing after intentional refactors (browser-pool schema, SkillPicker)

- **Status:** FIXED
- **Severity:** Low (test drift; no product defect)
- **Date:** 2026-09-04
- **Discovered By:** `pnpm test` reported `FAIL  Unit tests` — 6 failing tests across 2 files.
- **Summary:** Two test files had drifted out of sync with intentional production changes and needed updating. Neither indicated a product defect.

---

## Defect 1 — `packages/domain/src/browser-pool-feature.test.ts`

**Failing test:** `BrowserPoolConfigSchema > rejects enabled: true with empty url`

The test asserted that `BrowserPoolConfigSchema.safeParse({ enabled: true })` fails with `browserPool.url is required`. However, commit `9a196751` ("Improve nomad resolution of multiple services") **intentionally removed** the `superRefine` that enforced this, because `browserPool.url` is now resolved dynamically at runtime from Nomad service discovery via the `ServiceRegistry` (see the explanatory comment in `packages/domain/src/config/schema.ts`). The schema now accepts `{ enabled: true }` with an empty URL by design.

**Fix:** Updated the test to assert the new, deliberate behavior — `enabled: true` with empty `url` is accepted (URL resolved dynamically at runtime), and renamed the test accordingly. The removed refinement was **not** re-added, as that would break the Nomad dynamic-resolution feature.

## Defect 2 — `apps/web/src/features/agents/SkillPicker.slug.test.tsx`

**Failing tests (5):** all "SkillPicker slug rendering" cases, erroring with `No QueryClient set, use QueryClientProvider to set one`.

`SkillPicker` was refactored to fetch skills via `@tanstack/react-query` (`useQuery`) and its prop changed from `skills` to `initialSkills`. The test's `renderPicker` helper still passed the removed `skills` prop and rendered without a `QueryClientProvider`. With `initialSkills` undefined, the component's default fetch query became enabled and `useQuery` threw for lack of a provider.

**Fix:** Wrapped `renderPicker` in a `QueryClientProvider` (with `retry: false`, matching the repo's other render tests) and passed the skills via `initialSkills` so the picker renders them directly and its default query stays disabled.

---

## Verification

- `pnpm vitest run packages/domain/src/browser-pool-feature.test.ts apps/web/src/features/agents/SkillPicker.slug.test.tsx` → 82 passed.
- `pnpm test` → 7954 passed, 330 skipped, 0 failed.
- `pnpm lint` → passes.

---

## Lessons / Follow-up

- When intentionally relaxing a schema constraint, grep for tests asserting the old constraint in the same change.
- When a shared component gains a `useQuery`/context dependency or renames props, update its render-test helpers in the same change; the repo convention is a `QueryClientProvider` with `retry: false`.
