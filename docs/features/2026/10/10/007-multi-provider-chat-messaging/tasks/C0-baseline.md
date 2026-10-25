# C0: Baseline

**Depends on:** none. **Approvals:** DEC-25. **Tier 4 risk:** none.

## Objective

Record the real test counts before any cutover change, so every later gate compares against one number.

## Steps

1. Confirm a clean tree for the files you will not touch (`git status`). Do not revert others' uncommitted edits.
2. Run `pnpm install` only if a manifest changed or a dependency is missing.
3. Run `pnpm test`. Record the files passed and skipped, and the tests passed and skipped.
4. Run the three type checks (ENTRYPOINT section 7).
5. Update the 900 plan "P0 baseline record" section with the real counts and the date.
6. Replace the two conflicting figures in [095](../095-chat-address-migration-plan.md) §6 with a pointer to that record.

## Acceptance

- `pnpm test` completes. Its counts are recorded in 900 and in PROGRESS.md.
- The three type checks exit 0.
- No code changed.

## Rollback

Doc-only. Revert the doc edit if the counts are wrong.
