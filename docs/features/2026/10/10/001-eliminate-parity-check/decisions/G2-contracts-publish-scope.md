# G2 — `@traderton/contracts` publish scope mismatch (heavyweight)

- **Status:** RESOLVED (Option A)
- **Date:** 2026-10-10
- **Decision (2026-10-10):** Option A — rename the package to `@poshjosh/contracts`.
  The `@traderton` scope was only a naming choice, not a functional requirement; the
  actual repo owner is the `poshjosh` user, so `@poshjosh/contracts` is the correct scope.
  All code + epic docs updated; the ratified `B-parity-ownership.md` R9 wording is left
  intact with a clarification pointer (O9).
- **Blocks:** G2 (first publish), C3.1 (wire the dependency), C3.2–C3.6 (consume the
  package), G3, C4, C5.

## Question

The ratified package name is `@traderton/contracts`, published to GitHub Packages "under
the existing `poshjosh` org" (Brief B decision 5;
`decisions/wire-dto-package-mechanics.md` §1). The first publish (G2) failed with a
definitive, non-transient error:

```
npm error code E403
npm error 403 Forbidden - PUT https://npm.pkg.github.com/@traderton%2fcontracts
  - Permission permission_denied: The requested installation does not exist.
```

What is the correct package scope/owner, and how do we publish it?

## Evidence (verified 2026-10-10, via the GitHub API with the local git credential)

1. **`poshjosh` is a user, not an org.** `GET /users/poshjosh` → `type: User`.
2. **The `traderton` org exists** (`GET /users/traderton` → `type: Organization`), and
   `poshjosh` is an **admin** member (`GET /user/memberships/orgs/traderton` →
   `state: active, role: admin`). But the org owns only **`traderton/skills`**
   (`GET /orgs/traderton/repos` → `['traderton/skills']`).
3. **The repo is `poshjosh/traderton`** (user-owned), not `traderton/traderton`
   (`GET /repos/poshjosh/traderton` → `owner: poshjosh`; `GET /repos/traderton/traderton`
   → `404 Not Found`).
4. **GitHub Packages requires the npm scope to match the repo owner.** A package published
   from a user-owned repo must be scoped to that user (`@poshjosh/*`); the `@traderton`
   scope requires the repo to live under the `traderton` org. The `403 … requested
   installation does not exist` is GitHub's rejection of `@traderton/contracts` from the
   `poshjosh/traderton` repo.
5. The mechanics doc's premise — "GitHub Packages reuses that exact same auth boundary …
   under the existing `poshjosh` org" — is therefore **wrong on two counts**: `poshjosh` is
   a user, and the `@traderton` scope does not map to the repo's owner.

## Options

### Option A — Rename the package to `@poshjosh/contracts`
- **What:** change `packages/contracts/package.json` `name` to `@poshjosh/contracts`; the
  `.npmrc` scope in herobids (C3.0) points `@poshjosh` at `npm.pkg.github.com`.
- **Cost:** contradicts the ratified name `@traderton/contracts` (H3/H8 — changes a
  ratified position). Every doc/plan/roadmap reference to `@traderton/contracts` changes.
- **Reversibility:** easy (rename back), but it is a ratified-name change, so it needs
  ratification, not a silent rename.

### Option B — Move the repo under the `traderton` org
- **What:** transfer `poshjosh/traderton` → `traderton/traderton` (or create
  `traderton/traderton` and re-point the remote). Then `@traderton/contracts` publishes
  from the org-owned repo.
- **Cost:** an infrastructure mutation (repo transfer) that affects the deploy/CI
  `repository: poshjosh/traderton` references in both repos' `slow-tests.yml` and
  `build-push.yml`; needs the human's explicit approval (AGENTS.md: never mutate shared
  infrastructure state without approval).
- **Reversibility:** a repo transfer is reversible but disruptive (redirects, CI re-point).

### Option C — Publish under the `traderton` org from a new org repo
- **What:** create `traderton/traderton` (or a `traderton/contracts` repo) and publish the
  package from there, keeping `poshjosh/traderton` as the source repo.
- **Cost:** a second repo to keep in sync; the package source would live apart from the
  repo that owns the shapes. More moving parts than A or B.
- **Reversibility:** easy (delete the extra repo), but adds ongoing sync burden.

### Option D — Keep `@traderton/contracts` but publish from the `traderton` org via a PAT
- **What:** a `traderton`-org PAT with `write:packages` used in the publish workflow.
- **Cost:** does **not** fix the scope mismatch — GitHub still requires the package scope
  to match the repo owner, so this fails the same way. **Not viable.**

## Recommendation

**Option A (rename to `@poshjosh/contracts`)** is the least-disruptive correct fix: it
matches the actual repo owner (`poshjosh`), needs no infra mutation, and the `@traderton`
scope was only ever a naming choice, not a functional requirement. The alternative that
preserves the ratified name is **Option B** (move the repo under the `traderton` org),
which is the only way to keep `@traderton/contracts` but is an infra mutation needing
explicit approval.

This is a heavyweight decision (H3 — changes a ratified name/scope; H6 — depends on an
external registry-ownership fact I cannot change myself). I have **not** renamed the
package or mutated any infrastructure; the C1.x/C2.x additive work (package + publish
workflow) is committed and pushed, and the publish workflow's failure is the evidence
above.

## What this blocks

G2 (first publish) and everything downstream of it (C3.1–C3.6, G3, C4, C5). C1.0–C2.1 are
done and unaffected.