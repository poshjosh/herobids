# Bug Report: Canonical Decision-Context Hashing and Mark Source Propagation

- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-06-03
- **Summary:** The engine currently uses two different decision-context hash implementations, and the shared decision-intake persistence path drops `markSource` when persisting positions. Strategy-originated decisions and agent-originated decisions can therefore diverge on hash semantics, and persisted position provenance is incomplete.

## Root Cause

- `packages/engine/src/trading-cycle.ts` hashes `snapshot + position + strategyConfig` before calling the intake pipeline.
- `packages/engine/src/decision-intake.ts` hashes the full `DecisionContext`, but still trusts a supplied non-empty `decision.contextHash` instead of enforcing the canonical server hash.
- `packages/engine/src/decision-intake.ts` persists positions without passing `markSource`, even though the repository layer already supports it.
- The repo does not currently have a shared canonical decision-context hash helper for both paths.

## Minimal Edits Needed

1. Add a shared helper, for example `packages/engine/src/decision-context-hash.ts`, and export it from `packages/engine/src/index.ts` if needed.
2. Update `packages/engine/src/trading-cycle.ts` to build the full `DecisionContext` first and stamp the decision with the shared canonical hash.
3. Update `packages/engine/src/decision-intake.ts` to use the shared helper, reject mismatched supplied hashes with a stable validation code, persist the canonical hash, and pass `markSource: context.referenceMark.source` into `persistPosition(...)`.
4. Update `apps/worker/src/agents/agent-decision-handler.ts` to map the validation failure to a stable rejection code for the agent protocol.
5. Add or update tests in `packages/engine/src/trading-cycle.test.ts` and a new `packages/engine/src/decision-intake.test.ts`; add agent-session/health coverage if you want regression protection around the runtime side.

## Files Changed

- None yet.

## Verification

- Not run yet. After the code change, validate with focused engine and worker tests covering canonical hash equality, hash mismatch rejection, and persisted `markSource`.
