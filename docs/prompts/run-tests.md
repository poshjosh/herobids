Build and run the code, then run tests - fix the code or tests till all tests pass.

Run the following commands sequentially:

```
pnpm build

pnpm lint

docker build -f docker/Dockerfile.agent -t herobids-agent:latest .

scripts/shell/tests/run-all-tests.sh --e2e
```

1. if any command fails at any point, stop and fix (e.g. the script, the associated code if any, the test e.t.c.)

2. retry No. 1 till success

3. pick next command if any, then start at No. 1

Run the app in a browser you can control then run manual uats in docs/tech/user-acceptance-tests.md and if need implement fixes. For each test, first remove the pass mark. Then mark each as passed only after each passes. Do this repeatedly till all tests pass.

For each fix, file a bug report in docs/bug-reports/yyyy/MM/dd/<serial>-<name>.md if appropriate.
