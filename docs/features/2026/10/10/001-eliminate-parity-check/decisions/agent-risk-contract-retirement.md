# `resolveAgentRiskContractForResponse` — current behavior, risk, and verification plan

Written before touching this code, per the project's "investigate before fixing" rule
and an explicit request to document expected-vs-failing behavior with tests in place
first. This is not a decision brief — it is the factual record `B-parity-ownership.md`
item "`domain-agent-risk-contract`" points to before that item is executed.

## What the function actually does today

`apps/api/src/routes/agent-config-helpers.ts:621-648`:

```ts
export function resolveAgentRiskContractForResponse(
  profile: { capital?, riskOverrides?, riskPosture? },
  agentRiskDefaults: AgentRiskDefaultsConfig,
): ResolvedAgentRiskContract
```

It is called at exactly 4 sites, all in `apps/api/src/routes/agents.ts`, and **every
call passes `{}` as `profile`**:

| Call site | Route | Line |
|---|---|---|
| 1 | `POST /agents` (create) | `agents.ts:929` |
| 2 | `GET /agents/:id` (read) | `agents.ts:1061` |
| 3 | `PATCH /agents/:id` (update) | `agents.ts:1997` |
| 4 | the fork/duplicate-agent path | `agents.ts:2768` |

Because `profile` is always `{}`:
- `profile.riskPosture` is always `null` → every field of `creatorInput`
  (`maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`, `stopLossCooldownMs`,
  `maxDrawdownPct`) resolves to `null`.
- `profile.riskOverrides` is always `null` → passed to `resolveAgentRiskContract` as
  `{}`.
- `profile.capital` is always `undefined` → `hasCapital: false` always.

So today, `resolveAgentRiskContractForResponse` **only ever computes the
operator-default ceilings** (`agentRiskDefaults.*`) with no creator input and no
overrides. It cannot currently reflect a real agent's actual risk configuration — not
because of a bug in the function itself, but because every caller withholds the real
profile data. The function is correct for the inputs it's given; the inputs are wrong
for what the response is supposed to represent.

## Why this exists / what it contradicts

ADR 011 / decision C2.2 (`docs/features/2026/09/18/001-trading-extraction-completion/decisions/B2-duplicated-authority.md`,
ledger entry C2.1/C2.2 in `EXECUTION_LEDGER.md`) ratified: traderton is the sole
authority for risk-contract math; herobids does not enforce local copies, and the
local `validateAgentRiskBounds` + `agent-risk-limits*.ts` + their parity tests were
**already deleted** as part of that work (ledger: "`validation.risk_ceiling` → 400;
`agent-risk-limits*.ts` + parity/unit tests deleted").

`resolveAgentRiskContractForResponse` is what's left behind: a *display* helper that
survived that cleanup, now silently downgraded to defaults-only because nothing wires
the real trading-profile data into it. It is not re-implementing enforcement (good —
that part of C2.2 held), but it also doesn't do what its own doc comment says it does:
"Reads a typed remote trading profile, which is the sole enforcement source after
migration 0072." It does not read a remote trading profile. It reads `{}`, every time.

## What is expected to work right now

Given the above, describe the two states explicitly:

### If `resolveAgentRiskContractForResponse` is "working" (as currently written, called with `{}`)

- Every agent create/read/update/fork API response includes a `riskContract` field
  shaped like `ResolvedAgentRiskContract`.
- `riskContract` always shows operator-default ceilings (`agentRiskDefaults.*`) as the
  effective values.
- `riskContract` never shows a creator-configured override, regardless of what the
  agent's real trading profile (in traderton) actually contains.
- No code path uses this field for enforcement — grep confirms the only producers are
  the 4 `agents.ts` sites; nothing reads `riskContract` back out of the agent response
  to make a decision. (Verify this holds before changing anything — see test plan.)

### If it stops working / is removed outright with nothing replacing it

- The 4 routes above would need `riskContract` removed from their response shape, or
  callers get a build error (TypeScript) / runtime `undefined` field (if left loosely
  typed) — whichever happens depends on how the response type is declared downstream.
- Any **frontend** code that reads `riskContract` off the agent response would silently
  receive `undefined` for that field, or break at the type level if `apps/web` imports
  the same response type. This has **not yet been checked** — see open items below.
- No enforcement behavior changes either way, because enforcement is already
  traderton-side per C2.2. The risk here is purely a response-shape / display
  regression, not a trading-safety regression.

## What this is NOT currently doing (confirm before changing)

- It is not read by any `apps/web` component yet verified — needs the check listed
  below.
- It is not used by the worker or any trading-decision path — only the 4 API route
  handlers call it, and only for the HTTP response body.

## Open items to verify before implementing the fix

1. **Does any `apps/web` code read `riskContract` from the agent response, and if so,
   what does it render?** If something renders "effective risk ceilings" on screen
   today, that UI currently always shows operator defaults regardless of the agent's
   real configuration — which may itself be a live, unreported display bug, separate
   from the parity-check cleanup. Check before writing the fix, not after.
2. **Confirm no other backend code path constructs `profile` with real data and could
   be the "missing wire-up"** rather than this being dead-on-purpose. If the real fix
   is "pass the real profile through," not "delete the function," that changes the
   disposition from (3) boundary-read-replaces-local-math to "finish the wiring that
   was apparently intended."
3. **Confirm `ResolvedAgentRiskContract`'s shape** (ADR 011 recommended a boundary read
   via `get_operator_defaults` / `get_risk_limits`) — i.e. what the replacement
   boundary call should return, so the response shape doesn't change for consumers
   even if the data source does.

