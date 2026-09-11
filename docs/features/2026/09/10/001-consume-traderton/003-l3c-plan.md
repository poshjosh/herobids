# L3c Plan — rewire the SIDE-EFFECTING path to the Traderton REST boundary

**Status:** plan-of-record for L3c (authored 2026-09-08 after the cross-boundary decisions were settled;
see `000-l3-consumption-spec.md` §8 + `traderton/docs/CANONICAL-STATE.md` §3.1/§3.2 for the authority).
**Branch:** `consume-traderton` ONLY. **Do NOT edit the sibling `traderton` repo** (read-only from here).
**Depends on:** L3a (REST client + signer, DONE), L3b (read path, DONE).

## What L3c is

Rewire the side-effecting tools to call the Traderton boundary over REST instead of driving the in-process
engine/actor: `submit_decision`, `create_bot`, `start_bot`, `stop_bot`, `adjust_bot_config` — in **both**
call sites (the agent message-broker AND `apps/api/src/routes/bots.ts`). Inject **`ownerId` + `actor` only**.
Keep the platform pre-boundary work (connection-grant authz, human approvals). **This slice does NOT delete
packages** (that is L3d); it stops the side-effecting tools from driving trading in-process and points them
at the boundary, with the direct path removed for these tools (or fallback-gated consistently with L3b — see
"Fallback posture" below).

## The locked decisions L3c must honour (do not re-litigate — authority: CANONICAL-STATE §3.1/§3.2)

- **D2 / #1 — inject `ownerId`+`actor` ONLY.** The 005 envelope has no `venueAccountId` field; Traderton
  resolves the venue account itself. Do NOT resolve/stamp `venueAccountId` or `venue`/`venueType` for the
  boundary call. (herobids may still resolve the connection grant for its OWN authz — see below — but it is
  not injected.)
- **D3 — `submit_decision` = invoke → poll.** Map the current 30s `blpop` reply onto the L3a client's
  `invoke` + `poll(requestId, {deadlineAt})`. **`pending_approval` is produced pre-boundary by herobids and
  NEVER calls the boundary**; only an already-approved (or no-approval-needed) decision is sent. The boundary
  returns `success`|`failure` only.
- **#4 — herobids owns NO bot state / NO maxBots.** `create_bot`/`start_bot` are **boundary-only**: NO
  `bots`-table write, NO `botLimitCheck`/maxBots enforcement, NO venue-stamping. Traderton owns bots + the
  limit. (The `bots` table + `agent-create-normalization` maxBots resolution are DELETED at L3d after the
  consumer audit below.)
- **P1 (provisioning) is NOT in L3c.** L3c unit-tests against a stubbed boundary. Real end-to-end needs
  Traderton's `venue_accounts` provisioned (L3-P1, a separate Traderton-side slice before L3e). Do not build
  provisioning here.
