# Open-position handling (internal reference)

**Status:** Internal/operator reference only. This content was removed from the
public-facing FAQ (`apps/web/src/features/public-pages/content/en/help/faqs.md`)
as part of the "no residue of trading" wording cleanup — see
`docs/product/trading-wording-audit.md` and
`docs/features/pending/trading-wording-cleanup/001-plan.md` for the general
direction. The mechanics described below are real and still implemented; they
are just no longer surfaced on the public help pages (trading/position/market
language is not something the public platform docs should expose, per that
direction). Nothing here describes a code change — this is a preservation copy
of removed user-facing copy, for support/operator/engineering reference.

## Open-position escalation policy

Previously documented under "What is the scout-judge model, and how does
escalation work?" → "When does escalation happen?" (FAQ #3).

In addition to the two triggers that remain public (first tick, judge-scheduled
reminder), a third trigger forces escalation from scout to judge:

- **Open positions** — Controlled by the agent's **open position escalation
  policy**, configurable in Advanced Settings when creating or editing an
  agent:
  - **Never** — The scout handles open positions on its own. Lowest cost, but
    the judge won't review positions unless triggered by another rule.
  - **On missing coverage** — Escalates only when a position lacks active
    protection (no stop-loss, no take-profit, no active watch). This is the
    default for Balanced agents.
  - **Always** — Every tick with open positions goes straight to the judge.
    Highest cost, but ensures the most capable model reviews every position
    every time.

The agent style sets the default policy: Careful → Never, Balanced → On
missing coverage, Bold → Always. The policy can be overridden manually at any
time.

## Billing hard cap and open positions

Previously documented under "What are billing limits, and what happens when I
hit them?" (FAQ #4) and, in fuller form, under its own section "Open positions
at the hard cap" in
`apps/web/src/features/public-pages/content/en/docs/agents/billing-limits.md`
(also removed as part of this cleanup).

This is the most important scenario to understand.

If the agent has open positions when the hard cap stops it, those positions
will no longer be monitored or managed by the agent. No stop-loss checks, no
take-profit evaluations, no regime reassessments.

A hard-cap stop with open positions should be treated as an event that needs
attention. The notification sent lists the open positions so the owner can
act. (The public docs now say the notification lists "pending work" rather
than naming open positions explicitly, but the underlying behavior —
unmanaged positions after a hard-cap stop — is unchanged and is recorded here
for support reference.)

The agent does not automatically close positions, submit orders, or change
its state at the hard cap. It simply stops reasoning.

## Scanner-gated (Filter mode) exit handling

Previously its own public FAQ: "How do agents with 'Filter' mode
(scanner-gated) manage or close open positions?" — removed entirely per the
cleanup request (not just reworded) since the answer is trading-mechanics
detail with no general-audience framing available.

Agents in Filter mode (`scanner_gated`) only receive decisions when the
scanner wakes them. This raises the question of how they handle exits if no
new-entry trigger is active.

**Answer:** the scanner evaluates every open position on every cycle, even
when there are no new entry opportunities. It fetches live candles for each
open position, checks indicators (RSI, price action, etc.), and flags any
position that looks like it should be closed.

Two ways exits are handled:

1. **Advisory mode** (default) — When the scanner detects a potential exit,
   it wakes the LLM with an "exit review" section showing P&L, current price,
   and RSI. The agent then decides whether to close (`go_flat`) or hold each
   position. Full control over exit decisions stays with the agent's
   reasoning.
2. **Autonomous mode** — When enabled, the scanner submits exit decisions
   directly without waking the LLM. Faster (no delay waiting for the next
   scan cycle) and cheaper (fewer LLM calls). Recommended for quick exits
   without manual agent involvement. Agent style (Careful, Balanced, Bold)
   affects exit behavior under this mode — see
   `docs/tech/agents/runtime-policy-and-reasoning.md`.

See `docs/tech/agents/wake-signal-and-technical-scan.md` for the underlying
wake/scan delivery mechanics this exit-handling logic depends on.

## Stop-losses and take-profits

Previously its own public FAQ: "What about stop-losses and take-profits?" —
removed entirely alongside the Filter-mode FAQ above (same reasoning: no
general-audience framing available for this level of trading-mechanics
detail).

These execute automatically regardless of mode (advisory or autonomous).
Per-trade stop-loss and take-profit levels, plus portfolio-wide drawdown
limits, are hard safety nets that fire immediately — they don't wait for the
next scanner cycle or an LLM decision. They protect open positions in real
time, independent of billing caps or agent reasoning state.

If the agent hits a hard billing cap, it stops reasoning but does **not**
automatically close positions — manual action or a cap adjustment is required
(same caveat as the billing section above).

## Agent style: open position escalation (table row meaning)

Previously documented under "What each field means" in
`apps/web/src/features/public-pages/content/en/docs/agents/agent-style.md`.
The **table row itself stays public** (it names a real, user-configurable
setting in Advanced Settings), but the explanation of what each of its three
values actually does was removed from the public page and is recorded here.

**Open position escalation** — When an agent has open positions, should the
scout automatically escalate to the judge (the more capable model) every
tick, or let the cheaper scout model handle routine checks?

- **Never** — the scout inspects every tick; the judge is never called for
  routine position checks.
- **On missing coverage** — escalates only when a position lacks active
  monitoring (e.g. no stop-loss or take-profit covering it), or when a
  trigger condition fires.
- **Always** — the judge reviews every tick.

This is the same mechanic as "Open-position escalation policy" above
(the FAQ framing and the agent-style framing describe the same underlying
behavior from two different public entry points, both now removed).

## Where this lives now

The public pages retain:
- `help/faqs.md` — the scout/judge model and the two public escalation
  triggers (first tick, judge-scheduled reminder); billing soft/hard cap
  behavior, with "pending actions" replacing explicit position language.
- `docs/agents/billing-limits.md` — the soft/hard cap mechanics and
  table, with "pending work" replacing explicit position language; the
  dedicated "Open positions at the hard cap" section was removed.
- `docs/agents/agent-style.md` — the "Open position escalation" table row
  stays (it's a real, user-configurable setting), but the prose explaining
  what each value does was removed from "What each field means."

None of the public pages above still document: the open-position escalation
policy tiers and their meaning, the hard-cap-leaves-positions-unmanaged
caveat, scanner-gated exit mechanics, or stop-loss/take-profit safety-net
behavior. Operators and support staff should reference this document for
those mechanics going forward.
