# A2A-A: Same-user check

**Depends on:** none (may run early). **Approvals:** DEC-40. **Replaces:** the original grant table and owner screen (deferred, DEC-45).

## Objective

One function that answers: may agent X message agent Y? For the MVP the answer is yes when both agents belong to the same user.

## Scope

1. Add `canPeerSend(fromAgentId, toAgentId)`. It returns true when both agents have the same `userId`, and false otherwise. It returns false, not an error, if either agent does not exist.
2. Use the existing agent repository to look up owners. Batch lookups are not needed here.
3. No table, no migration, no route, no screen.

## Out of scope

- Grants between users, per-pair grants, and the grant screen (DEC-40, DEC-45).
- Sending any message (A2A-B).

## Tests (required)

- Two agents of the same user: true.
- Two agents of different users: false.
- An unknown agent on either side: false.
- An agent with itself: true (sending to yourself is allowed; A2A-B decides whether to refuse it).

## Acceptance

- Targeted tests for the new function, named in PROGRESS.md.
- `npx tsc -p apps/api/tsconfig.json --noEmit` and `npx tsc -p apps/worker/tsconfig.json --noEmit` exit 0.
- `pnpm test`, compared with the C0 baseline.
