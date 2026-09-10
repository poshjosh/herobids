# L3b Implementer Prompt — rewire the READ path to the Traderton REST client

**Status:** ready to hand to an implementer. On branch `consume-traderton` (herobids).
**Task:** rewire the **read-only** agent tools to call the Traderton boundary over REST (via the
L3a client) instead of reading the trading Postgres directly. **NO deletion** of trading packages
yet (that is L3d). **NO write/side-effecting tool rewire** (that is L3c). This slice ADDS a boundary
client + subject to the tool context and REPOINTS five read tools.
**Reads:** the L3 spec `000-l3-consumption-spec.md` (this dir) §2/§3/§7; the L3a client at
`apps/worker/src/traderton/{client,sign,contract}.ts`; the Traderton dispatcher
`traderton/packages/boundary/src/dispatcher.ts` (how a tool's `ToolResult` maps to
`TradertonToolResultV1`); the 005 contract `traderton/docs/005-consumer-boundary-contract.md`.

---

## 0. Orient first

You are in **herobids** on branch `consume-traderton` (the only branch where herobids may be edited).
`main` and all other branches are untouchable. Do NOT touch `apps/worker/src/watch-summary.js`.

**The boundary dispatches to the SAME tool objects herobids copied to Traderton.** On the Traderton
side, `get_account_summary` / `get_analytics` / `list_positions` / `list_bots` / `get_bot_status` are
the identical tool implementations with the identical Zod payload schemas, and the dispatcher maps
their `ToolResult` → `TradertonToolResultV1`: on success, `outcome.payload` **IS** the tool's
`ToolResult.data`; on failure the tool's `error`/`errorCode`/`fault`/`retryable` map onto the closed
failure-code union (see `dispatcher.ts` `mapToolResult`). So a rewired read tool sends the same
payload it already validates and receives back the same `data` object it used to build locally.

**Invariant (Agent Mode Purity / ports-carry-values):** the rewired tool injects platform-owned
VALUES (`ownerId`, `actor`) + forwards the validated payload; it authors NO trading behaviour and no
risk/planner logic. It is transport substitution only.

## 1. Scope — the seam that L3b DOES and DOES NOT touch

**Rewire to REST (READ tools, `apps/worker/src/tools/{account,analytics,bots}.ts`):**
- `get_account_summary` (`account.ts`)
- `get_analytics`, `list_positions` (`analytics.ts`)
- `list_bots`, `get_bot_status` (`bots.ts`)

These currently read `ctx.botRepo` / `ctx.riskContractOps` / `ctx.executionConfig` / `ctx.agentRepo`
directly. After L3b they call the boundary via a new `ctx.tradertonClient`.

**DO NOT rewire (out of L3b scope):**
- Write/side-effecting bot tools `create_bot` / `start_bot` / `stop_bot` / `adjust_bot_config` — L3c.
- `submit_decision` — L3c.
- `get_risk_limits` / `adjust_risk_limits` (`risk-limits.ts`), `resolve_bot` (`resolvers.ts`),
  `change_strategy_preset`, `watch.ts` position lookups, `skills.ts` — NOT in the L3b read set;
  leave them untouched.

## 2. CRITICAL scoping correction — do NOT drop the shared trading fields yet

The L3 spec §7 L3b line says "drop the trading fields they used from `ToolContext`." **That is not
fully achievable in L3b and MUST be deferred.** Verified: `ctx.botRepo` is still consumed by the
write tools (`stop_bot`/`start_bot`/`adjust_bot_config`, L3c), `resolve_bot`, `watch.ts`, and
`risk-limits.ts`; `ctx.riskContractOps` by `risk-limits.ts`; `ctx.agentRepo` by `risk-limits.ts`;
`ctx.executionConfig` by nothing else once `get_account_summary` moves, but the others are shared.
Removing any shared field from `TradingToolContext` now would break in-process tools that L3b does
not rewire.

