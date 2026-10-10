# C2 — Publishing `@traderton/contracts`

Publish workflow, version mapping, publishConfig, token permissions, dry-run
procedure, rollback policy, and how `release.sh` integrates. Written 2026-10-10
(C2.0). Supersedes the provisional "C2.0 plan publishing + C2.1 implement" split:
the mechanism is small enough that the plan + `--dry-run` verification are one
change; the actual publish is the G2 release row.

## 1. Registry and scope

- **Registry:** GitHub Packages, org `poshjosh` (`https://npm.pkg.github.com`).
- **Package:** `@traderton/contracts` (scoped to `@traderton`), `"access": "restricted"`.
- **Auth:** the same `GITHUB_TOKEN` / `packages: write` / `packages: read` boundary the
  org already uses for `slow-tests.yml` dual-checkout and `build-push.yml` (`packages: write`
  is already granted there). No new credential.

## 2. Version mapping

- The package version is independent of the root `traderton` version (0.1.3).
  First publish is `@traderton/contracts@0.1.0` (already set in
  `packages/contracts/package.json`).
- A **new package version is cut whenever a contract shape changes**; the version is
  bumped in `packages/contracts/package.json` in the same change as the shape edit, using
  semver: patch for additive/back-compat field additions, minor for a shape group that
  changes an existing schema's surface, major for a breaking wire change. For this epic the
  six additive C1.x groups ride together on `0.1.0`.

## 3. `publishConfig`

Already in `packages/contracts/package.json`:

```json
"publishConfig": {
  "registry": "https://npm.pkg.github.com",
  "access": "restricted"
}
```

## 4. Publish workflow (`publish-package.yml`)

A new workflow `.github/workflows/publish-package.yml` (GitHub only recognizes workflows
at the repository root):

- **Trigger:** `on: workflow_dispatch` plus `push` to `main` on paths
  `packages/contracts/**` (additive; tag-triggering is not used because the package
  version is not tied to the root tag).
- **Steps:** checkout → `corepack enable` → `pnpm install --frozen-lockfile` →
  `pnpm --filter @traderton/contracts run build` → `pnpm --filter @traderton/contracts run test` →
  `pnpm publish --filter @traderton/contracts --no-git-checks`.
- **Auth:** `registry-url: https://npm.pkg.github.com`, `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
- **Permissions:** `contents: read`, `packages: write` (identical to `build-push.yml`).
- **Idempotency guard:** `pnpm publish` fails on an existing version (npm rejects a
  duplicate version) — that is the intended re-publish guard.

## 5. Dry-run procedure (C2.1)

```bash
cd packages/contracts
pnpm pack --pack-destination /tmp   # ensure the tarball is well-formed
# simulate the publish resolution without hitting the registry:
pnpm publish --dry-run --no-git-checks 2>&1 | tail -20
```

`--dry-run` prints the resolved package/tarball/version/tag without uploading. `pnpm pack`
is the stronger local check that `exports`, `types`, and `files` resolve (no `files` array
is set, so the whole `dist/` + `src/` tree ships — acceptable for a types package; the
`exports` map gates consumers).

## 6. Rollback policy

- **Pre-publish:** the package is "unpublished" by deleting the version from GitHub
  Packages (the UI / API supports deleting a single version; `restricted` scope means no
  other consumer can have depended on it yet).
- **Post-consumption:** once herobids pins a version, do **not** delete it — bump forward
  (an exact-pinned dependency referencing a deleted version breaks herobids' install).
  This is the same "immutable once referenced" rule as the `ref:` parity pin.

## 7. `release.sh` integration

`release.sh` stays a **root-version** releaser (it bumps `traderton` + CHANGELOG and tags
the repo). The contracts package is published by the workflow in §4 (path-triggered on
`packages/contracts/**`), not by `release.sh`. If a future change wants a single atomic
"bump root + package together", that is C5's `release-xstack.sh` work on the **herobids**
side (publish the package, then bump herobids' pin), which C5 covers separately.

## 8. Revised row list (writes back into 000-roadmap.md)

- C2.0 + C2.1: plan (this doc) + `publish-package.yml` + `pnpm pack`/`--dry-run` green.
- G2: first real publish of `@traderton/contracts@0.1.0` (agent-run, I12).
- C3.0: herobids install-auth plan (`.npmrc`/CI/Docker) — **stop only if O6 needs a new secret**.