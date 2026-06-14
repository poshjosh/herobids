# RE-ALIGNMENT

1. `[done]` **Re-open the semantic part of Phase 2, not the whole phase**
   Keep the good work already done in `005`:
   - swap startup
   - live swap executor
   - Jupiter signing
   - confirmation polling
   - fill recording

   Re-open only the part that assumes **full wallet accounting truth**:
   - swap holdings model
   - swap reconciliation semantics
   - drift language / alerts

   Tracking note: delivered via `007-phase-2-shared-wallet-semantics-patch-plan.md` plus the Slice 0-5 implementation pass.

2. `[done]` **Write the doctrine doc immediately, before more Phase 2 cleanup**
   This becomes the rulebook for the unfinished swap work.
   It should say:
   - event records are authoritative
   - infra billing is authoritative
   - `capitalUsd` is a risk-budget baseline
   - shared-wallet balances are observational telemetry
   - strict wallet accounting is out of scope unless wallet is dedicated/managed

   Tracking note: implemented in `docs/best-practices/shared-wallet-accounting-boundary.md`.

3. `[done]` **Audit only the `005` surfaces first**
   Don’t scan the whole repo yet.
   First classify the files touched by swap execution:
   - `swap-position-tracker`
   - reconciliation loader/reconciler
   - swap venue ports
   - swap adapters
   - journal/alert language
   - tests that encode “wallet truth” assumptions

   This keeps the communication fix tied to the unfinished feature.

   Tracking note: captured in `007-phase-2-shared-wallet-semantics-patch-plan.md` under `Phase 2 File Disposition` and `Patch Slices`.

4. `[done]` **Change swap/shared-wallet behavior before finishing the wording sweep**
   In shared-wallet mode:
   - keep recording fills and sampled balances
   - keep confirmation polling
   - keep operational alerts
   - stop pretending expected holdings are accounting truth
   - disable or downgrade strict “drift detected” behavior that implies wallet-state authority

   In other words:
   - finish **swap execution**
   - soften or remove **strict swap accounting claims**

   Tracking note: landed in the tracker, reconciliation, actor, journal, alerting, and dashboard changes before the final doc sweep.

5. `[partial]` **Split Phase 2 into two explicit modes**
   Treat the unfinished feature as two distinct products:

   - **Mode A: shared wallet**
     - execution: yes
     - confirmations: yes
     - event log: yes
     - strict holdings reconciliation: no
     - sampled balance telemetry: yes

   - **Mode B: dedicated/managed wallet**
     - execution: yes
     - confirmations: yes
     - strict holdings reconciliation: yes

   This resolves the communication gap by making the product boundary explicit in code.

   Tracking note: Mode A is implemented and documented. Mode B is only documented as a deferred boundary and has not been built yet.

6. `[done]` **Update the plan and backlog before more implementation**
   002-backlog.md currently says Phase 2 is “completed.”
   I would change that.
   Mark it as something like:
   - execution path: done
   - reconciliation semantics for shared wallets: reopened
   - documentation/terminology alignment: todo

   That avoids future confusion and stops the team from building on a false “done.”

   Tracking note: first reopened in the backlog during the patch-plan phase, then closed again after Slice 5 realignment.

7. `[done]` **Then do the naming/docs sweep**
   After behavior is corrected, rename and rewrite things that imply full wallet accounting:
   - “expected holdings”
   - “drift detected”
   - “unexplained balance delta”
   - comments that imply correctness of absolute balances
   - docs/tests that treat wallet state as authoritative

   Tracking note: completed across the scoped Phase 2 surfaces, including `005-phase-2-complete-swap-execution.md`, backlog terminology, tracker naming, and reconciliation/event language.

8. `[done]` **Add a review checklist before moving to Phase 3**
   Every new swap/reconciliation change should answer:
   - Is this event-authoritative or balance-observational?
   - Does this imply full wallet truth?
   - Is this valid only for dedicated wallets?
   - Are we blocking trading based on a shared-wallet assumption?

   Tracking note: added to `docs/best-practices/shared-wallet-accounting-boundary.md` under `Review Checklist For Swap/Reconciliation Changes`.

9. **Only after that, continue with Phase 3**
   Then resume:
   - live order safety
   - timeouts
   - idempotency
   - crash wind-down
   - slippage alerts

**Short version**
Don’t pause the feature and don’t throw away the valid swap execution work.  
Instead:

1. write the doctrine,
2. reopen only the wallet-accounting part of `005`,
3. change shared-wallet swap behavior first,
4. then sweep language/docs,
5. then continue to Phase 3.

If you want, I can next turn this into a **concrete patch plan against the exact files in `005`**.