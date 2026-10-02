# Phase 3 Program — ESCALATIONS (append; never pause)

**Status:** pre-seeded and live. **Append to this file and keep working.**
**Created:** 2026-10-02

## How to use this file

Per `ENTRYPOINT.md §5.3`: if something genuinely needs the operator, append a row
below and **continue with everything else**. Do not interrupt the run per
question. The operator resolves the whole batch at the end, the way the Phase-2
E1/E2/E3 batch was resolved.

Mark the task ⤴ in `TASKS.md` (not 🚫) and move on. 🚫 is only for the three hard
stops in `ENTRYPOINT.md §6`.

Each row needs:
- **What** — the item, with `file:line` where applicable
- **Options** — the realistic choices
- **Recommendation** — your engineering-neutral lean
- **Why it needs the operator** — what makes it not yours to decide

An item is NOT escalation-worthy just because it is significant. Apply
`ENTRYPOINT.md §5.1`: if you can state the decisive reason in one sentence,
decide it and record it in `DECISIONS.md` instead.

---

## Ready for operator (fill as you go)

| # | What | Options | Recommendation | Why it needs the operator |
|---|---|---|---|---|
| | | | | |

---

## Pre-seeded: carried open questions

These are already recorded in the program `DECISIONS.md` §Open questions. They do
**not** block Phase 3 — they are listed so the agent recognises them rather than
re-escalating or trying to decide them.

| # | What | Status for this phase |
|---|---|---|
| N1 | **Real descriptor signing key.** No ed25519 material exists in any repo. Registering a real public key into an operator-managed definition is an infrastructure mutation | **Does not block.** Step 13 completes with a locally generated, gitignored **dev** keypair and a descriptor marked dev-signed. Real-key registration + the pushes are one post-phase operator step (CF-9) |
| N2 | **Does the MCP route need operator approval?** | Working reading: adding a route to the backend's existing listener on the existing private path is **not** infrastructure mutation. A separate port or a new firewall/ingress rule **would** be. Proceed on the existing listener; escalate if the topology must change |
| N3 | **Is third-party MCP interop a near-term requirement for the trading backend specifically**, or only for future assistant connectors? | **Does not block.** Affects how much conformance headroom to build, not D13/D15/D17. Build to the spec; do not build speculative headroom |
| N4 | **Does legal/payment-provider review attach weight to using an industry-standard protocol?** | **Does not block, and ADR 016 explicitly does not claim it does.** If review says it matters, that strengthens D13's rationale but changes no engineering decision |
| N5 | **Legal/product dispositions** for the `exports-traderton` route, `trading-profile-reconciliation-saga`, `traderton-operator-defaults` (Step 9 Crit 6 Q1) | **Out of scope** (deferred with Steps 14–15). Do not touch them; they keep working. Carried as CF-11 |

---

## What is NOT an escalation

- **A hard stop.** A push, an infrastructure mutation, or MCP spike gate 1
  failing. Those stop the task (🚫) and are reported, not batched. Gate 1 failing
  specifically means **re-open ADR 016**.
- **A LOW-severity code-review finding.** Park it in `TASKS.md` §Outstanding
  Issues.
- **A contested engineering judgment call.** That routes to a fresh Contemplator
  per `ENTRYPOINT.md §5.1`, and the ruling goes in `DECISIONS.md`.
- **A pre-existing failure** captured at baseline. Recorded as CF-12, not
  escalated and not fixed.