- **P2** is a Traderton-side fix (not herobids' concern).

## Rewire, file by file

1. **`apps/worker/src/agents/agent-decision-handler.ts` `handleDecisionSubmit`** — replace the
   `submitDecisionForExecution` (`@herobids/engine`) call with `tradertonClient.invoke({ toolName:
   'submit_decision', payload, subject: { ownerId, actor } })`, then `poll` to the deadline if not terminal
   (D3). **Keep the approval gate exactly where it is, BEFORE the boundary call**: if `approval_required`,
   produce `pending_approval` and return — do not invoke. Map the boundary `success`/`failure` back onto the
   tool's reply shape (reuse the L3b mapper pattern; preserve `code`+`retryable`). The reply still reaches
   the `submit_decision` tool via the existing `blpop` reply key — i.e. the broker writes the mapped result
   to `agent:decision:reply:${decisionId}` as today; only the *source* of the result changes (boundary, not
   the in-process engine).
2. **`apps/worker/src/agents/agent-message-broker.ts` `handleManageBot`** — for `create_and_start`/`start`/
   `stop`/`adjust_config`: replace the `botStart`/`enqueueLifecycle`→actor kickoff with
   `tradertonClient.invoke({ toolName: <create_bot|start_bot|stop_bot|adjust_bot_config>, payload,
   subject })`. **DELETE** the `botLimitCheck` (maxBots) call and any `bots`-table write; **DELETE** the
   venue-stamp (`getResolvedVenueAccount`/`venueTypeFromProvider`) — Traderton resolves the account (D2/#4).
   **Keep** the connection-grant ownership check (`isConnectionOwnedBy`) as herobids-side authz gating
   *whether the caller may act* — but it is not injected into the envelope.
3. **`apps/api/src/routes/bots.ts` `POST /bots`** — the second bot call site. Replace the
   `trading-instance-lifecycle` enqueue with a boundary `create_bot` invoke. **Drop `checkBotLimit`**
   (maxBots) — Traderton owns it. Keep the platform auth (`request.userId`→`ownerId`) + plan/entitlement
   checks that are NOT trading limits.
4. **`apps/worker/src/index.ts`** — inject the constructed `TradertonClient` (from L3a, via the read-adapter
   pattern extended to side-effecting) into the broker + decision handler. Do NOT yet delete the
   trading-package imports / WorkerRuntime construction (L3d) — but stop routing side-effecting tools
   through them.
5. **Subject construction** — reuse L3b's subject binding (`ownerId = userId`, `actor = {type:'agent', id}`);
   factor a shared helper if the read-adapter's isn't reusable.

## Fallback posture (decide + apply consistently)

L3b gated read tools on `ctx.tradertonBoundary` presence with a direct-DB fallback. For side-effecting
tools, decide up front and record it: **RECOMMEND no silent fallback** — once the boundary is configured,
side-effecting tools go to the boundary; if it is unconfigured/unreachable, return a typed
`precondition.not_ready`/`transport_error`, do NOT fall back to the in-process engine (which L3d is about to
delete anyway, and which would re-introduce the exact in-process trading path cutover removes). Confirm this
in review; it differs deliberately from L3b's read fallback (reads are safe to serve locally; side effects
are not).

## Investigation items to complete IN L3c (before/as you rewire)

- **`bots`-table consumer audit (for #4 / L3d):** enumerate every reader/writer of the herobids `bots`
  table (the API route, listings, any UI/query, `agent-create-normalization` maxBots) and confirm each is
  trading-path (deletable at L3d) or gets re-pointed at `list_bots`/`get_bot_status` over the boundary.
  Record the list so L3d's deletion is safe.
- **Approval gate `venueAccountId` read:** the approval snapshot currently reads the trading intake's
  `venueAccountId`. With the engine gone, confirm the approval snapshot needs no trading value the boundary
  won't return — source any needed id from the connection grant (kept), not the engine. (Was subtlety D-c.)
- **Both bot call sites covered:** verify no third path enqueues `trading-instance-lifecycle` — missing one
  leaves a live in-process trading path after cutover.

## Tests (against a STUBBED boundary — no real Traderton)

- `submit_decision`: approved/no-approval → boundary invoke → mapped reply; `approval_required` → produces
  `pending_approval` and the boundary is NOT called; boundary `failure` → mapped reply preserving
  `code`+`retryable`; poll path resolves a non-terminal invoke.
- `create_bot`/`start_bot`: boundary invoke with `ownerId`+`actor`; assert NO `bots` write, NO maxBots call,
  NO venue-stamp; boundary failure mapped.
- `stop_bot`/`adjust_bot_config`: boundary invoke; mapped result.
- API `POST /bots`: boundary invoke; no maxBots; platform auth preserved.
- No-fallback posture: boundary unconfigured/unreachable → typed failure, in-process engine NOT invoked.

## Done criteria

- All five side-effecting tools + both call sites route to the boundary; `ownerId`+`actor` only; no `bots`
  write / no maxBots / no venue-stamp; approval stays pre-boundary.
- herobids build + lint green; the full worker suite green (side-effecting tests re-pointed at the stub).
- The `bots`-consumer audit list recorded (feeds L3d).
- Do NOT commit — the coordinator commits on the branch. **Then PAUSE for human review before L3d.**
