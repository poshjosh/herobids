# TWO PROBLEMS WORTH DECIDING ON

**1. “Funded-wallet baseline”**
You can think of a swap wallet like a bank account that already has money in it before the app starts managing it.

For swap venues like Jupiter or 1inch, the system is trying to answer:

- “What balances do we expect this wallet to have?”
- “What balances does the chain actually show right now?”

That comparison is called reconciliation.

The problem is that the current swap tracker mostly builds its expectation from fills, meaning “we swapped $X of token A into token B, so expected balances should move by these deltas.” That works only if the system starts from a known starting point.

Example:

- Wallet already has `10 SOL` before HeroBids ever starts.
- HeroBids then executes one swap: spend `1 SOL`, receive `150 USDC`.
- Fill-based tracking alone says:
  - expected SOL change = `-1`
  - expected USDC change = `+150`

But expected relative to what?

If the system silently assumes the starting point was zero, it will “expect”:

- SOL = `-1`
- USDC = `150`

Actual wallet might be:

- SOL = `9`
- USDC = `150`

So reconciliation screams “drift” even though nothing is wrong. The wallet was simply pre-funded.

That is why I said it needs a real design choice, not just a patch.

The system needs a baseline, meaning a remembered starting balance.

A simple mental model is:

`expected current balance = baseline balance + sum of all tracked swap deltas`

So if baseline was:

- SOL = `10`
- USDC = `0`

and then one swap happened:

- SOL delta = `-1`
- USDC delta = `+150`

then expected becomes:

- SOL = `9`
- USDC = `150`

which now matches reality.

Why this needs design:
- Do we capture the baseline the first time an actor starts?
- Do we persist that baseline in DB so restarts keep using the same one?
- If someone manually deposits funds later, should that be treated as suspicious drift, or should the operator be able to “accept current balances as new baseline”?
- If the actor is rebound to a different wallet, the old baseline must not carry over.

For a non-trading analogy, this is just bookkeeping:
- baseline = opening account balance
- fills = transactions
- reconciliation = bank statement check

Without an opening balance, the ledger is incomplete.

The safest likely v1 design is:
1. Persist a baseline balance snapshot per venue account and asset.
2. On first controlled startup, capture on-chain balances as that baseline.
3. Rebuild expected holdings on restart as:
   - persisted baseline
   - plus historical fills for that same venue account
4. If an operator intentionally wants to “adopt” externally changed balances, provide a manual reset/rebaseline action.

That is what I meant by “persisted startup/baseline holdings model.”

**2. “Explicit `circuit_breaker_open` / `stop_loss_active` instead of `instance_not_running`”**
This one is much less about trading and more about error messaging.

Right now, in the agent path, the actor sometimes refuses a decision on purpose:

- circuit breaker open:
  - “too many recent execution failures, stop trading for safety”
- stop loss active:
  - “this position is losing too much, force flat / do not re-enter yet”

But the plumbing currently turns some of those situations into a generic response that effectively means:

- “instance not running”

That message is misleading.

It is like a car saying “engine missing” when the real issue is:
- “engine overheated, safety shutdown”
or
- “traction control prevented acceleration”

Why this matters:
- To the user, “not running” sounds like a bug or outage.
- To the agent, it looks retryable in the wrong way.
- To operators, observability gets worse because they cannot tell:
  - system broken
  - safety rule triggered
  - actor paused intentionally

So the fix would be to return explicit statuses such as:

- `circuit_breaker_open`
- `stop_loss_active`
- maybe `risk_cooldown_active`

Then the decision handler can emit the right event and message:
- “Trading paused after 3 consecutive venue errors”
- “Position is in stop-loss cooldown for this instrument”

That improves:
- debugging
- user trust
- agent behavior
- alerting

In plain English:
- `instance_not_running` = “the worker is unavailable”
- `circuit_breaker_open` = “the worker is available, but safety lock is engaged”
- `stop_loss_active` = “the worker is available, but this instrument is temporarily blocked for safety”

Those are very different situations.