## Required tests before making any change (write these first; some should fail today to prove the current gap)

Write these in `apps/api/src/routes/agent-config-helpers.test.ts` (or the existing test
file for this module) and `agents.test.ts`:

1. **Characterization test (should pass today):** "resolveAgentRiskContractForResponse
   with an empty profile returns only operator-default ceilings and no creator input" —
   locks in current behavior so the refactor has a known starting point.
2. **Gap-revealing test (expected to fail today, or pass trivially in a way that proves
   the gap):** "POST /agents with a riskPosture in the request body returns a
   riskContract reflecting that riskPosture" — this should currently fail, or only pass
   by coincidence, because the 4 call sites never forward real profile data. Write it
   and run it before changing code, to get written proof of the current gap (per the
   request: "even failing tests if need").
3. **Regression guard:** "GET /agents/:id response riskContract matches whatever the
   boundary / profile source reports for that agent's real configuration" — this is the
   target behavior for whatever disposition is chosen (boundary read, or wiring the
   real profile through). It should fail until the fix lands, then pass.
4. **No-enforcement guard:** "a riskContract value in an API response does not affect
   whether a decision is accepted or rejected" — i.e. assert that no code path uses
   this field for anything other than display. This should pass both before and after
   the change; if it doesn't pass before the change, that's a separate, more serious
   finding (enforcement coupled to a display helper) and must be resolved before
   proceeding with the parity cleanup at all.
5. **Frontend consumption check (if open item 1 finds a consumer):** a web test
   asserting what the UI shows for `riskContract` today, so a before/after comparison
   is possible once the data source changes.

## Recommended disposition (unchanged from B-parity-ownership.md, now with the test gate attached)

(3) boundary read — same mechanism as `agent-risk-defaults`. Source `riskContract`
from the boundary (`get_operator_defaults` / `get_risk_limits` per ADR 011) using the
agent's **real** trading-profile data, not `{}`. Sequence together with the
`agent-risk-defaults` manifest-entry work in Brief B, since both remove the same
local-defaults dependency and both read from the same boundary calls.

**Do not implement this until:**
- Open items 1-3 above are checked, and
- Tests 1-4 are written and their current pass/fail state is recorded (not just
  "written," but actually run once before any production code changes, so the record
  shows what was true before this cleanup).
