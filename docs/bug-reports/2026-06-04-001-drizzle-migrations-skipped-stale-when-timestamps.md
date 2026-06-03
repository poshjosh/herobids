# Bug Report: Login 500 — `column "telegram_chat_id" does not exist`

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** POST `/auth/login` and `/auth/register` returned HTTP 500 because the `users` table was missing the `telegram_chat_id` column introduced in migration `0015_agent_mvp_communication`.

---

## Root Cause

Drizzle-kit `migrate` uses the `when` field of each `_journal.json` entry as the `created_at` value stored in `drizzle.__drizzle_migrations`. When deciding which migrations are pending it skips any journal entry whose `when` value is less than the maximum `created_at` already in the tracking table.

Migrations `0014_agent_protocol` and `0015_agent_mvp_communication` were added to the journal **manually** (not via `drizzle-kit generate`) with stale round-number timestamps:

| idx | tag | `when` (ms) | approximate date |
|-----|-----|-------------|-----------------|
| 13 | `0013_scope_subscription_identity` | `1781164800000` | ~2026-06-07 |
| 14 | `0014_agent_protocol` | **`1748908800000`** | ~2025-06-03 ← past |
| 15 | `0015_agent_mvp_communication` | **`1748995200000`** | ~2025-06-04 ← past |

Because entries 14 and 15 had `when < max(created_at)` of existing applied migrations, drizzle silently skipped them, reported `[✓] migrations applied successfully!`, and left the schema incomplete. The Docker migrate image had also been cached before these SQL files were committed, compounding the problem.

---

## Fix

### 1. Fix `_journal.json` timestamps (prevents recurrence on fresh installs)

Updated `when` for entries 14 and 15 to be sequentially after entry 13:

```json
{ "idx": 14, "when": 1781251200000, ... }   // was 1748908800000
{ "idx": 15, "when": 1781337600000, ... }   // was 1748995200000
```

### 2. Apply pending SQL directly to the live volume

```bash
docker exec -i herobids-postgres-1 psql -U herobids -d herobids \
  < packages/db/drizzle/0014_agent_protocol.sql

docker exec -i herobids-postgres-1 psql -U herobids -d herobids \
  < packages/db/drizzle/0015_agent_mvp_communication.sql
```

### 3. Register migration hashes in tracking table

Inserted the SHA-256 hashes of the SQL files with the corrected timestamps so drizzle does not attempt to re-run them:

```sql
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
  ('76bc3f2fe279ba9e0266b62ff90156dd39fb2923bc63aeb6adeecaa416866dce', 1781251200000),
  ('a899431c5013073e472611be88f1bf30b968d4305ab90bc6a4ee3eaf2e2da401', 1781337600000);
```

### 4. Rebuild migrate image without cache

```bash
docker compose build --no-cache migrate
docker compose run --rm migrate   # → [✓] migrations applied successfully!
```

---

## Files Changed

- `packages/db/drizzle/meta/_journal.json` — corrected `when` timestamps for entries 14 and 15

---

## Verification

1. `\d users` in postgres shows `telegram_chat_id` column present.
2. `SELECT COUNT(*) FROM drizzle.__drizzle_migrations` → 16 rows.
3. `docker compose run --rm migrate` → `[✓] migrations applied successfully!` (no SQL executed).
4. `POST /auth/login` returns `{"error":"Invalid email or password"}` (no 500).

---

## Prevention

- **Never hand-edit journal `when` timestamps with dates in the past.** Use `Date.now()` or a future timestamp relative to the last entry.
- Always run `drizzle-kit migrate` locally against a clean DB after adding a migration to confirm it applies before committing.
- Rebuild the migrate image with `--no-cache` after adding new migration files to ensure the image layer is not stale.
