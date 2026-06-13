GOAL

Repeatedly run scripts/shell/tests/agent-trade-test.sh, each run fix anomalies/problems till there are no problems. Follow the steps below:

STEPS

1. Shutdown the stack; for that, this command is recommended: `docker compose -f docker-compose.yaml -f docker-compose.dev.yaml down -v --remove-orphans && docker system prune -f`

2. Start the stack, for that, this command is recommended: `scripts/shell/run/build-and-run.sh`.

3. Read scripts/shell/tests/agent-trade-test.sh to understand the next step, then determine a suitable value for <timeout>, or use 600000.

4. Run `TIMEOUT_MS = <timeout> scripts/shell/tests/agent-trade-test.sh`

5. Wait for the script to complete; wait at most <timout> milliseconds.

6. Read and execute/implement this: .ignore/eval/eval-prompt.md, with meaningful values for both evaluation-period and agent-id

7. If there are observed errors/bugs which prevent trading (or other serious problems): 

   a. Investigate the errors/bugs which prevent trading (or other serious problems).

   b. Implement the fix for the errors/bugs which prevent trading (or other serious problems).

   c. File a bug report in docs/bug-reports/2026/06/13/<serial>-<bug-title>.md

   d. Review the code following this: .github/agents/CodeReviewer.agent.md

   e. Address the code review observations, if any are valid, by making the appropriate code changes.

   f. Verify that tests pass.

   g. Git add and commit the changes you made, if any. 

   h. Goto Step 1.

8. If there are no observed anomalies/problems, STOP.

