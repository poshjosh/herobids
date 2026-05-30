# Bug Report: Monitor Silently Polls Crashed Instance Without Operator Alert

- **Status:** OPEN
- **Severity:** Medium
- **Date:** 2026-05-30
- **Summary:** When a trading instance transitions to `status=crashed`, the inline monitor continues to emit the same status line every 5 seconds indefinitely. There is no one-time alert, no escalation, and no indication of how long the crash has persisted. An operator who is not watching the terminal closely will miss the event entirely.

## Observed Behavior

After the instance crashed (due to bug #001 — missing `walletAddress`), the monitor output for the next ~11 minutes was:

```
[17:24:16] paper | status=running   | orders=0 | fills=0 | recon=none
[17:24:22] paper | status=crashed   | orders=0 | fills=0 | recon=none
[17:24:28] paper | status=crashed   | orders=0 | fills=0 | recon=none
[17:24:34] paper | status=crashed   | orders=0 | fills=0 | recon=none
... (repeated every 5s for ~11 minutes) ...
[17:35:09] paper | status=crashed   | orders=0 | fills=0 | recon=none
```

The `status=crashed` text is rendered in red, but there is no:
- One-time prominent alert on first crash detection (e.g. `[ERROR] INSTANCE CRASHED`)
- Count or duration showing how long the crash has persisted
- Bell/beep or any other attention mechanism
- Auto-exit after a configurable number of consecutive crash polls

## Expected Behavior

On the first poll that transitions status to `crashed`, the monitor should emit a loud, distinct alert, separate from the normal polling line:

```
[17:24:22] paper | status=crashed   | orders=0 | fills=0 | recon=none

  !! INSTANCE CRASHED — investigate before continuing !!
  Check worker log:  /tmp/herobids-worker-stage-b.log
  Check API log:     /tmp/herobids-api-stage-b.log
```

On subsequent polls in the crashed state, the line should indicate how long the crash has persisted:

```
[17:24:28] paper | status=crashed (6s) | orders=0 | fills=0 | recon=none
[17:24:34] paper | status=crashed (12s) | orders=0 | fills=0 | recon=none
```

Or, the monitor could auto-exit with a non-zero code after N consecutive crash observations (e.g. 3), letting the watchdog's `die` propagate cleanup. This may be cleaner than indefinite polling of a permanently failed state.

## Root Cause

The monitor loop in `scripts/shell/rollout-stage-b.sh` does not track the previous status between iterations. Each iteration is stateless with respect to `INST_STATUS`. The `LAST_FILL_COUNT` tracker exists for fills (which correctly emits a "NEW FILL" alert), but no equivalent tracker exists for status transitions.

Relevant section of the monitor loop (simplified):

```bash
LAST_FILL_COUNT=0
while true; do
  # ... poll live-status ...
  [[ "$INST_STATUS" == "crashed" ]] && STATUS_COLOR="$RED"
  echo -e "... | status=${STATUS_COLOR}$INST_STATUS${NC} | ..."
  sleep "$MONITOR_INTERVAL"
done
```

The pattern needed is the same as `LAST_FILL_COUNT` — a `LAST_STATUS` tracker that emits an alert on first transition to `crashed` and optionally counts consecutive crash observations.

## Proposed Fix

```bash
LAST_STATUS=""
CRASH_SINCE=""

# ... inside the while loop, after INST_STATUS is set ...

if [[ "$INST_STATUS" == "crashed" && "$LAST_STATUS" != "crashed" ]]; then
  CRASH_SINCE=$(date '+%H:%M:%S')
  echo ""
  echo -e "${RED}!! INSTANCE CRASHED at $CRASH_SINCE — investigate before continuing !!${NC}"
  echo -e "   Worker log: /tmp/herobids-worker-stage-b.log"
  echo -e "   API log:    /tmp/herobids-api-stage-b.log"
  echo ""
fi

# Append crash duration to status line
CRASH_SUFFIX=""
if [[ "$INST_STATUS" == "crashed" && -n "$CRASH_SINCE" ]]; then
  CRASH_SECS=$(( $(date +%s) - $(date -d "$CRASH_SINCE" +%s 2>/dev/null || date -j -f '%H:%M:%S' "$CRASH_SINCE" +%s 2>/dev/null || echo 0) ))
  CRASH_SUFFIX=" (${CRASH_SECS}s)"
fi

LAST_STATUS="$INST_STATUS"
```

## Files Affected

- `scripts/shell/rollout-stage-b.sh` (monitor loop)
- `scripts/shell/rollout-monitor.sh` (same pattern, same fix needed)

## Notes

- The `LAST_FILL_COUNT` fill-alert pattern already exists in the monitor and works correctly. The status transition alert is a direct parallel.
- The `date -d` flag is Linux-only; macOS requires `date -j -f`. Any implementation must handle both or use `node` for the arithmetic (already a dependency in the monitor).
- Auto-exit after N consecutive crashes is an option worth considering — a crashed instance will not self-recover without operator intervention, so continued polling adds no value after the alert has been emitted.
