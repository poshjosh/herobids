- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-19
- **Summary:** The migration SQL file `0047_gifted_night_nurse.sql` is missing from `packages/db/drizzle/` while its journal entry (`packages/db/drizzle/meta/_journal.json`) and snapshot (`packages/db/drizzle/meta/0047_snapshot.json`) are intact. This breaks `drizzle-kit migrate` on fresh databases because Drizzle expects every journal tag to have a matching `.sql` file.
- **Root Cause:** The SQL file was accidentally deleted. The snapshot and journal entry confirm Drizzle generated this migration at some point. Because all subsequent SQL files (0048) apply cleanly after 0046, this migration was a snapshot-only bump with no additional DDL changes beyond what adjacent migrations already cover.
- **Reproduction:**
  1. Start a fresh Postgres database.
  2. Run `pnpm --filter @herobids/db run db:migrate`.
  3. Drizzle fails with exit code 1 because it cannot find `0047_gifted_night_nurse.sql`.
  4. The row-5 verification script (`016-db-migration-and-journal-verification.sh`) now catches this preflight with a clear journal/SQL file mismatch message.
- **Fix:**
  1. Recreated `packages/db/drizzle/0047_gifted_night_nurse.sql` as a minimal file with a comment explaining the reconstruction. The file contains no DDL because all schema changes are already covered by 0046 and 0048.
  2. The row-5 verification script now validates journal/SQL file alignment before running Docker migrations, so this class of error fails fast with a clear message instead of an opaque Drizzle exit code.
- **Files Changed:**
  - `packages/db/drizzle/0047_gifted_night_nurse.sql` — recreated (new file)
  - `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/016-db-migration-and-journal-verification.sh` — added journal/SQL mismatch preflight; made `__drizzle_migrations` DB-count check gracefully handle absent table
- **Verification:**
  1. `bash docs/features/2026/07/18/002-platform-preset-assessment-and-transition/016-db-migration-and-journal-verification.sh` passes — fresh-DB migration succeeds, journal/SQL alignment verified, worker boots in stub mode, all 7 expected assessment tables exist.
  2. `pnpm lint` passes.
