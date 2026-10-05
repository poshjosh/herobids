# Bug Report 003 — `pnpm lint` type-checks nothing; the repo's "type gate" is a no-op that lets real type errors ship

- **Status:** OPEN (analysed, not yet fixed)
- **Severity:** Medium. No runtime impact, but a corrosive process defect: the command every contributor and `AGENTS.md` treats as the type gate (`pnpm lint`) exits `0` while real, pre-existing type errors sit uncaught in the tree. It gives false green on PRs, hides regressions, and silently excludes an entire app (`apps/web`) from any type checking. The danger is confidence, not a crash.
- **Date:** 2026-10-05
- **Environment:** All — this is a build/tooling configuration defect, runtime-agnostic. Reproduces on any checkout with the current root `tsconfig.json` + root `lint` script.
- **Reviewer:** The fix will be reviewed against the acceptance criteria in this document. Please satisfy every item in [Acceptance criteria](#acceptance-criteria) and every scenario in [Required tests / verification](#required-tests--verification).

---

## 1. Summary

The root `lint` script is:

```jsonc
// package.json
"lint": "tsc --noEmit"
```

and the root `tsconfig.json` is a **solution-style** config — `files: []` plus a `references` list — not a config that compiles anything itself:

```jsonc
// tsconfig.json
{
  "files": [],
  "references": [
    { "path": "packages/domain" },
    { "path": "packages/db" },
    { "path": "packages/documents" },
    { "path": "packages/llm" },
    { "path": "apps/api" },
    { "path": "apps/worker" },
    { "path": "tests/rate-limit-lab" }
  ]
}
```

Plain `tsc --noEmit` (no `-b` / `--build`) run against a config with `files: []` and no `include` **has nothing to compile**. Project `references` are only followed in build mode (`tsc -b`). So `pnpm lint` type-checks **zero files** and always exits `0`.

Two consequences:

1. **The gate is a no-op.** `pnpm lint` passes regardless of the type health of any package. Real errors in `apps/web` are proven below while `pnpm lint` still exits `0`.
2. **`apps/web` is not even referenced.** Even if lint ran in build mode, `apps/web` is absent from the `references` list, so it would still be excluded. The web app has its own `typecheck` script (`tsc --noEmit`) that is **not** invoked by the root gate or (per CI below) by CI.

`AGENTS.md` instructs: *"Run `pnpm lint` before considering work complete — it must pass."* That instruction currently guarantees nothing.

This is a bug, not a style preference. The command named as the type gate does not type-check.

---

## 2. Evidence

### 2.1 `pnpm lint` exits 0 against the current tree

```
$ pnpm lint
> herobids@0.5.0 lint
> tsc --noEmit
ROOT LINT EXIT: 0
```

No files emitted, no diagnostics, instant success.

### 2.2 Meanwhile `apps/web` has real, pre-existing type errors

`apps/web` has its own `typecheck` script (`apps/web/package.json`: `"typecheck": "tsc --noEmit"`). Running it surfaces errors the root gate never sees:

```
$ pnpm --filter @herobids/web run typecheck
src/features/agents/AgentDetailPage.test.tsx(112,3): error TS2741: Property 'isBackendApproved' is missing in type '{...}' but required in type 'Skill'.
src/features/agents/list-selectable-skills.test.ts(7,3): error TS2322: Type '{...}' is not assignable to type 'Skill'.
  Types of property 'isBackendApproved' are incompatible.
    Type 'boolean | undefined' is not assignable to type 'boolean'.
src/features/agents/SkillPicker.slug.test.tsx(17,3): error TS2322: ... Skill.isBackendApproved incompatible ...
src/features/skills/SkillCard.render.test.tsx(26,3): error TS2322: ... Skill.isBackendApproved incompatible ...
src/features/skills/SkillsPage.slug.test.tsx(32,3): error TS2322: ... Skill.isBackendApproved incompatible ...
Exit status 2
```

(Those specific errors are test-fixture drift against the `Skill` type — tracked/fixed separately. They are cited here only as **proof the gate is blind**, not as the subject of this report.)

### 2.3 The references list omits `apps/web`

`tsconfig.json` references `packages/{domain,db,documents,llm}`, `apps/{api,worker}`, and `tests/rate-limit-lab`. There is no `{ "path": "apps/web" }`. So web is excluded by both defects at once: lint doesn't build references, and web isn't a reference anyway.

### 2.4 CI does not compensate

The slow-tests workflow (`.github/workflows/slow-tests.yml`) and the agent image build (`.github/workflows/build-push-agent.yml`) do not run a whole-repo typecheck that would catch the web errors. `pnpm build` (`pnpm -r run build`) does compile each package via its own build, but it is not what `AGENTS.md` names as the gate, and the web errors above live in **test files** that a production `vite build` of `apps/web` does not type-check either. The only thing that catches them is `tsc --noEmit` per package including its tests — which nothing in the gate currently runs for web.

---

## 3. Root cause

`tsc --noEmit` is being used as if it were `tsc -b --noEmit`. With a solution-style root tsconfig (`files: []` + `references`), only **build mode** (`tsc -b`) walks the referenced projects; plain `tsc` compiles the (empty) root program and stops. The root `lint` script therefore checks nothing. Separately, the `references` list is incomplete: `apps/web` is not listed, so even correcting the invocation to build mode would still skip web.

---

## 4. Required behaviour after the fix

These are the **what**; the implementation is the fixer's call, but each is checked in review.

### R1. `pnpm lint` must actually type-check every first-party package, including its test files
- After the fix, introducing a type error anywhere in a first-party package (`packages/*`, `apps/*`, `tests/*` that ship types) — **including `.test.ts(x)` files** — must make `pnpm lint` exit non-zero.
- The two obvious implementation shapes (pick one, justify it):
  - switch the root script to build mode: `tsc -b --noEmit` (or `tsc -b`) over a complete, correct references graph; **or**
  - make `lint` a recursive fan-out: `pnpm -r run typecheck`, with every package exposing a `typecheck` script. (`apps/web` already has one.)
- Whichever is chosen, test files must be in scope. If a package's build tsconfig excludes tests, add a dedicated typecheck tsconfig (or a `typecheck` script) that includes them, so the gate matches what contributors expect.

### R2. `apps/web` must be covered by the gate
- `apps/web` must be type-checked by `pnpm lint` (either added to the references graph for build mode, or picked up by the recursive `typecheck` fan-out). The current silent exclusion must end.

### R3. The references graph must be complete and consistent (if build mode is chosen)
- If R1 is solved with `tsc -b`, every first-party TypeScript project that should be gated must appear in the root `references` (notably `apps/web`), and each referenced project's tsconfig must itself be build-mode-correct (`composite: true`, emit settings consistent). No referenced path may be missing or dangling.

### R4. The fix must not weaken strictness or silence errors to make the gate pass
- Do **not** make the gate pass by adding `skipLibCheck` escapes beyond current settings, excluding test files, loosening `strict`, or sprinkling `@ts-ignore`. The point is to *reveal* the currently-hidden errors, not to re-hide them. Pre-existing real errors uncovered by turning the gate on (e.g. the §2.2 `Skill.isBackendApproved` fixtures) must be fixed (or explicitly tracked in their own report and the gate still turned on), not suppressed.

### R5. CI runs the real gate
- The CI workflow(s) must invoke the now-effective `pnpm lint` (or the recursive typecheck) so a type regression fails the build. Document in the Fix section which workflow runs it.

### R6. `AGENTS.md` stays accurate
- `AGENTS.md` says `pnpm lint` is the type gate and "must pass". After the fix that sentence is finally true. If the gate command or its meaning changes (e.g. a new `pnpm typecheck`), update `AGENTS.md` in the same change so the documented gate matches reality.

---

## 5. Must not regress

1. **`pnpm build` still builds every package.** `pnpm -r run build` must remain green and unchanged in behaviour.
2. **`pnpm test` is unaffected.** Vitest discovery/config (`vitest.config.ts`) is independent of the typecheck wiring; do not entangle them.
3. **No slowdown that makes the gate skipped in practice.** If build mode is adopted, enable incremental/`tsBuildInfoFile` so repeat runs stay fast; a 10-minute lint invites `--no-verify`.
4. **Per-package `typecheck`/`build` scripts keep working standalone.** `pnpm --filter @herobids/web run typecheck` etc. must still run on their own.
5. **Strict settings unchanged.** `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` remain on everywhere they are on today.

---

## 6. Acceptance criteria

- [ ] R1–R6 implemented.
- [ ] Every item in §5 holds.
- [ ] Demonstrated: a deliberately-introduced type error in a non-test file of `packages/domain` **and** one in a `.test.tsx` file of `apps/web` each make `pnpm lint` exit non-zero (show both in Verification, then revert).
- [ ] `pnpm lint` exits `0` on a clean tree only after any real errors it now surfaces are fixed or separately tracked.
- [ ] CI invokes the effective gate (name the workflow + job).
- [ ] `AGENTS.md` updated if the gate command/meaning changed.
- [ ] This report updated: Status → FIXED, with a **Fix** section (files changed, chosen approach + why), a **Verification** section (commands + outputs), and any deviations with reasons.

---

## 7. Required tests / verification

This is a tooling defect, so "tests" are reproducible verification steps, not unit tests. Record each in the Fix/Verification section:

1. **Gate catches a core error.** Add `const x: number = 'nope';` to a non-test `.ts` in `packages/domain`, run `pnpm lint` → non-zero. Revert.
2. **Gate catches a web test error.** With the §2.2 fixtures still broken (or a fresh deliberate error in an `apps/web` `.test.tsx`), run `pnpm lint` → non-zero. (This is the regression that today's gate misses.)
3. **Gate is green when clean.** With all real errors fixed, `pnpm lint` → `0`.
4. **Build still green.** `pnpm build` → `0`.
5. **Tests still green.** `pnpm test` → unchanged.
6. **CI parity.** The CI job that runs the gate fails on step 1/2's deliberate error (can be shown locally by running the exact CI command).

---

## 8. Out of scope (note in the Fix section if relevant)

- Fixing the specific `Skill.isBackendApproved` test-fixture errors from §2.2 — tracked/fixed separately. This report only requires the gate to *surface* them (and that they not be suppressed to keep the gate green).
- Adopting ESLint or any lint-rule tooling. "Lint" here means the type gate as `AGENTS.md` uses the term; adding real linting is a separate initiative.
- Reworking the monorepo's project-reference topology beyond what R1–R3 need.

---

## 9. Related code

- `package.json` — root `"lint": "tsc --noEmit"` (the no-op gate), `"build": "... pnpm -r run build"`.
- `tsconfig.json` — `files: []` + `references` (solution-style; `apps/web` absent).
- `apps/web/package.json` — `"typecheck": "tsc --noEmit"` (exists but ungated).
- `.github/workflows/slow-tests.yml`, `.github/workflows/build-push-agent.yml` — CI; neither runs a whole-repo typecheck today.
- `AGENTS.md` — "Run `pnpm lint` before considering work complete — it must pass."
- `docs/best-practices/configuration.md` — referenced for any config/script conventions touched.
