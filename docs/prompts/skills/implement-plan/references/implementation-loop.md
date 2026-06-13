# Implementation Loop

Base workflow derived from `docs/prompts/implement-plan.md`.

1. Read the target plan.

2. Implement the plan.

3. Review what you implemented for completeness, correctness, and possible improvements.

4. If there are no observations that need to be addressed, you are done implementing - STOP.

5. If there are observations that need to be addressed:
   - Note them.
   - Qualify each observation as `LOW`, `MEDIUM`, or `HIGH`.
   - Address the observations with changes that resolve the issue cleanly and without introducing new problems or code smells.
   - Go to Step 3.

## Review Standard

- `HIGH`: Likely bug, unsafe behavior, broken requirement, or serious regression.
- `MEDIUM`: Correctness risk, maintainability issue, missing important validation, or design mismatch.
- `LOW`: Minor improvement, polish, or non-blocking cleanup.

## Repo-Specific Expectations

- Stay anchored to the smallest code path that controls the requested behavior.
- Validate immediately after the first real edit using the narrowest useful check.
- Run `pnpm lint` before finishing.