**Therefore:** L3b ADDS `tradertonClient` (+ the injected subject) to the context and stops the five
read tools from *using* the trading repos — but it does NOT remove any field from
`TradingToolContext`/`ToolContext`. Field removal happens in L3c/L3d as each remaining consumer is
rewired or deleted. Record this as a surfaced deviation from the spec's literal wording (it is a
sequencing correction, not a scope change). If, after rewiring, a field ends up used by ZERO
remaining tools, you MAY note it as "safe to drop in L3c" but leave it in place for this slice.

## 3. What L3b delivers

### 3a. The context seam — a boundary port on `TradingToolContext`
Add to `packages/domain/src/trading/tool-contract.ts` `TradingToolContext` a new OPTIONAL field that
is a small structural port (the domain package must NOT import `@herobids/worker`), e.g.:
```ts
/** The Traderton REST boundary port (L3b). When present, read tools call the
 *  boundary instead of the trading DB. A structural subset the worker's
 *  TradertonClient satisfies. */
tradertonBoundary?: {
  invoke(input: {
    toolName: string;
    payload: unknown;
  }): Promise<TradertonReadResult>;
};
```
Define `TradertonReadResult` as a small discriminated union in the domain package (mirroring the L3a
client's result but domain-clean): `{ kind: 'success'; data: unknown } | { kind: 'failure'; code:
string; message: string; retryable: boolean } | { kind: 'in_progress' } | { kind: 'transport_error';
message: string; retryable: true }`. Keep it strict (no `any`).

Rationale for a **port on the context** rather than passing the raw L3a `TradertonClient`: the domain
package cannot depend on worker types, and the read tools are typed `TradingToolContext`. The worker
composition root adapts its `TradertonClient` (which carries baseUrl/secret/consumerId/keyId + the
injected subject) to this narrow port and injects it. The tool only names a tool + payload; the
subject/caller/deadline are bound by the worker adapter (the tool never sees signing material).

### 3b. The worker adapter + injection (composition root)
In `apps/worker/src/agent.ts` where `toolContext: ToolContext` is assembled (~line 1789):
- Construct a `TradertonClient` from `appConfig.boundary` (the L3a config) — pass it in through the
  agent bootstrap the same way other config-derived services arrive. If `appConfig` is not already
  in scope at this assembly site, thread the already-loaded boundary config/services through the
  existing agent-bootstrap parameter object (do not re-load config here).
- Build the injected subject VALUES: `ownerId` = the platform user (`agentConfig.userId`; if empty,
  see §5 error handling), `actor` = `{ type: 'agent', id: AGENT_ID }`.
- Wire `tradertonBoundary` on the context: an adapter that calls
  `client.invoke({ toolName, payload, subject, deadlineMs: appConfig.boundary.requestTimeoutMs })`,
  then maps the L3a `TradertonClientResult` → the domain `TradertonReadResult` (success.payload →
  `{ kind:'success', data }`; failure → carry `code`/`message`/`retryable`; in_progress/transport as
  is). The deadline for a read is a single invoke within `requestTimeoutMs` — reads are synchronous
  and do NOT poll (polling is the L3c side-effecting concern).
- Gate on config: if `appConfig.boundary.baseUrl`/`hmacSecret` are unset (L3a left them lenient),
  the adapter should be absent (leave `tradertonBoundary` undefined) so the read tools fall back to
  the existing behaviour. This keeps existing/local setups working until the boundary is deployed.
  **This fallback is an L3b transitional affordance; L3c/L3d tighten it.** Document it.

### 3c. Rewire the five read tools
For each read tool, when `ctx.tradertonBoundary` is present, call the boundary and map the result;
otherwise keep the current direct-DB path (transitional dual-path — see §3b gate). Concretely:
- `get_analytics`: `invoke('get_analytics', { days })` → on success return `{ success: true, data:
  result.data }`; on failure return `{ success: false, error: message, errorCode: code, retryable,
  fault: <retryable ? true : false semantics per existing convention> }`. Preserve the existing
  success `data` shape (the boundary returns the same object the tool used to build).
- `list_positions`: `invoke('list_positions', {})`.
- `get_account_summary`: `invoke('get_account_summary', {})`.
- `list_bots`: `invoke('list_bots', { days })` (days optional).
- `get_bot_status`: `invoke('get_bot_status', { botId })`.

Map `TradertonReadResult`:
- `success` → `{ success: true, data }`.
- `failure` → `{ success: false, error: message, errorCode: code, retryable, fault: code !==
  'validation.invalid_payload' && code !== 'not_found.resource' }` (a validation/not-found outcome is
  content-level, `fault:false`; infra/internal is `fault:true`). Keep it simple and consistent; the
  existing tools already use `fault:false` for content-level failures.
- `in_progress` → treat as a transient failure (`{ success:false, retryable:true, fault:false, error:
  'boundary invocation still in progress', errorCode:'boundary.in_progress' }`) — a read should be
  synchronous, so this is unexpected but must not throw.
- `transport_error` → `{ success:false, retryable:true, fault:true, error: <generic>, errorCode:
  'boundary.transport_error' }`.

Do NOT change tool `name`, `category`, `parametersSchema`, `parameters`, or `promptGuidance`. Only
the `execute` body changes. Keep the direct-DB fallback branch intact for the gate in §3b.

## 4. Tests

- **Unit (per rewired tool, `apps/worker/src/tools/*.test.ts` — extend existing or add):** with a
  stubbed `tradertonBoundary` on the context, assert (a) success → the tool returns
  `{ success:true, data }` with the boundary's payload; (b) a typed failure → the tool maps
  `code`/`retryable`/`fault` correctly; (c) transport_error → retryable fault; (d) the tool forwards
  the correct `toolName` + payload (e.g. `get_bot_status` forwards `{ botId }`, `get_analytics`
  forwards `{ days }`). Do NOT hit a network.
- **Fallback path:** with `tradertonBoundary` ABSENT but `botRepo` present, the tool still returns
  the legacy direct-DB result (proves the transitional gate). If a tool test already exercises the
  DB path, keep it green.
- **Adapter mapping (worker):** a focused unit test that the worker adapter maps each
  `TradertonClientResult` variant → the right `TradertonReadResult` (can live beside the client or in
  a small `traderton/read-adapter.test.ts`).
- Do NOT stand up a real boundary (L3e). Fakes only.

## 5. Error handling / edge cases

- **Missing `ownerId`:** if the platform user id is empty, the adapter must NOT send an empty
  `subject.ownerId` (the boundary rejects it as `authorization.denied`). Prefer to leave
  `tradertonBoundary` absent (fall back) OR surface a clear `boundary.owner_unresolved` failure — do
  not silently send blank. Pick the fallback if a local/legacy agent legitimately has no userId.
- **No secret leakage:** the tool never sees the HMAC secret; only the worker adapter (holding the
  `TradertonClient`) does.
- **Never throw raw:** all boundary/transport errors become typed `ToolResult` failures.

## 6. Guardrails / done criteria

- **Read tools only.** No write/side-effect tool, no `submit_decision`, no deletion.
- **No field removed from `TradingToolContext`/`ToolContext`** (see §2). Fields stay; only the five
  read tools stop using the trading repos (behind the boundary gate).
- **Author no trading behaviour** — transport substitution + value injection only.
- **Domain stays worker-free** — the boundary port on `TradingToolContext` is a structural subset; no
  `@herobids/worker` import into `@herobids/domain`.
- **Transitional dual-path is intentional and documented** — boundary when configured, DB fallback
  otherwise. L3c/L3d remove the fallback + the fields.
- herobids **build + lint + the full worker/domain test suites stay green**; new tests pass. (Note:
  the pre-existing, unrelated `packages/domain/src/config/presets.test.ts` ENOENT failure is NOT
  caused by this slice — it is a fixture-path issue tracked separately.)
- **Do NOT touch `main` / other branches / `watch-summary.js`.**
- **Report:** files changed, the context port + adapter, the per-tool mapping, which fields are now
  unused by any in-process tool (candidates for L3c/L3d removal), and any seam surfaced. **Do NOT
  commit** — the coordinator commits.
- **Then PAUSE** — L3c (rewire the side-effecting path) is the next slice, gated on human review.
