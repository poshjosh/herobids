# Plan: DB-Driven Admin with Promote/Demote

Date: 2026-06-12

---

## Overview

Replace the config-list approach to admin access (`AUTH_ADMIN_USER_IDS`) with a DB-driven `is_admin` flag on the `users` table. Admin status is explicitly granted by an existing admin via a promote endpoint. The seed script remains the operator bootstrap escape hatch for the first admin.

Admin users bypass all plan limits — they are operators, not plan subscribers.

---

## Dependency Graph

```text
Step 1 (DB migration — add is_admin column)
  -> Step 2 (update seed-admin.ts to set is_admin)
  -> Step 3 (replace requireAdmin to read from DB)
      -> Step 4 (promote/demote endpoints)
  -> Step 5 (bypass plan limits for admins)
  -> Step 6 (remove AUTH_ADMIN_USER_IDS from config + schema)
```

---

## Steps

### Step 1 — Add `is_admin` to users table

Files:
- `packages/db/src/schema/users.ts`
- `packages/db/drizzle/` (new migration via `drizzle-kit generate`)

Changes:

1. Add `isAdmin: boolean('is_admin').notNull().default(false)` to the `users` table definition.
2. Run `pnpm --filter @herobids/db run generate` to produce the migration file.
3. Do not manually edit the migration file.

---

### Step 2 — Update seed-admin.ts to set is_admin

Files:
- `scripts/ts/seed-admin.ts`

Changes:

1. In the `tx.insert(users).values(...)` call, add `isAdmin: true`.
2. Remove `ADMIN_PLAN_ID` support — admin bypasses plan limits (Step 5), so plan assignment is irrelevant for the admin user.
3. Update the header comment to remove `ADMIN_PLAN_ID` documentation.

---

### Step 3 — Replace requireAdmin to check DB is_admin flag

Files:
- `apps/api/src/routes/admin.ts`

Changes:

1. Change `requireAdmin` to query the `users` table for `isAdmin` on the authenticated `request.userId` instead of checking a static list.
2. Remove the `adminUserIds` local variable and the `authConfig.adminUserIds` reference.
3. The preHandler must return 403 if `is_admin` is false or the user row is not found.

---

### Step 4 — Add promote and demote endpoints

Files:
- `apps/api/src/routes/admin.ts`

Changes:

1. Add `POST /admin/users/:id/promote` — sets `is_admin = true` for the target user. Requires `requireAdmin`. Returns 200 with updated user summary.
2. Add `DELETE /admin/users/:id/admin` — sets `is_admin = false` for the target user. Requires `requireAdmin`. Guard: cannot demote yourself (return 400).
3. Both endpoints update `updatedAt` on the user row.

---

### Step 5 — Bypass plan limits for admin users

Files:
- `apps/api/src/plan-guards.ts`

Changes:

1. Add an `isAdmin: boolean` parameter to each exported `check*Limit` function signature.
2. At the top of each function body, return `ok(undefined)` immediately when `isAdmin` is true.
3. Each call site in route handlers must pass `request.isAdmin` (or fetch it from the session/user row). If the session does not already carry `isAdmin`, fetch it from the DB once per request in the auth middleware and attach it to `request`.

---

### Step 6 — Remove AUTH_ADMIN_USER_IDS from config and schema

Files:
- `packages/domain/src/config/schema.ts`
- `apps/api/src/config.ts`
- `config/default.yaml` (if it has an `adminUserIds` entry)

Changes:

1. Remove `adminUserIds` from the `auth` section of the Zod schema in `packages/domain/src/config/schema.ts`.
2. Remove the `AUTH_ADMIN_USER_IDS` env override mapping from `apps/api/src/config.ts`.
3. Remove any `adminUserIds` key from `config/default.yaml` if present.

---

## Acceptance Criteria

- Seeding with `ADMIN_EMAIL` + `ADMIN_PASSWORD` creates a user with `is_admin = true`.
- An admin can call `POST /admin/users/:id/promote` to grant admin to another user; that user can then access `/admin/*` routes.
- An admin can call `DELETE /admin/users/:id/admin` to revoke admin from another user.
- An admin cannot demote themselves.
- Admin users are not subject to plan limits on any resource.
- `AUTH_ADMIN_USER_IDS` is gone — setting it has no effect.
- `pnpm lint` passes.
- `pnpm test` passes.
