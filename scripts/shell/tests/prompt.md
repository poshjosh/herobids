GOAL

Repeatedly run scripts/shell/tests/agent-trade-test.sh, each run fix anomalies/problems till there are no problems. Follow the steps below:

STEPS

1. Read scripts/shell/tests/agent-trade-test.sh

2. Determine a suitable value for <timeout>, or use 600000

3. Run `TIMEOUT_MS = <timeout> scripts/shell/tests/agent-trade-test.sh`

4. Wait for the script to complete; wait at most <timout> milliseconds.

5. Read and follow this .ignore/eval/eval-prompt.md, with meaningful values for both evaluation-period and agent-id

6. If there are observed errors/bugs which prevent trading or other serious problems: 

   a. Investigate the errors/bugs which prevent trading (or other serious problems).

   b. Implement the fix for the errors/bugs which prevent trading (or other serious problems).

   c. File a bug report in docs/bug-reports/2026/06/13/<serial>-<bug-title>.md

   d. Review the code following this: .github/agents/CodeReviewer.agent.md

   e. Address the code review observations, if any are valid by making the appropriate code changes.

   f. Goto Step 1.

7. If there are no observed anomalies/problems, STOP.

