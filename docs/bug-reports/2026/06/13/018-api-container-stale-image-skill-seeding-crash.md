# 018 — API container crash: stale Docker image after skill-seeding fix (011 regression)

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-13
- **Summary:** `herobids-api-1` container was still exiting unhealthy with the `uq_skill_revisions_skill_version` duplicate-key crash (bug 011) even though the source-code fix was already committed. The running Docker image was stale and had not been rebuilt.

## Root Cause

Bug 011 was fixed in `apps/api/src/routes/skills.ts` by querying for any existing `skill_revisions` row with `(skill_id, version=1)` before generating the revision ID. However, `docker compose up -d` reuses cached images and does **not** rebuild them automatically. The API container therefore continued to run the old, unfixed image.

The issue was compounded by bug 017: passing `DOCKER_COMPOSE_UP=1` on the CLI was silently ignored due to the env-file override, so the auto-start path in the trade test also used the stale image.

## Fix

Rebuild only the API image and restart the container:

```bash
docker compose up -d --build api
```

No source-code changes were needed — the fix from bug 011 was already present.

## Files Changed

None (operational fix — Docker image rebuild only).

## Related

- [011-api-startup-skill-revision-duplicate-key-crash.md](./011-api-startup-skill-revision-duplicate-key-crash.md) — original fix
- [017-agent-trade-test-sh-cli-env-overridden-by-env-file.md](./017-agent-trade-test-sh-cli-env-overridden-by-env-file.md) — masked DOCKER_COMPOSE_UP override

## Verification

After `docker compose up -d --build api`, the API container became healthy (`{"status":"ok"}`) and the agent trade test progressed through all phases successfully.

## Prevention

Run `docker compose up -d --build <service>` (not just `up -d`) after any code change that affects a containerised service.
