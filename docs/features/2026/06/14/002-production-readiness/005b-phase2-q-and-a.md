# Q and A

## Prompt

As much as possible, we don't want to know anything about a users actual wallet "balance".

we are first an agentic platform offering agents as as service. We give our agents expertise with skills. trading is our first core skill.

we went that way because of the legal hurdles to being a tradig platform.

We do not need to tell wether it is correct. we can work with relatives and not absolutes.

record what we see - especiall in this area.

if we keep accurate records of what happended, real book keeping can be derived from it - for audit or security etc but not for accounting in the strict sense

if the user makes profit, we don't care, we don't want to know

they are responsible for paying tax.

we bill them only server, llm and infrastructure costs - that is where our book keeping needs to be accurate, consistent etc and high standards with respect to accounting

what do you think?

## Response

Yes, that is a coherent product stance.

If your real goal is:

- accurate agent activity records
- accurate infra/LLM/server billing
- operational safety
- auditability of what the agent did

and not:

- portfolio accounting
- tax accounting
- proving full wallet ownership state
- proving user net worth / profit

then you do not need strict absolute wallet bookkeeping.

What that means in practice:

- treat wallet state as observational, not authoritative
- record events, not “truth”
- keep a high-quality log of:
  - decisions
  - quotes
  - submitted trades
  - confirmed fills
  - failures
  - observed balances when sampled
- use `capitalUsd` as the agent’s risk budget, not as a wallet accounting baseline
- do not try to infer full user holdings or profit
- do not do strict swap balance reconciliation against an assumed starting wallet state

So instead of asking:
- “Is this wallet balance correct?”

you ask:
- “Did the agent do what it said it did?”
- “Did the venue confirm it?”
- “Did we record it consistently?”
- “Did we stay within configured budget/risk?”
- “Can we reconstruct the sequence later?”

That is a valid architecture.

The main consequence is: you should explicitly drop features that pretend to know absolute wallet truth. For example:
- disable strict drift detection for shared wallets
- avoid alerts that imply “unauthorized withdrawal” unless you actually have a managed dedicated wallet
- frame balance snapshots as telemetry, not accounting truth

My recommendation:
1. Keep event-level bookkeeping very strong.
2. Keep infra billing/accounting strict.
3. Keep trading P&L and holdings as operational estimates, not legal/accounting truth.
4. Reserve strict reconciliation only for dedicated agent-managed wallets, if you later introduce them.

So: your direction makes sense, but only if the code and language stop pretending you are doing full wallet accounting when you are not.