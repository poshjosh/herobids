# Bug Report: tools that gate on a capability have no default grant, so every agent is denied (`make_http_request`, `read_document`)

- **Status:** OPEN. Draft for review. No code has been changed; this document describes the fix, it does not apply it.
- **Severity:** High. Two tools that the built-in `web-access` skill promises to agents cannot be used by any agent. It blocks the validation work the `job-search` skill requires (checking whether a posting is still open through a job board or employer API).
- **Date:** 2026-11-17
- **Environment:** observed on staging (agent `job-searcher`, `8365d836-7e09-470c-bbf0-06f69f3848b7`). The cause is in shared worker code, so production is affected the same way (it is pinned to the same agent image, see `docs/bug-reports/2026/11/17/001-staging-agents-run-stale-pinned-agent-image.md`). This was not verified on production.
- **Related:**
  - `docs/features/pending/001-capability-gating-enforcement/001-plan.md`, section "Two gated tools reference missing grants" and task 1.2. That plan names this defect. It is still pending and the grants are still missing.
  - `docs/features/pending/001-plan-tiered-capability-limits/001-plan.md` (config-driven limits; out of scope here, see "Out of scope").
  - `docs/tech/agents/tool-access-and-sandboxing.md` (lists `make_http_request` as an available tool).

## Symptom

During a 24-hour run on staging, the `job-searcher` agent called `make_http_request` 5 times. All 5 returned an error:

```
Unknown capability: make_http_request.
```

The 5 calls were deliberate and sensible: a Workable job-list POST, a Lever posting HEAD, an Arbeitnow listing HEAD, and two Google requests. The agent then fell back to `browse_url`, which cannot read JSON and returns only a status number on failure (23 of its 86 `browse_url` calls failed with 403, 404, 410 or 429).

