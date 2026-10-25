# C2-R: Independent review of C2

**Status:** deferred (DEC-45). Do not start. Kept for later.

**Depends on:** C2. **Approvals:** DEC-33.

## Rules

- The reviewer is a different agent from the one that wrote C2. No human reviewer is needed.
- The reviewer does not change code. It reports findings. The author fixes them, and the reviewer checks the fixes.
- The reviewer may stop the item (tier 0) if a finding breaks an invariant.

## Inputs

- The C2 spec: [C2](./C2-binding.md).
- The diff for C2 (all commits from C2).
- DEC-05 to DEC-07, DEC-11, DEC-26, DEC-27, DEC-34 in [DECISIONS](../DECISIONS.md).
- The invariants in [ENTRYPOINT](../ENTRYPOINT.md) section 4.

## Checklist

1. The one-time code is stored only as a salted hash. It is never logged or returned after issue.
2. Attempts are capped per challenge, and the cap is enforced in the same transaction as the check.
3. Expired and consumed codes are refused. A consumed code cannot be reused.
4. The 409 `chat_address.already_bound` check runs under `pg_advisory_xact_lock` on `(provider, address)`, inside the write transaction.
5. A suppression is lifted only by a successful bind of that exact address (DEC-05).
6. Inbound messages cannot create or change a binding (DEC-07).
7. The Telegram webhook secret check is unchanged.
8. `POST /agents/verify-telegram` is removed, and grep finds no references (DEC-34).
9. The request limit per user is enforced from operator config.
10. No secret value appears in code, tests, logs, or docs (I6).

## Output

Record in PROGRESS.md: the reviewer's identity (agent instance), each checklist item as pass or finding, and the final result, PASS or FAIL. C2-R is ticked only on PASS. A FAIL returns the item to the author.

## Gate

PASS recorded in PROGRESS.md. Then U may start.
