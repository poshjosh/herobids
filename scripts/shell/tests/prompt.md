GOAL

Repeatedly run scripts/shell/tests/agent-trade-test.sh, each run fix anomalies/problems till.

STEPS

1. Read scripts/shell/tests/agent-trade-test.sh

2. Determine a suitable value for <timeout>, or use 600000

3. Run `TIMEOUT_MS = <timeout> scripts/shell/tests/agent-trade-test.sh`

4. Wait for the script to complete; wait at most <timout> milliseconds.

5. Read and follow this .ignore/eval/eval-prompt.md, with meaningful values of both evaluation-period and agent-id

6. If there are observed anomalies/problems, fix them. Then Goto Step 1.

7. If there are no observed anomalies/problems, STOP.

