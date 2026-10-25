# U: Messaging as a user capability

**Status:** deferred (DEC-45). Do not start. Kept for later.

**Depends on:** C2. **Approvals:** DEC-20 (plan-then-build with self-review). **Plan to write:** `090-messaging-capability.md` in this folder, following the plan format of [900](../900-implementation-plan.md).

## Objective

A user adds, edits, and removes messaging connections the same way they manage trading, email, and other capabilities. The capability registry already has a planned `messaging / chat / sms` row (Phase 0).

## Step 1: write the plan

Write `090-messaging-capability.md` with:

- Goal, non-goals, and current state (verified by reading code, with file references).
- Design decisions, each with a recommended option.
- Tasks, each with a gate and its dependencies.

## Step 2: self-review (DEC-20)

Check the plan against this list. Record each answer in PROGRESS.md.

1. Each invariant in ENTRYPOINT section 4 is addressed or marked not applicable.
2. No design decision needs a public API change beyond DEC-10. If one does, it is tier 3.
3. No design decision needs a security-boundary change beyond DEC-05 to DEC-07. If one does, it is tier 3.
4. No design touches trading execution (I5).
5. Each task has a gate, and each gate names a command.
6. Telegram regression tests are named for every step.
7. No new secret value is needed (I6).

If every answer is yes, proceed to step 3. If any answer is no, write the open question in OPEN-QUESTIONS, mark U blocked-on-owner, and move to the next ready item.

## Step 3: build

Implement the tasks in the plan, one commit per task. Tick U in QUEUE.md when every task gate passes and the evidence is in PROGRESS.md.

## Acceptance

- The user can add, edit, and remove a messaging connection from the capability surface in the web app. The existing Telegram flow still works.
- The capability works for `telegram` only in this item. Other providers are not part of U.
- Type checks, targeted tests, and `pnpm test` pass.
