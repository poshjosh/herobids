# Shared-Wallet Accounting Boundary

OpenAIdom is an AI agent platform. It records what its actors decided, submitted, and confirmed. It does not claim full-wallet accounting truth for shared user wallets.

## Authoritative Records

These are authoritative:

- decisions persisted by OpenAIdom
- execution plans and order submissions persisted by OpenAIdom
- fills and chain-confirmed swap execution events persisted by OpenAIdom
- infrastructure and LLM usage records used for billing

If these records are missing or contradictory, that is a OpenAIdom correctness problem.

## Observational Records

These are observational telemetry in shared-wallet mode:

- venue balance snapshots
- token account balances
- recent wallet transactions fetched from the venue or chain
- any comparison between fill-derived asset movement and current wallet balances

These observations are useful for operator awareness, but they are not proof that OpenAIdom owns the full wallet ledger or can explain every balance change.

## Capital Semantics

`capitalUsd` is a risk-budget baseline. It is not a claim about wallet composition, total account equity, tax lots, or complete profit accounting across a shared wallet.

## Shared Wallet Rule

In shared-wallet mode, OpenAIdom must not present fill-derived asset projections as authoritative wallet holdings. External deposits, withdrawals, fee movements, manual trades, and unrelated activity in the same wallet can all change balances without implying a OpenAIdom execution or reconciliation defect.

## Dedicated Wallet Rule

Strict holdings reconciliation is only valid for a future dedicated or managed wallet mode where OpenAIdom has an explicit basis to treat the wallet as execution-scoped.

Until that mode exists, shared-wallet swap balance checks must be framed as observational variance, not authoritative reconciliation failure.

## Review Checklist For Swap/Reconciliation Changes

Before approving any swap or reconciliation change, confirm all of the following:

- Is the behavior being described event-authoritative or balance-observational?
- Does the change imply full wallet truth for a shared wallet?
- Is any strict holdings or balance assertion valid only for a dedicated or managed wallet mode?
- Does the change block trading, startup, or alerts based on a shared-wallet assumption?
- Do comments, tests, and event names match the same boundary instead of implying stronger accounting truth than the code actually has?