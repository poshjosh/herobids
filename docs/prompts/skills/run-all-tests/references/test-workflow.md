# Test Workflow

## Required Command Sequence

Run these commands in order:

```bash
pnpm build
pnpm lint
docker build -f docker/Dockerfile.agent -t herobids-agent:latest .
scripts/shell/tests/run-all-tests.sh --e2e
```

## Failure Handling Loop

1. If any command fails, stop at that point.
2. Fix the code, tests, scripts, or related issue.
3. Re-run the same command until it passes.
4. Move to the next command and repeat the same rule.

## UAT Phase

After the command sequence passes:

1. Run the app in a browser you can control.
2. Use `docs/tech/user-acceptance-tests.md` as the manual checklist.
3. Remove existing pass marks before retesting.
4. Mark a test as passed only after it passes.
5. If a UAT fails, fix the defect and repeat until all UATs pass.

## Bug Reports

If appropriate, create a bug report at:

`docs/bug-reports/yyyy/MM/dd/<serial>-<name>.md`

Include:

- the failure symptom
- the root cause
- the fix
- the validation that proved it is resolved

## Repo Context

- The standard full-suite script is `scripts/shell/tests/run-all-tests.sh`.
- Pass `--e2e` to include the Docker-backed end-to-end tier.
- Keep the process iterative: fail, repair, re-run, continue.