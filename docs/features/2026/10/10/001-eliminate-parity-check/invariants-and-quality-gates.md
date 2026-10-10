# Invariants and quality gates

Applies to **every** milestone in [000-roadmap.md](000-roadmap.md), whichever one you
pick. Every invariant below is already stated or demonstrated somewhere in this epic's
history or in the repo's standing rules; the source is cited next to each. Nothing here
overrides [AGENTS.md](../../../../../../AGENTS.md); where this file is stricter, it only adds
epic-specific checks on top of AGENTS.md's baseline.

## 1. Hard invariants

| # | Invariant | Source |
|---|---|---|
| **I1** | **Never remove a manifest entry without also removing its id from `REQUIRED_ENTRY_IDS` and `REQUIRED_ENTRY_AUTHORITIES` in `scripts/check-parity-drift.mjs`.** `validateManifest()` throws `manifest missing required entry <id>` otherwise, and the manifest is rejected whole. Found the hard way during the first (since reverted) A1 attempt. | `scripts/check-parity-drift.mjs` (`validateManifest`); prior roadmap note on A1 |
| **I2** | **`scripts/check-parity-drift.test.mjs` hard-codes entry ids** (`agent-risk-defaults`, `domain-agent-risk-contract`, and one `mirror-only` id in the "rejects altered required authority classifications" test; the fixture is built from `REQUIRED_ENTRY_IDS`). When you remove an entry that the test names, retarget the test to an id that survives to the end of the epic or to the milestone you are on. Today it names `strategy-preset-economy` as the `mirror-only` id (survives until D2). Only two entries have authority `traderton` (`agent-risk-defaults` until B4, `domain-agent-risk-contract` until C3); retarget the test before those are removed. | `scripts/check-parity-drift.test.mjs` |
| **I3** | **The manifest and checker live in herobids only, and CI checks in two directions against pinned refs** (see section 2). A traderton-side deletion or edit of a manifest-listed file is red in traderton CI until traderton's pin points at a herobids tag whose manifest no longer lists it. Always do the herobids part first. | `.github/workflows/slow-tests.yml` in both repos; `traderton/scripts/check-parity-drift.mjs`; verified by simulation 2026-10-10 |
| **I4** | **Pins are immutable refs, never a moving branch**, bumped only with `scripts/shell/ops/release.sh --bump-parity-pin <tag-or-sha>`. | AGENTS.md (parity-drift rule); workflow `# parity-pin` comments |
| **I5** | **Do not edit one side of a still-mirrored file or region.** If a file must stay mirrored but one side legitimately changes, narrow or reclassify the manifest entry to the genuinely shared region (and bump the sibling pin) instead of reverting the feature or re-pinning blindly. | AGENTS.md (parity-drift rule) |
| **I6** | **"Dead" is proven by a trial deletion, not by grep.** Step 1: grep both repos for real usages (not just the file's own declarations; exclude tests, `dist/`, `_deferred*/`) and classify (a) real logic, (b) compile-time shape only, (c) dead. Step 2, **mandatory before you delete anything**: apply the deletion (barrels pruned) and run the **owning repo's own** build, per-package type checks and **full test suite**; only an all-green run closes the claim. Do not infer ownership from `AGENTS.md` prose. The findings doc and the roadmap's verification table are evidence, not a substitute; trees move, so re-check at execution time. Why this is strict: the "traderton preset YAMLs are dead" claim passed step 1, was deleted, and then failed 14 traderton tests (`presets-loader` is called from `tools/trading-profiles.ts`), so the deletion was reverted. | Brief B correction and O7; `investigation-prompt.md`; AGENTS.md "Investigate before fixing" |
| **I7** | **After deleting a file, prune every barrel that exports it** (`packages/domain/src/ports/index.ts`, `packages/domain/src/index.ts`, `values/index.ts`) and any dead re-export. | Brief B, "Dependencies / sequencing" |
| **I8** | **Root `pnpm lint` does not type-check the worker (or all apps).** Run the per-package type checks listed in the quality-gate floor (section 3). | Brief B (same section); extraction handoff brief §5 |
| **I9** | **`.env*` twins:** any env-var change updates the matching `.env*.example` in the same change. | AGENTS.md ("Rules") |
| **I10** | **Do not drop a manifest entry whose milestone is blocked on H5** (`domain-config-*`, `domain-market-assessment`, `domain-scanner-types`, the `PriceCandle` residue in `domain-ports-candle-fetcher`) before the preset-assessment plan's step H5 has executed. | Brief B, "Resolved entries" row 2 and "Blocked on other in-flight work" |
| **I11** | **Disposition (6) "retire the obligation" is not available for new candidates** without re-checking the ratified bar (no wire exposure, each repo free to evolve independently). That is a heavyweight decision if the bar is not clearly met. | Brief B, Ratified decision 1 |
| **I12** | **You do everything you can yourself, including commits, tags, pushes, release scripts and package publishing, when a milestone calls for it, and you reach out to the human only when you cannot.** "Cannot" means: a credential or permission is missing or rejected, a branch or registry rule blocks you, a script fails and you cannot diagnose it, or the action would exceed the milestone's stated scope. Before running a release, tag or publish, write the exact commands into the ledger; after it, record the result (tag, version, SHA). Read the script's own header first and follow its documented flow (`release.sh`, `release-xstack.sh`). Local credentials (the `.env*` files, git remote auth) are expected to be sufficient; do not ask for credentials you have not tried. Never commit secrets (AGENTS.md). Still **stop after each milestone** (roadmap step 8). | operator instruction 2026-10-10; AGENTS.md (secrets); `release.sh` / `release-xstack.sh` |
| **I13** | **Unit-tier tests run from a clean env**, otherwise they hit the DB and deadlock: `env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run <paths>`. | extraction handoff brief §5 |
| **I14** | **Public APIs return `Result`, strict TypeScript, no `any` / `@ts-ignore`, no swallowed errors.** Applies to any code you write in a milestone. | AGENTS.md |
| **I15** | **One manifest-touching milestone in progress at a time**, per repo. Two milestones editing `scripts/parity-drift-manifest.json` or the `REQUIRED_*` lists at once guarantees conflicts. This is a rule introduced by this framework (flagged in the roadmap); it is not from an older source. | framework rule |

## 2. The two CI directions and the cross-repo ordering protocol

Facts (read from the repo, not assumed):

- `scripts/parity-drift-manifest.json` and `scripts/check-parity-drift.mjs` exist only in
  herobids. Traderton's `scripts/check-parity-drift.mjs` is a 24-line wrapper that runs
  **herobids's** checker, from the pinned herobids checkout, against traderton's tree.
  Traderton's `test:slow` also runs herobids's `check-parity-drift.test.mjs`.
- Both repos have a `parity-drift` job in `.github/workflows/slow-tests.yml`:

| CI job | Herobids side | Traderton side | Manifest + checker used |
|---|---|---|---|
| herobids CI | herobids `HEAD` | traderton at its pin (`v0.1.2` on 2026-10-10) | herobids `HEAD` |
| traderton CI | herobids at its pin (`v0.6.5` on 2026-10-10) | traderton `HEAD` | herobids at the pin |

Consequences for ordering (this is what makes a "delete the copy in both repos" milestone
two milestones):

1. **Herobids-only change** (delete a herobids file, drop its entry in the same change):
   herobids CI compares against the old traderton pin, entry is gone, green. Traderton CI
   is unaffected (it still uses the older herobids pin). **No ordering constraint.**
2. **Traderton-side change** (delete or edit a manifest-listed traderton file): traderton CI
   still reads the old herobids manifest, which lists the file, and fails
   (`declared path is missing` or `normalized content differs`). It is green only after
   traderton's pin points at a herobids ref whose manifest no longer lists it.
   **Order: herobids part merged and tagged (release row `G*`) first; traderton part
   then includes `release.sh --bump-parity-pin <that herobids tag>` in the same change.**
3. Batch traderton-side deletions behind one herobids tag, rather than one tag per entry.

Observed 2026-10-10: traderton's current pin (`v0.6.5`) already fails against traderton's
tree (`tick-gates-session-hours`, `domain-trading-trading-protocol`) because that tag
predates the region-narrowing commit `c27ad25f`; `v0.6.6` passes. Any traderton-side
milestone bumps the pin forward anyway; do not "fix" the pre-existing failure separately.

### Pin-accurate local verification recipes

Run both; the sibling-tree recipe alone can pass while CI fails, and vice versa.

```bash
# Herobids-side change: herobids working tree vs traderton at ITS PIN (what herobids CI does)
TT_PIN=$(grep -E '^[[:space:]]*ref: .*# parity-pin' .github/workflows/slow-tests.yml \
  | sed -E 's/^[[:space:]]*ref: ([^ #]+).*/\1/')
TMP=$(mktemp -d) && git -C ../traderton archive "$TT_PIN" packages/domain/src packages/worker/src config | tar -x -C "$TMP"
HEROBIDS_ROOT=$PWD TRADERTON_ROOT=$TMP PARITY_DRIFT_CI=1 node scripts/check-parity-drift.mjs

# Traderton-side change: traderton working tree vs herobids at the pin you set (what traderton CI does)
HB_PIN=<the herobids tag you bumped to>
TMP=$(mktemp -d) && git -C ../herobids archive "$HB_PIN" scripts apps/worker/src packages/domain/src config | tar -x -C "$TMP"
(cd "$TMP" && HEROBIDS_ROOT=$TMP TRADERTON_ROOT=<abs path to traderton> PARITY_DRIFT_CI=1 node scripts/check-parity-drift.mjs)
```

Both recipes were run against the real tags on 2026-10-10 (herobids tree vs traderton
`v0.1.2` passed; traderton tree vs herobids `v0.6.5` failed, vs `v0.6.6` passed). If a
manifest entry points at a path outside the archived directories, add that directory to
the `git archive` list. Remove the temp dirs afterwards and make sure your shell is not
sitting inside one of them.

Also run the herobids local default, which compares against the **sibling working tree**:
`pnpm test:slow` (herobids) or `node scripts/check-parity-drift.mjs`.

## 3. Quality gates

### 3.1 The floor (every milestone, per AGENTS.md)

1. **Focused tests** for the changed behavior (new or updated; run from a clean env, I13).
2. **`pnpm lint`** in every repo you changed. It must pass.
3. **The relevant build/test suite** (`pnpm build` where exports/packages changed;
   `pnpm test` for the affected packages). Traderton: its own `pnpm build`, `pnpm test`.
4. **Per-package type checks for everything you touched** (I8). Herobids:
   `pnpm exec tsc --noEmit -p apps/worker/tsconfig.json`,
   `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`,
   `pnpm exec tsc --noEmit -p packages/domain/tsconfig.json`,
   `pnpm --filter @herobids/web run typecheck`. Traderton: `npx tsc --noEmit -p packages/<pkg>`.
5. **`git diff --check`** clean.
6. **`CHANGELOG.md`** `## [Unreleased]` updated in each repo you changed, in the epic's
   established format (3.4).
7. **Ledger entry** in [EXECUTION_LEDGER.md](EXECUTION_LEDGER.md): starting SHAs of both
   repos, commits, focused validation, broader validation, residual risks, next allowed
   item.

### 3.2 Gate profiles added by this epic's nature

| Profile | Applies to | Extra checks |
|---|---|---|
| **GP-H** (herobids change) | any milestone changing herobids | I1, I2, I7 hold; manifest entry count equals the number stated in the row's done-state (`node -e "console.log(JSON.parse(require('fs').readFileSync('scripts/parity-drift-manifest.json','utf8')).entries.length)"`); `node --test scripts/check-parity-drift.test.mjs` passes; **both** herobids recipes in section 2 pass; the grep from I6 returns zero remaining references to anything you deleted, **and the I6 trial-deletion run (domain build, lint, per-app `tsc`, web typecheck, full `pnpm vitest run`) is all green, with `pnpm --filter @herobids/domain run build` run before the per-app `tsc` calls**. |
| **GP-T** (traderton change) | any milestone changing traderton | if the milestone changes or deletes a **manifest-listed** traderton file (additive new files, such as the new contracts package, do not): the pin was bumped (`release.sh --bump-parity-pin <hb tag>`) to a herobids tag that contains the milestone's H-part, the traderton recipe in section 2 passes against that tag, and the new pin is recorded in the ledger. Always: traderton `pnpm lint`, `pnpm build` (`pnpm -r run build`), `pnpm test` (full suite, the I6 closer), plus `npx tsc --noEmit -p packages/<pkg>` for each touched package. |
| **GP-X** (test-first) | **B3.1/B3.2** and any milestone touching [agent-risk-contract-retirement.md](decisions/agent-risk-contract-retirement.md)'s scope | follow that document's gate exactly: check open items 1-3, write tests 1-5, **run them once before any production change and record the before-state** (pass/fail per test) in the ledger, only then implement. Tests expected to fail today must be recorded as failing, not skipped. Test 4 (no-enforcement guard) must pass before the change; if it does not, stop (it is a more serious finding, heavyweight path). |
| **GP-C** (contracts package) | C1.x, C2.x, C3.x, C4, C5 | package builds in isolation (`pnpm --filter ... build`), exports are type-checked from a clean consumer, no runtime dependency beyond what the plan names (Zod), exact-version pin (no `^`/`~`) in the consumer, and the consuming repo's full test suite passes. |
| **GP-D** (docs only) | Z1 and doc-only rows | every link in the changed docs resolves; no contradiction with AGENTS.md, Brief B, or any ADR; ADR numbering continues from the highest existing number. CHANGELOG is not required for a docs-only change. |
| **GP-F** (final removal) | C6 | before removing the dual checkout, re-grep both repos' `.github/workflows/` for any other use of `TRADERTON_ROOT`, `HEROBIDS_ROOT`, `repository: poshjosh/…` checkouts, and `check-parity-drift`. `wire-dto-package-mechanics.md` found `parity-drift` to be the only user on 2026-10-10; confirm it still is. Also remove the `--bump-parity-pin` and parity steps from `release.sh` / `release-xstack.sh`, and remove the parity-drift rule from herobids's `AGENTS.md` (traderton's `AGENTS.md` has no such rule as of 2026-10-10; confirm) using wording the human approves. |

### 3.3 When a milestone is NOT done

An agent **may not** mark a milestone done if, mid-implementation, it discovers a gap or
dependency the roadmap did not account for. Instead it must, before declaring done:

1. **Write the finding down** in the roadmap (a short "Findings" note under the milestone
   row or the relevant decision document), the same way this epic already recorded the H5
   plan gaps and the `check-parity-drift.mjs` allowlist gap found during the first A1.
2. **Resolve it within the same milestone** only if it is small: same files, same
   ratified direction, no new decision (apply the lightweight path in
   [decision-framework.md](decision-framework.md)).
3. **Otherwise split it out as a new tracked row** (ID, done-state, prerequisites, gates),
   add it to the ledger as `planned`/`blocked`, and either finish the part that is
   genuinely complete as a smaller milestone or leave the original `blocked`.
4. If the gap contradicts a ratified decision, use the heavyweight path (stop, brief,
   flag to the human).

Mark `verified` only when every gate in the row's profile has passed and the evidence is
in the ledger.

### 3.4 CHANGELOG format (from this epic's own entries)

Under `## [Unreleased]`, in the repo you changed, use the existing Keep-a-Changelog
heading (`### Removed`, `### Changed`, `### Added`) and this shape:

```markdown
### Removed

- **<Bold, specific title>.** <What was deleted/changed and why it was dead or
  redundant, with the evidence (e.g. "zero references, confirmed by grep across the
  whole repo")>. <Effect on the manifest/checker, e.g. "Removed the matching entries
  (and their required-authority pins) from `scripts/parity-drift-manifest.json` /
  `scripts/check-parity-drift.mjs`">. <Pointer, e.g. "Part of the parity-drift-check
  elimination effort; see `docs/features/2026/10/10/001-eliminate-parity-check/decisions/B-parity-ownership.md`">.
```

The traderton changelog uses the same shape (and cites the herobids path).

## 4. Known documentation drift

None open. AGENTS.md step (3) of the parity-drift rule used to say to record pin pairs in
the trading-extraction ledger (the recording was removed from `release.sh` in commit
`1d637397`); on 2026-10-10 it was changed to point at this epic's
[EXECUTION_LEDGER.md](EXECUTION_LEDGER.md) "Pin pairs" table.
