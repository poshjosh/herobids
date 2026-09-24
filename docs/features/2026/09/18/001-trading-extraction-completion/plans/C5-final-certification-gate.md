# Plan C5: Final Two-Repository Certification Gate

- **Task:** C5 — certify the completed extraction and capability-agnostic UI after every decided feature plan is complete.
- **Repo:** both
- **Status:** **REVIEW-CORRECTED; PENDING IMPLEMENTATION AUTHORIZATION** — this is a final gate, not implementation authorization.
- **Prereq:** all decided C-plans complete, all review findings dispositioned, and any B4/B5 work that is accepted complete. B4 and unaccepted B5/A9 work do not block this gate unless they become approved feature work.

## Purpose

Keep A8 unchanged as the Track-A baseline certification. C5 is the final
certification version: it runs the broad repository suites and then **reruns the
A8 procedure** against the final state. The A8 Markdown file is not executable;
execute its defined procedure and retain the evidence it requires.

## Procedure

1. Record the exact commits under test for both repositories. Working trees must
   be clean apart from the final certification evidence itself. Do not merge
   herobids into `main`.
2. From a clean shell, run these scripts sequentially and retain their logs:

   ```sh
   traderton/scripts/shell/tests/run-all-tests.sh --e2e
   traderton/scripts/shell/tests/run-extra-tests.sh --all
   traderton/scripts/shell/tests/run-integration.sh
   herobids/scripts/shell/tests/run-all-tests.sh --e2e
   herobids/scripts/shell/tests/run-extra-tests.sh --all
   ```

   Do not run cross-stack suites concurrently. They share Docker services,
   databases, and volume lifecycle.
3. Rerun the complete A8 procedure in
   `plans/A8-stabilization-certification-gate.md`: its static tier, clean
   cross-stack bring-up, live decisions/fills/positions assertions, boundary-tool
   sweep, actor fault recovery, and agent evaluation. A8 requires **two
   consecutive clean runs** with a fresh `down -v && up` between them.
4. Execute the updated C3 rows `AG-C01` through `AG-C06` in
   `docs/tech/user-acceptance-tests.md` against the final frontend at desktop
   and mobile viewport sizes. Record status, commit, date, and evidence in that
   checklist; an inapplicable case requires an explicit documented disposition,
   not a silent skip.
5. Record the five script results, both A8 runs, and the UAT evidence in a dated
   final-certification report under this feature's `reviews/` directory. Include
   commit SHAs, command logs/evidence paths, deviations, and the final pass/fail
   result.

## Failure Handling

- A product failure stops certification. File or update the owning bug/plan,
  make a focused fix, then restart C5 from step 1.
- A harness-only blind spot may be corrected as A8 permits, then rerun the
  affected command and both A8 runs.
- No extraction/capability work is declared complete until C5 passes.

## Acceptance

- All five scripts pass.
- Two consecutive full A8 runs pass and are recorded.
- Every applicable C3 UAT row passes and is recorded.
- The final-certification report links every required evidence artifact.

## References

- `plans/A8-stabilization-certification-gate.md`
- `reviews/2026-09-19-independent-plan-review-brief.md`