The tool is visible to the agent (it is in the `web-access` skill's `requiredTools`), so the model keeps trying to use it, and every attempt fails.

## Investigation (read-only)

- **How the gate works.** A tool calls `ctx.capabilityEngine.checkAccess('<name>', ...)`. The engine looks the name up in its grants map and, if there is no entry, returns `{ reason: 'unknown_capability', message: 'Unknown capability: <name>.' }` (`apps/worker/src/agents/capability-policy.ts`, `checkAccess`, about line 272 to 280). It fails closed by design.
- **Where the grants come from.** `DEFAULT_CAPABILITY_GRANTS` (same file, line 108 onward) is merged with the agent's `toolPolicy` by `buildCapabilityGrants`. The agent process always builds an engine (`apps/worker/src/agent.ts` line 581, passed to every tool context at about line 2054), so the gate is always active in a real agent. It is skipped only when a tool is run without an engine, which is what unit tests do.
- **Scan of every gated tool against the grants table** (static scan of `checkAccess('<literal>'` calls in `apps/worker/src`, compared with the `capability:` names in `DEFAULT_CAPABILITY_GRANTS`):

  | Gated tool | Has a default grant |
  |---|---|
  | `browse_interactive` | yes |
  | `browse_url` | yes |
  | `execute_code` | yes |
  | `execute_shell` | yes |
  | `search_web` | yes |
  | `make_http_request` | **no** |
  | `read_document` | **no** |

  Limit of the scan: it matches literal names only. A tool that passes a variable to `checkAccess` would not show up.
- **Which skills include the tools.** Only the built-in `web-access` skill lists them (`packages/domain/src/skills.ts`, `WEB_ACCESS_SKILL`, `requiredTools: ['search_web', 'browse_url', 'read_document', 'make_http_request', 'send_message', 'publish_artifact']`). External skills such as `job-search` do not declare tools. So every agent that has `web-access` sees both tools, and none can call them.
- **History.**
  - The engine has denied unknown capabilities since it was introduced (`8c199782`, 2026-06-03).
  - `read_document` was added with a `checkAccess('read_document')` gate on 2026-06-11 (`4e2731ec`) and never got a grant row.
  - `make_http_request` was renamed from `http_request` on 2026-08-31 (`3439d99f`); its gate is also without a grant.
- **Observed vs inferred.** `make_http_request` was observed failing on staging. `read_document` is inferred from the code and the scan; no agent called it during the observed window.

## Root Cause

Two lists have to agree by name and nothing checks that they do: the names tools pass to `checkAccess`, and the capability names in `DEFAULT_CAPABILITY_GRANTS`. Two tools were added to the first list and not to the second. Because the engine fails closed, the result is a permanent denial that reads like a policy decision ("Unknown capability") instead of like a bug.

## Why it was not caught

- Tool unit tests use a fake engine. `apps/worker/src/tools/http-client.test.ts` builds its own `makeCapabilityEngine(...)`, so the real grants table is never consulted.
- `apps/worker/src/agents/capability-policy.test.ts` tests the engine with names the test author chooses (`execute_code`, `manage_agent_skills`). It does not iterate over the tools that exist.
- The tool registry has a drift guard for tool names (`assertToolCatalogMatchesRegistry`) but it has no concept of capabilities.
- The pending capability-gating plan found the gap on paper but has not been implemented.

## Proposed Fix (for review)

### A. Add default grants, and set the per-minute limit to 30 on four tools

All edits are in `DEFAULT_CAPABILITY_GRANTS` in `apps/worker/src/agents/capability-policy.ts`. The limit values below are the owner's decision (2026-11-17), not the author's.

**New rows** (the two gated tools that have none):

| Capability | tier | enabled | maxPerMinute | maxConcurrent |
|---|---|---|---|---|
| `make_http_request` | `direct` | true | 30 | 3 |
| `read_document` | `direct` | true | 30 | 3 |

**Existing rows: change `maxPerMinute` only** (every other field stays as it is):

| Capability | maxPerMinute now | maxPerMinute after |
|---|---|---|
| `search_web` | 10 | 30 |
| `browse_url` | 10 | 30 |

Notes for the reviewer:

- **`tier: 'direct'` is a fact, not a preference.** `CapabilityGrant` requires a tier. Both new tools run inside the agent container and make their own HTTP requests, which is what `direct` means in this file (the same as `browse_url`, `search_web`, `execute_code`). `brokered` is for calls that go through the platform broker.
- **`timeoutMs` and `maxResponseBytes` are not set on the new rows**, because no value was specified. Effect: `make_http_request` uses the caller's own `timeoutMs` (1000 to 30000, default 15000) and `tools.httpClient.maxResponseBytes` (51200); `read_document` uses `tools.webAccess.browseUrl.timeoutMs` and `maxResponseBytes` (config). A value set on a grant beats config in these tools (`grant?.limits?.maxResponseBytes ?? config...`), so setting one would silently disable the config limit. A per-agent `toolPolicy` can still set one. The existing `browse_url` row has `timeoutMs: 20_000`, so the new rows differ from it in having no grant timeout; add one if a ceiling is wanted.
- **`maxConcurrent` for the existing rows is unchanged** (`search_web` 3, `browse_url` 3).
- **Agents that already have an explicit per-agent override keep it.** `buildCapabilityGrants` merges the agent's `toolPolicy` over the defaults, so only agents using the defaults get the new 30.
- **No test in the repo pins the old 10 for these tools.** A search of `*.test.ts` for `maxPerMinute` found tests using their own values, and only `capability-sandbox.test.ts` line 144 mentions the 10 of `submit_decision`, which is not changed.
- The grants only open the capability gate. The tools keep their own protections: HTTPS and private-address checks (`isHostPrivate`), the deny list (`tools.httpClient.denyList`), redirect re-validation, and the operator switch `tools.httpClient.enabled` (the tool returns "disabled by operator configuration" when it is false).

### B. Drift-guard test

Add a test to `apps/worker/src/agents/capability-policy.test.ts` (or a sibling file) with this behaviour:

1. Read the non-test `.ts` sources under `apps/worker/src` and extract every `checkAccess(` call.
2. Fail if any call does not use a string literal as its first argument (this keeps the scan honest: a variable name cannot hide from it).
3. For every literal capability name, assert there is an entry in `DEFAULT_CAPABILITY_GRANTS`, with `enabled: true`. The failure message names the tool and says "add a grant row".
4. Test name (behaviour, per `AGENTS.md`): `"every capability a tool gates on has an enabled default grant"`.

Why a source scan and not a runtime check: running each tool against the real engine needs a per-tool context and network stubs, which is much heavier. The scan has the same failure mode as the pattern already used for `DURABLE_TOOL_NAMES` (a test that fails when two lists drift). Its known limit is that it relies on literal names, which step 2 enforces.

Also add one test that every tool in a built-in skill's `requiredTools` that gates on a capability (found via the same scan) resolves to a grant. This states the product rule in the user's words: "agents can use tools that are included in their skills". If it duplicates step 3 in practice, keep only step 3.

### C. Documentation and bookkeeping

- Mark task 1.2 of `docs/features/pending/001-capability-gating-enforcement/001-plan.md` as done (it is the same change).
- `CHANGELOG.md` under Fixed: name both tools and say that `make_http_request` and `read_document` were denied for every agent.
- `docs/tech/agents/tool-access-and-sandboxing.md`: state that gated tools need a default grant, and where to add one.
- A short lesson in the capability section of the docs: gate name and grant name must agree; the test enforces it.

### D. Rollout (the fix ships in the agent image)

1. Merge. CI builds `sha-<commit>`.
2. `infra/hetzner/scripts/release-agent-image.sh --env staging` (probe, pin, worker recreate), then relaunch the agents that need it (`--relaunch`).
3. Verify on staging (below), then release to production with the same command.
4. Agents running the old image stay denied until relaunched. Per-agent workaround until then: a `toolPolicy` entry granting `make_http_request` (PATCH only while the agent is stopped or crashed).

## Verification Plan

- Unit: the new drift-guard test passes, and fails when a grant row is removed (check by temporarily removing a row in a scratch run).
- Unit: `capability-policy.test.ts` asserts `checkAccess('make_http_request', ...)` and `checkAccess('read_document', ...)` return `undefined` with the default grants, that the default `maxPerMinute` is 30 for `search_web`, `browse_url`, `make_http_request` and `read_document`, that the new rows have `maxConcurrent` 3, and that the 31st call within a minute returns the rate-limit denial (`recordStart` between calls).
- Integration on staging after release: ask an agent with `web-access` to run a `HEAD` request to a public HTTPS URL and a `GET` to a public JSON endpoint. Expected: a result with `status`, and an `agent.tool.result` row with `status: ok`, not `Unknown capability`.
- Negative on staging: set `tools.httpClient.enabled: false` (or a per-agent grant with `enabled: false`) and confirm the tool is refused with the expected message, so the operator switch still works.
- `pnpm lint`, `pnpm test`, `pnpm build`.

## Risks

- **Wider egress for every `web-access` agent.** `make_http_request` supports POST with a body to any public HTTPS host. Job listings and web pages are untrusted text, so prompt injection could try to make an agent send data out. Existing mitigations: private-address and deny-list checks, redirect re-checks, the operator kill switch, per-agent `toolPolicy` override to disable it. `browse_url` already allows GET to any public host, so the new exposure is mainly the request body and custom headers. The reviewer should decide whether granting it to all `web-access` agents by default is acceptable. The user's stated rule is that tools included in a skill must work, which argues for yes.
- **Three times the call rate for `search_web` and `browse_url`.** `search_web` is a paid Tavily call each time, so the worst-case spend per agent session rises with the limit (the real rate is whatever the agent actually does; today staging made 44 calls in 24 hours). `browse_url` fetches other people's websites, and the skill's polite-access rule is per domain, not per tool, so a higher per-tool limit does not protect any single site. Both are the owner's decision; the risk is recorded here so it is a conscious one.
- **Other behaviour is unchanged.** Agents that never call these tools see no difference, and previously denied calls now run.

## Out of scope

- Wiring the other ungated tools into the gate (pending plan items 1.1 and others).
- Enforcing `timeoutMs` centrally, and config-driven or tiered limits (the pending tiered-limits plan). The four 30s are still literals in `DEFAULT_CAPABILITY_GRANTS`, like the 10s they replace.
- Changing any other limit of any other capability.
- Raising `tools.httpClient.maxResponseBytes` (51200). It is a separate decision and can be set per agent with a `toolPolicy` `maxResponseBytes`.
- Any change to `browse_url`'s content types.

## Open questions for the owner

Decided by the owner (2026-11-17): a default grant for every `web-access` agent is acceptable ("tools included in a skill must work"), `maxPerMinute` 30 on the four tools, `maxConcurrent` 3 on the two new rows.

None open. The one remaining detail is whether the new rows should also carry a `timeoutMs` (see the notes in section A); the draft leaves it unset.

## Acceptance Criteria

- `checkAccess('make_http_request', ...)` and `checkAccess('read_document', ...)` are allowed under default grants.
- Default `maxPerMinute` is 30 for `search_web`, `browse_url`, `make_http_request` and `read_document`; default `maxConcurrent` is 3 for the two new rows; no other field of any existing grant changes.
- A test fails if any literal capability name passed to `checkAccess` has no enabled default grant, and fails if `checkAccess` is called with a non-literal.
- No `maxResponseBytes` on either new row (config limits still apply). Both tools still obey the SSRF checks and the operator switch.
- A staging agent can complete a real `make_http_request` call after the image release.

## Implementation Task List

- Task 1 (Section A): add default grants for `make_http_request` and `read_document`, and set `maxPerMinute` 30 on `search_web` and `browse_url` - DONE
- Task 2 (Section B): add the drift-guard test and the capability-policy default-grant tests - PENDING
- Task 3 (Section C): documentation and bookkeeping (plan task 1.2, CHANGELOG, tool-access doc, lesson) - PENDING

Section D (rollout) and staging verification are operational and not part of this implementation.

## Outstanding Issues

- Task 1: (low) `read_document` row comment wording could mirror the `make_http_request` one; confirm config default of `tools.httpClient.maxResponseBytes` is 51200 (code fallback is 256 KiB, pre-existing).
