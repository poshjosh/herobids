# Decision Record D-YYYY-NNN: <short title>

**Status:** Recommended / Settled / Needs ratification / Needs owner / Ratified / Superseded
**Date:** YYYY-MM-DD
**Brief:** <link or "problem statement given inline">
**Decision agent:** <name or model>
**Challenger:** <name or model, with result attached in section 14> (T2 only)
**Tier:** T1 / T2
**Reversibility:** R0 / R1 / R2 / R3. If staged: one class per stage.
**Code state read:** `herobids` <commit>, `traderton` <commit>, environment(s) <...>
**Supersedes:** <IDs or none>

> Keep sections 1 to 13 to about 150 lines. Put long evidence tables in the Appendix.

## 1. Recommendation (one sentence)

<the decision, stated so that someone can act on it>

**Escalation gate result:** (use the exact phrases from 06 section 7; for a split decision use two lines)

- Settled by precedent / Settled within the rules / Needs ratification: violates|contradicts|undermines `<ID>`
- Needs owner: `<what>` before `<stage>` (only if it applies)

**Confidence:** High / Medium / Low, because <reason>

## 2. Framing

- **Problem in plain language:** <five sentences or fewer>
- **Premise check:** <what the brief assumed; anything false, stale or unverified, corrected>
- **Cost of delay:** <...>
- **Requester gaps closed:** <gaps the brief left as unknown that you closed by checking, so the requester improves. "None" if none>

## 3. Context used

| Kind | IDs |
|---|---|
| Strategic objectives | |
| Service expectations / owner requirements | |
| Invariants touched (and how: kept / deliberately broken) | |
| Register rows | |
| Assumptions relied on (with grade) | |
| Open decisions depended on | |

## 4. Key facts

The facts the recommendation depends on. Full evidence goes in the Appendix.

| # | Fact | Source | Env | Grade |
|---|---|---|---|---|

## 5. Options

| ID | Option | Origin | Invariant gate |
|---|---|---|---|
| O0 | Baseline: <...> | Agent | Pass / Fail `<ID>` |
| O1 | <...> | Requester | |
| O2 | <...> | Agent (derived) | |

### Ratings against the baseline (-2 to +2, one sentence each, no totals; add a column per option)

| Criterion | O1 | O2 |
|---|---|---|
| C2 Risk and safety | | |
| C3 Reliability | | |
| C4 Unit cost (a range with grade while SO-1 targets are TBD) | | |
| C5 Time to value | | |
| C6 Simplicity and maintainability | | |
| C7 Reversibility and optionality | | |
| C8 Strategic fit | | |

Deal-breakers: <...>

## 6. Reasons (ten lines or fewer)

<why this option beats the baseline and the others>

## 7. Stress tests

**Sensitivity** (three weakest assumptions):

| Assumption | If wrong by 2x or false | Ranking changes? |
|---|---|---|

**Pre-mortem** (it failed in twelve months; three most plausible causes):

1. <cause, and what would have caught it early>
2.
3.

## 8. Consequences

- **Becomes true:** <...>
- **Blocked:** <...>
- **Unblocked:** <...>
- **Cost and effort (ranges with grades):** <...>

## 9. What would change this recommendation

<measurable conditions>

## 10. Cheapest experiment

<the smallest test that upgrades the weakest assumption. Read-only on shared systems, or on a local or isolated stack>

## 11. Review trigger

| Trigger | Threshold | How derived or "provisional (G)" | Effect |
|---|---|---|---|

## 12. Owner questions (only if gate G3 or G4 applies; never for facts a check or earlier answer provides)

| Question | Why only the owner can answer | Recommended answer and reason | Consequence of each answer |
|---|---|---|---|

## 13. Register updates and gaps

**Gaps found in the decision folder:** <missing invariants, assumptions, decisions, stale rows. Propose entries. Do not invent.>

**Updates required** (the executor applies them after section 14 is attached, unless the task says otherwise):

- [ ] `03-decision-register.md`: <row>
- [ ] `04-assumptions-and-limitations.md`: <rows>
- [ ] `05-open-decisions.md`: <remove / unblock / add>
- [ ] `02-invariants.md`: <only if a rule changed; owner approves>
- [ ] ADR needed (architectural and lasting): yes / no
- [ ] Traderton reference needed (decision log pointer): yes / no

## 14. Challenger result (T2)

Holds: <...>
Weak: <...>
Broken: <...>
Verdict: Recommendation stands / Stands with changes / Does not stand

## 15. Owner ratification

<blank until ratified. Date, decision, any change.>

---

## Appendix: evidence

Full fact table with sources and grades, premise corrections, the sizing arithmetic, and anything long.
