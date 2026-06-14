# Shared-Wallet Accounting Boundary

HeroBids is an agentic trading platform. It records what its actors decided, submitted, and confirmed. It does not claim full-wallet accounting truth for shared user wallets.

## Authoritative Records

These are authoritative:

- decisions persisted by HeroBids
- execution plans and order submissions persisted by HeroBids
- fills and chain-confirmed swap execution events persisted by HeroBids
- infrastructure and LLM usage records used for billing

If these records are missing or contradictory, that is a HeroBids correctness problem.

## Observational Records

These are observational telemetry in shared-wallet mode:

- venue balance snapshots
- token account balances
- recent wallet transactions fetched from the venue or chain
- any comparison between fill-derived asset movement and current wallet balances

These observations are useful for operator awareness, but they are not proof that HeroBids owns the full wallet ledger or can explain every balance change.

## Capital Semantics

`capitalUsd` is a risk-budget baseline. It is not a claim about wallet composition, total account equity, tax lots, or complete profit accounting across a shared wallet.

## Shared Wallet Rule

In shared-wallet mode, HeroBids must not present fill-derived asset projections as authoritative wallet holdings. External deposits, withdrawals, fee movements, manual trades, and unrelated activity in the same wallet can all change balances without implying a HeroBids execution or reconciliation defect.

## Dedicated Wallet Rule

Strict holdings reconciliation is only valid for a future dedicated or managed wallet mode where HeroBids has an explicit basis to treat the wallet as execution-scoped.

Until that mode exists, shared-wallet swap balance checks must be framed as observational variance, not authoritative reconciliation failure.

## Review Checklist For Swap/Reconciliation Changes

Before approving any swap or reconciliation change, confirm all of the following:

- Is the behavior being described event-authoritative or balance-observational?
- Does the change imply full wallet truth for a shared wallet?
- Is any strict holdings or balance assertion valid only for a dedicated or managed wallet mode?
- Does the change block trading, startup, or alerts based on a shared-wallet assumption?
- Do comments, tests, and event names match the same boundary instead of implying stronger accounting truth than the code actually has?