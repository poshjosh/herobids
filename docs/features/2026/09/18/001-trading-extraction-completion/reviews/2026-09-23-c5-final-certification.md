# C5 Final Certification Report

**Date:** 2026-09-23
**Status:** Evidence recorded; final C5 verdict pending the documented manual AG-C02 two-connection observation.

## Commits Under Test

| Repository | Branch | Commit |
|---|---|---|
| herobids | `consume-traderton` | `fe356d4c3dc99aa55792eceeaa0a6d34de023300` |
| traderton | `main` | `e6bc83f223a556a5e5017b37bd04e011c31e856e` |

Both worktrees were reported clean when the C5 run started. Herobids remains unmerged into `main`.

## Broad Certification Suites

The operator reports two successful sequential passes of each command:

```sh
traderton/scripts/shell/tests/run-all-tests.sh --e2e
traderton/scripts/shell/tests/run-extra-tests.sh --all
traderton/scripts/shell/tests/run-integration.sh
herobids/scripts/shell/tests/run-all-tests.sh --e2e
herobids/scripts/shell/tests/run-extra-tests.sh --all
```

No cross-stack suites were run concurrently.

## A8 Stabilization Gate

The operator reports two successful A8 runs, with fresh stack resets between runs as required by the A8 procedure.

The runs were supplemented by a 24-hour local cross-stack observation and five-agent evaluation. Its archived evidence is under `.ignore/eval/2026/09/23/`, with the consolidated report at `.ignore/eval/2026/09/23/REPORT.md`.

### Evaluation Summary

- Five agents observed from 2026-09-22 16:08 UTC through 2026-09-23 15:45 UTC.
- One shadow-mode direct-trading agent produced 15 decisions, 10 fills, 7 positions, and contiguous decision/fill/position/journal evidence.
- Boundary HMAC connectivity, profile-backed `$1,000` capital, risk rejection/retry behavior, TP/SL watch creation, market-data reads, and persistence across Herobids, Traderton, and Redis were observed.
- The evaluation identified operational findings, including an excessive `check_watches` polling rate, malformed `removeTriggered` boolean arguments, Docker event-stream reconnects, discovery-provider rate-limit noise, dormant scanner-gated agents, and inert preset-review candidates. The check-watches findings were captured and fixed in the post-evaluation bug-fix commits; the remaining findings are recorded for follow-up and do not invalidate the observed end-to-end trading path.

## C3 User Acceptance Evidence

- **AG-C01:** operator performed a final visual audit and confirmed that generic UI surfaces contain no trading-specific presentation. Out-of-plan observations were recorded as future TODOs.
- **AG-C03, AG-C05, AG-C06:** previously recorded passing evidence remains applicable; no regression was reported during the final visual audit.
- **AG-C04:** server-side semantic emphasis and generic frontend token mapping remain covered by the focused API and web tests recorded in the UAT row.
- **AG-C02:** backend two-connection selection/no-leak coverage passes, but the UAT row explicitly defers the final live browser observation. The operator did not report that specific default-ready switching observation in this certification evidence, so it is not claimed as complete here.

## Deviations and Verdict

No automated certification command remains unrun. The broad suites, two A8 runs, and extended agent evaluation are recorded as successful operator evidence.

**C5 is not marked verified by this report** because its acceptance criteria require every applicable C3 UAT row to be recorded, and the final live AG-C02 two-ready-connection switching observation has not been documented. This is a documentation/evidence gap, not a reported product or automated-test failure.

## Follow-Up Boundaries

- B4 and the optional B5/A9 sweep remain separate decision work and do not block C5.
- The unplanned trading-specific UI observations from the final audit are future TODOs, outside the decided C3 scope.
- The Agent Evaluation Report's operational improvements are follow-up work unless separately authorized.
