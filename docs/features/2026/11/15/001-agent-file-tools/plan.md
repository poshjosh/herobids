# Agent file tools: files up to 10 MiB without loading them into the model context

Status: PLAN, not implemented. Written 2026-11-15. The 19 decisions below (1 to 16 from the
interview, 17 to 19 added at the owner's request) were confirmed by the owner. A review on
2026-11-15 added the fixes marked "Review fix" (see "Review fixes"). Facts about the code were read from the repo in this session and carry
file and line references. Anything not confirmed is marked "unverified" and is collected in
"Unverified items". Read "What this will and will not fix" before relying on it.

Owner review answers were recorded the same day (see "Review answers"). The `browse_url` design
was then simplified to an MVP with no infrastructure change (no tmpfs mount, no Nomad spike, no
automatic file deletion; see Design 9). The owner then added a message standard and a
documentation deliverable (decisions 17 to 19; Design 0a to 0c; WP7). No approval gate is open. `read_document` shares the
`browse_url` fetch cap (owner decision), and `maxToolResultChars` is documented only, with a UI
hint.

## Problem

Agents are over-limited when they work with files, and they pay to re-read the same data.

- `read_file` has one parameter (`path`). It reads the whole file and refuses anything over a
  hard-coded 1 MiB (`apps/worker/src/tools/filesystem.ts:12`, check at `:86`). Below that it
  returns the whole file, however large.
- `write_file` is the only way to put data in a file. One call has to carry the whole content, so
  it is bound by the model output limit (`LLM_MAX_TOKENS` 4096, `config/default.yaml:311`, read in
  `agent.ts:124`). There is no append, no edit and no search.
- `list_files` is unbounded (`filesystem.ts:140`).
- `browse_url` returns the whole cleaned page inline, up to 512 KiB
  (`apps/worker/src/tools/web-access.ts:301`).
- Old tool results are cut to 1,000 characters after more than 5 turns, and the model is not told
  how much was cut or how to get it back (`apps/worker/src/structured-tool-loop.ts:132`).

Live evidence (from the owner's session; I did not re-run it): agent `job-searcher`
(`7bc2e315-5943-4f95-b7d3-5c0b6c3c5a4a`, local qwen3.6:35b, 9 h) ran 37 ticks, about 7.2M
tokens, 191 LLM calls (about 37.6k tokens per call). It made about 160 `read_file` calls and read
`jobs.json` (about 10 KB) twice per tick on 18 of 36 ticks. The logs show `read_file` results of
10,119 and 11,478 characters being cut to 1,000 after 6 turns ("Truncated stale tool result").

## What this will and will not fix

State this plainly to avoid over-selling.

- It removes capability limits: files up to 10 MiB, paged reads, search, append, edit.
- It cuts re-reading cost, if the model uses the new tools. A search returns a few lines instead
  of a whole file. A paged read returns the part that is needed.
- It does not make the agent save results. `job-searcher` did not save results in 29 consecutive
  ticks. That is model and skill behaviour (the skill text lives in the separate `openaidom-skills`
  repo). Better tools do not change what the model decides to do.
- It adds prompt cost: four more tool schemas and a few more skill-instruction lines on every
  model call for agents with `file-management`. See Risks.
- Success is measured by the live checks in "Live verification", not by the unit tests.

## Goals

- Agents can open files up to 10 MiB (10,485,760 bytes) and work with them in pieces.
- A lean tool set: extend `read_file`, add `read_file_lines`, `search_files`, `append_file` and
  `edit_file`. Cap `list_files`. Add `recursive` to `delete_file`. Change `browse_url`. No other new
  tools.
- A per-call cap on what a read returns, so one call cannot flood the context.
- A soft, per-tier workspace disk quota.
- A truncation marker that says how much was cut and, where cheap, how to read it again.
- Every tunable value is operator config validated by Zod. No new literals.
- Every error and limit-hit result tells the agent what to do next, with the exact tool signature
  (Design 0a).
- The tools are documented to the repo conventions, and the conventions are written down
  (Design 0c, WP7).

## Non-goals

- No `download_file` tool (deferred; see Follow-ups).
- No change to the job-search skill (separate repo `openaidom-skills`; follow-up).
- No hard disk limit for `/workspace` (a later infrastructure change).
- No pinning of file reads against stale truncation. Stale truncation stays as it is.
- No change to `read_agent_document` (stays 100,000 characters per page), `execute_code`,
  `execute_shell` or `send_message`.
- No feature flag. The config values are the rollback (see Rollout).
- No Terraform, Nomad, Docker or other infrastructure change, and no change to shared
  infrastructure state. The web cache is a plain workspace folder (Design 9). The only
  container-level addition is one env var set by the existing launcher code
  (`AGENT_WORKSPACE_QUOTA_MB`, Design 8).
- No automatic deletion of files by any tool. Files are only deleted by the agent's own
  `delete_file` calls (owner rule, 2026-11-15).

## Rule fit

- Agent Mode Purity (`docs/tech/agents/runtime-boundary-and-message-contract.md`): read caps,
  file-size caps and the workspace quota are "Operational mechanics" (always applied). They say
  nothing about what the agent should do. Tool descriptions state limits as facts.
- Configuration (`docs/best-practices/configuration.md`): operator config in
  `config/default.yaml` and `AgentRuntimeConfigSchema`. Defaults live in the Zod schema only, not at
  call sites. Container-side values reach the agent through `AGENT_RUNTIME_CONFIG_JSON`, the same
  path as `tools.codeExecute` and `tools.webAccess`.
- Lessons #9 (context grows without bound): this plan is mostly about that. Per-call caps, paged
  reads and a clearer truncation marker.
- Lessons #7 (idempotent operations): `append_file` is not idempotent. See Risks.
- `AGENTS.md`: no `any`, no `@ts-ignore`, no swallowed errors, Zod at trust boundaries, tool names
  in lower snake case (`verb_noun`), `pnpm lint` must pass.
- `docs/best-practices/agent-runtime.md` "Cost Review Checklist": answered in Risks.

## Decision table

| # | Decision (owner-confirmed) | Where handled |
|---|---|---|
| 1 | Large files are worked with in pieces. Max file size the file tools open is 10 MiB (10,485,760 bytes), operator config, replacing the hard-coded 1 MiB. Larger files give a clear "file too large" error. | Config `tools.files.maxFileBytes`; Design 1 |
| 2 | Lean tool set: extend `read_file`; add `read_file_lines`, `search_files`, `append_file`, `edit_file`; cap `list_files`; change `browse_url`. `download_file` is out of scope. | Design 1 to 9; Follow-ups |
| 3 | `read_file` keeps `path` and adds `offset` and `limit` in characters. Returns content plus path, offset, returnedChars, totalChars, totalLines, nextOffset, truncated. No error for large files up to 10 MiB. | Design 1 |
| 4 | `read_file_lines`: `path`, `startLine` (first line), `limit` (line count), `maxChars` (character cap; default 50,000, max 500,000; the agent may change it). Plain text, no line-number prefixes. Returns startLine, endLine, totalLines, nextLine, truncated, lineCut. | Design 2 |
| 5 | Shared per-call return limit for `read_file`, `read_file_lines` and the inline page of `browse_url`: default 50,000, maximum 500,000. The agent changes it with `limit` (`read_file`, `browse_url`) or `maxChars` (`read_file_lines`). Two operator settings. `read_agent_document` unchanged. Large reads warned about in descriptions. No flag. | Config; Design 1, 2, 9 |
| 6 | `search_files`: literal by default, regex opt-in, results are pointers, scan limits in config, regex runs in a worker thread with a hard timeout, hitting a limit returns matches so far with `incomplete: true`. | Design 3 |
| 7 | `append_file`: `path`, `content`, `ensureNewline` (default true). Per-call cap about 16,000 characters (config). Subject to file size and quota. `sandbox` refused. | Design 4 |
| 8 | `edit_file`: `path`, `oldText`, `newText`, `replaceAll` (default false). Clear errors for not found and multiple matches. Atomic write. Returns a short summary. | Design 5 |
| 9 | `write_file`: no logic change except guidance. Decide on an explicit per-call cap. | Design 6 (recommended: explicit cap) |
| 10 | `list_files`: default 500 entries, `offset`, `limit`, `totalEntries`, `truncated`. | Design 7 |
| 11 | Soft application-level workspace quota, per tier `workspaceDiskMb`, walk cap 2,000 files (assumed default). Honest that it is soft. Web-cache is not excluded from the check. | Design 8; Config |
| 12 | Truncation marker with sizes for every tool; re-read hint for `read_file`, `read_file_lines`, `search_files`, `browse_url`. Keep stale truncation. Do not pin file reads. | Design 10 |
| 13 | `browse_url`: 1 MiB fetch cap; first page inline; full text saved to `/workspace/web-cache/<name>.txt` (a plain workspace folder, no mount) when longer than one page. **Revised 2026-11-15:** no tmpfs, no Nomad spike, no automatic cleanup or eviction; when the cache cap or the quota is full, nothing is saved or deleted and the agent gets the first page plus an instruction to free space and call again. No memory fallback. | Design 9; approval gates |
| 14 | Skills wiring: new tools go into `file-management` and `long-running-task`; update catalog, known names, both `WORKSPACE_CONTEXT_TOOL_NAMES` sets, platform docs index, drift-guard tests, `CHANGELOG.md`. | Design 11 |
| 15 | The job-search skill is out of scope. | Follow-ups |
| 16 | Naming per `AGENTS.md`. Existing `ToolResult` shapes and namespaced error codes. Zod validation. `resolveWorkspacePath` and `checkReservedDir` on every path. | Design 0 |
| 17 | Message standard (owner request, 2026-11-15): every error and every limit-hit result says what happened (with the numbers) and the exact next call, written with the tool signature. The next step is inside the `error` text, because that is what the model reads. Success hints appear only on truncation, paging, incomplete or match results, never on a plain success. Example: disk full tells the agent to call `delete_file(path)`; a search result tells the agent how to read around a match with `read_file_lines`. | Design 0a; WP1 to WP6 |
| 18 | One helper builds tool signatures from the Zod schemas (`toolSignature()`), so messages, tool descriptions and docs cannot drift when a parameter is renamed. A drift test fails if a message or a doc names an unknown tool or parameter. | Design 0b; WP1 |
| 19 | Documentation as per the repo conventions: a new `file-tools.md`, a `tools/README.md` that writes the conventions down (none exists today), audit table rows with "Agent Has Info?", updates to the sandboxing and permission docs, signature-style skill instructions, platform docs index, `CHANGELOG.md`. | Design 0c; WP7 |
| 20 | `delete_file` gets an optional `recursive` argument, default `false` (owner decision, 2026-11-15, after the review). With `recursive: true` it deletes a folder and everything in it, up to `maxDeleteFiles` files per call. No new tool. | Design 7a; WP4 |

### Where this plan interprets or adds to the decisions

These are choices I made while reading the code. None changes a decision's intent. The owner
should confirm the ones marked "confirm".

| Topic | What the plan does | Why |
|---|---|---|
| Paging unit (3, 4) | Offsets and limits count Unicode code points, not UTF-16 units. | Matches `read_agent_document` (`packages/documents/src/agent-document-read.ts:64`), which never splits a surrogate pair. |
| `read_file_lines` start (4) | `startLine` is the 1-based first line. `nextLine` can be passed back as `startLine`. Not named `offset`, so it cannot be confused with the character `offset` of `read_file`. **Confirmed by the owner.** | Line numbers in `search_files` results are 1-based. |
| `read_file_lines` char cap (4, 5) | A separate `maxChars` argument (default 50,000, max 500,000) sets the character cap. `limit` still counts lines. **Owner decision**, replaces my earlier "fixed cap" proposal. | In this tool `limit` counts lines, so the character cap needs its own argument. |
| `search_files` `offset` field (6) | Each match also carries `offset`, the character offset of the match, so the agent can call `read_file`. | A minified one-line JSON file gives line 1 for every match. |
| Quota transport (11) | The effective `workspaceDiskMb` reaches the container as env var `AGENT_WORKSPACE_QUOTA_MB`, set by the launcher. The Docker and Nomad adapters need no change. | The quota is enforced inside the container. `AGENT_RUNTIME_CONFIG_JSON` is the same for every tier (`apps/worker/src/index.ts:186-199`), so it cannot carry a per-tier value. Memory limits reach the container through the scheduler, which a soft quota does not use. **Confirmed by the owner.** |
| Quota walk and ignored folders (11) | The walk skips `platformDirs` (top level only: `sandbox`, `.agents`, `.claude`, `agent`) and `dependencyDirs` (any depth: `node_modules`, `.git`). Both lists are config (`tools.files`). **Review fix.** | `execute_code` wipes `sandbox/` before every run (`code.ts:107-110`) and `npm install` fills it with `node_modules`. Counting them would hit the 2,000-file cap and block all writes. `.agents`, `.claude` and `agent` hold the installed skill copies, which the platform put there, not the agent. **The `sandbox/` part was confirmed by the owner; the rest was added in review.** |
| Quota walk and `web-cache/` (11) | `web-cache/` is counted. | It is a plain workspace folder on the same disk, so it must count. See Design 8. **Confirmed by the owner.** |
| `list_files` max limit (10) | `limit` max is 2,000 (config). | The decision gives no maximum. |
| `write_file` cap (9) | Explicit cap of 16,000 characters with a clear error. | Same value as `append_file`. See Design 6. |
| Web-cache cap (13) | The 50 MB cap is enforced by the tool alone (no mount). When it is reached the tool saves nothing and deletes nothing. | No infrastructure change (owner decision, 2026-11-15). The tool must stay bounded on its own. |
| `browse_url` default grant (13) | Remove `maxResponseBytes` from the default `browse_url` grant. | The grant beats config, so raising config alone does nothing. See Current state F1. |

## Review answers (owner, 2026-11-15)

The owner answered the 10 review questions. Recorded here so the sections above stay readable.

| # | Question | Answer | Effect on the plan |
|---|---|---|---|
| 1 | Count `web-cache` in the workspace quota? | Yes | Unchanged (counted). |
| 2 | Fixed 50,000 cap for `read_file_lines`? | No. The limit is an argument, default 50,000, max 500,000, and the agent may change it. | `read_file_lines` gets a `maxChars` argument. Updated in the decision table, Design 2, interpretations and tests. |
| 3 | Rename `offset` in `read_file_lines` to `startLine`? | Yes | Updated everywhere (`startLine`, `nextLine` passed back as `startLine`). |
| 4 | `read_document` cap: accept or split? | Accept: `read_document` and `browse_url` share the same setting (revisited 2026-11-15). | Gate 4 closed. One config key. PDF fetch cap rises to 1 MiB. Risk recorded. |
| 5 | Remove the 512 KiB literal from the default `browse_url` grant? | Yes | Gate 5 approved. |
| 6 | Skip `sandbox/` in the quota walk, and use an env var for the quota? | Yes to both | Confirmed in the interpretations table. |
| 7 | Nomad tmpfs spike | First approved ("you can run it"). Later withdrawn: the owner is not comfortable touching infrastructure and chose a simple MVP. | The spike and the tmpfs mount are removed from the plan. Gate 1 is closed. The spike was never run. |
| 8 | Explicit 16,000-character `write_file` cap? | Yes | Unchanged (Design 6). |
| 9 | Untrusted web text rule | OK | Design 9 text corrected: the wording comes from the job-search skill, not a platform rule. |
| 10 | `cx23` disk size | About 40 GB | Recorded as owner-confirmed. |
| 11 | `maxToolResultChars` (gate 3) | Document only, and add a UI hint: "Does not limit what the model sees in the current run. Only applies to the copy of each tool result kept in history." | Gate 3 closed. WP3 step 5 adds the help line in the three locale files and `RuntimePolicySection.tsx`. |
| 12 | Regex worker thread (owner, 2026-11-15) | Leave the final decision to the implementing agent: attempt regex; if too complex, fall back to literal search. | Design 3, WP5 step 4, risks, gate 6 and acceptance criteria updated. |
| 13 | Web cache design after the spike was dropped (owner, 2026-11-15) | Plain workspace folder, no mount. No tool deletes files on its own. If the cap or the quota is full, save nothing, return the first page plus a message telling the agent to free space with `delete_file` and call again. No memory fallback. | Design 9, config, WP6, tests, risks and gates rewritten. Option B is now the design; option C is not planned. |
| 14 | `delete_file` `recursive` (owner, 2026-11-15, after the review) | Add `recursive: false` (default) to `delete_file` as part of this implementation, with the approved parameter description. | Decision 20, Design 7a, WP4 step 6, config `maxDeleteFiles`, messages, tests. The earlier Follow-up was removed. |

### Review fixes (2026-11-15)

A review of this plan against the code produced four fixes and some housekeeping. The owner approved
applying them.

| # | Finding | Fix in this plan |
|---|---|---|
| R1 | The disk-full message tells the agent to use `delete_file`, which removes one file at a time and cannot remove a folder. A folder with many files (for example `node_modules`) can hit the 2,000-file cap and block every write, and a restricted agent has no shell. | The quota walk skips dependency and platform folders (Design 8). The quota message names the three largest top-level folders so the cleanup is actionable. `delete_file` gets `recursive: true` (decision 20, Design 7a), so an agent without a shell can clear a folder. The messages name it (Design 0a). |
| R2 | The quota walk counted platform-installed folders (`.agents`, `.claude`, `agent`), which hold installed skill copies. Root search would also return skill text as noise. | One config pair, `platformDirs` and `dependencyDirs`, is used by both the quota walk and the default search skip list. |
| R3 | `browse_url` `truncated` meant "the source hit the fetch cap", while in `read_file` it means "more pages remain". A page cut inline could report `truncated: false`. | In `browse_url`, `truncated` now means "the inline text is cut". A new `sourceTruncated` field means "the fetch cap was hit" (Design 9). |
| R4 | `errorOwner: 'platform'` notifies the operator (`agent-message-broker.ts:127`). EACCES is not a platform fault. | Platform ownership only for EIO and ENOSPC. EACCES becomes `file.permission_denied` with `errorOwner: 'agent'` (Design 0, 0a). |
| R5 | Housekeeping: decision count, answers table order, no implementation instructions, no version-skew note. | Fixed. See "Implementation instructions" and the rollout notes. |

No approval gate is open now.

## Current state (verified by reading code)

| Area | File | Fact |
|---|---|---|
| File tools | `apps/worker/src/tools/filesystem.ts` | `write_file` (`:21`), `read_file` (`:64`), `list_files` (`:111`), `delete_file`, `stat_file`. `read_file` has one param. `fsReadFile` loads the whole file. `MAX_READ_BYTES = 1_048_576` (`:12`). Errors have no `errorCode`, only `fault: false` and a text. `write_file` has no size cap. |
| Path safety | `apps/worker/src/tools/workspace.ts` | `resolveWorkspacePath` rejects absolute paths and `..`, and rejects a path whose `realpath` leaves the root. `checkReservedDir` refuses the `sandbox` first segment. `write_file` and `delete_file` call it. `read_file` does not (reads of `sandbox/` are allowed). |
| Param validation | `apps/worker/src/agent.ts:2268` | Params are validated with `tool.parametersSchema.safeParse` before `execute`. Tools trust the result. A failure returns `validation.invalid_parameters` with the schema. |
| Tool result | `agent.ts:2349` | A successful result is `JSON.stringify(result.data)`, so `data` key order is the order the model sees. A failure is a JSON error with `errorCode`, `errorOwner`, `retryable`, `fault`. |
| Tool logging | `agent.ts:1968` | Every call logs `{ tool, args }` at `info`. For file writes that includes the text. |
| Circuit breaker | `runtime-resilience.ts:102` | Only results with `fault !== false` count as failures. Content-level errors (not found, quota) use `fault: false`. |
| Stale truncation | `structured-tool-loop.ts:123-148` | A tool message older than `toolResultFullRetentionTurns` (default 5, so it fires at age 6) and longer than `toolResultMaxStaleChars` (default 1,000) becomes `slice + '...[truncated]'`. A `WeakSet` makes it happen once. `onToolResultTruncated` logs sizes. The model is not told. Pinned tools (`DURABLE_TOOL_NAMES`, `:14`): `read_skill`, `load_skill`, `read_app_docs`, `get_schema`, `read_agent_document`, `get_message`. |
| Budget values | `config/default.yaml:569-578`; `schema.ts:213-214, 363-364, 393-394, 424-425` | `defaultBudgets`: retention 5 turns, 1,000 chars, `maxToolResultChars` 8,000. Style defaults: careful 3 / 500, balanced 5 / 1,000, bold 10 / 2,000. Ceiling `RUNTIME_POLICY_CEILINGS`: 10 turns, 2,000 chars, `maxToolResultChars` 16,000. |
| `maxToolResultChars` | `agent.ts:2399-2403`, `:4361` | Used only by `addToHistory(..., { truncateToToolBudget: true })`. It cuts the copy of a tool result stored in `conversationHistory`, which is resent next tick as `recentHistory` (`:4205`). It does not cap the result the model sees in the same loop. It is a user-visible runtime policy field (`apps/web/src/features/agents/RuntimePolicySection.tsx`). |
| Scout tools | `agent.ts:3964`; `tools/registry.ts:67` | The scout gets every registered tool whose category starts with `read-`, filtered by visibility. New `read-filesystem` tools reach the scout with no code change. |
| Context sets | `runtime-composition.ts:919`; `scout-dispatch.ts:10` | Two sets list `execute_code`, `read_file`, `list_files`, `write_file`, `delete_file` by name. They decide whether the prompt shows the workspace root. `stat_file` is not in them. |
| Tool registration | `packages/domain/src/tools.ts:115` (`KNOWN_AGENT_TOOL_NAMES`), `:216` (`TOOL_CATALOG`) | Two lists. `createToolRegistry` throws at startup if the registry, the known names or the catalog disagree (`apps/worker/src/tools/index.ts:41-77`). It also throws if a built-in skill lists an unknown tool (`:80-87`). Tests compare counts against `KNOWN_AGENT_TOOL_NAMES.length`, not a fixed number (`packages/domain/src/tools.test.ts:15`, `apps/api/src/routes/agent-tools.test.ts:20`). I found no hard-coded tool total (unverified for tests outside these greps). |
| Skills | `packages/domain/src/skills.ts:247` (`FILE_MANAGEMENT_SKILL`), `:449` (`LONG_RUNNING_TASK_SKILL`, `requiredTools` at `:516`) | Both list the same five file tools. System skills sync to the DB at API start (`apps/api/src/sync-system-skills.ts`); a changed `requiredTools` or `instructions` makes a new revision. External skills do not add `file-management` (`tools/skills.ts:607`). |
| Tool visibility cap | `runtime-composition.ts:895-903`; `runtime-tool-visibility.ts:45` | Visible tools are collected skill by skill and stop at `maxVisibleToolSchemas` (64 / 128 / 256 by style). |
| Platform docs | `scripts/ts/build-docs-index.ts:615-643`; `apps/worker/src/tools/platform-docs-data.ts:1781` | The file is generated. Root `pnpm build` runs `build-docs-index` first (`package.json:8`). Regenerate with `pnpm --filter @herobids/scripts run build-docs-index`. The file-management entry is hard-coded in the script. |
| Config path | `index.ts:186-199`; `agent.ts:387`; `sandbox-utils.ts:getRuntimePolicy`; `web-access.ts:112` | The worker spreads `appConfig.agentRuntime` into `AGENT_RUNTIME_CONFIG_JSON`. The container parses it with `AgentRuntimePolicySchema` at start (fatal if invalid). Tools read `tools.*` lazily from the same JSON. |
| Resource tiers | `config/default.yaml:629-651`; `schema.ts:1532-1594`; `agent-runtime-launcher.ts:280-295, 384-393` | Per-tier profiles (free, starter, pro) fall back to `sandboxDefaults`. The launcher builds `resources` field by field. `RuntimeResourceProfile` is in `packages/domain/src/ports/runtime.ts:11`. `memoryLimitMb` is RAM (512 / 512 / 2048), not disk. |
| Docker limits | `docker-agent-manager.ts:320-337` | `HostConfig`: `Memory`, `CpuShares`, `Tmpfs { '/tmp': size=<tempStorageMb>m,noexec }`, `PidsLimit`. No disk limit for `/workspace`. It is the container writable layer. |
| Nomad limits | `nomad-runtime-adapter.ts:273-282` | `Resources`: `MemoryMB`, `MemoryMaxMB`, `CPU`. Docker driver `Config`: `image`, `labels`, `network_mode`, `pids_limit`, `cap_add`. `tempStorageMb` is not read at all. No mount, tmpfs or disk setting. |
| Container env | `agents/runtime-lifecycle.ts:113`; `env-example-drift.test.ts:41-59` | `AGENT_WORKSPACE_ROOT=/workspace` is set per container. Container-injected vars are listed in `IGNORED_ENV_VARS` so they need no `.env*.example` entry. |
| Container user | `docker/Dockerfile.agent:49-57, 72-74`; `scripts/sandbox-egress.sh` | The container starts as root and the agent runtime (and so the file tools) runs as root. Sandboxed commands run as user `agent`. `/workspace` and `/workspace/sandbox` are owned by `agent`. |
| `browse_url` | `web-access.ts:256-447` | HTTPS only, SSRF guard, redirects re-validated. Raw bytes are capped at `maxResponseBytes`, then the cleaned text is capped again. A `Content-Length` over the cap is refused, not truncated. Returns `{ url, title, content, truncated }`. |
| Grants | `capability-policy.ts:122-126` | The default `browse_url` grant sets `maxResponseBytes: 512 * 1024`. `search_web` grant sets 256 KiB. There is no `read_document` grant. |
| Web config | `schema.ts:1269-1273`; `default.yaml:661-664` | `tools.webAccess.browseUrl.maxResponseBytes` is 524288. |
| Workers | repo-wide grep | No use of `worker_threads` anywhere in `apps` or `packages`. |
| Hosts | `infra/hetzner/staging.tfvars:79`, `production.tfvars:79` | Agent nodes are `cx23`. Node memory template 3,819 MB. Disk size is not in the repo; the owner confirmed about 40 GB. |

### Findings that change the plan

- F1. The `browse_url` grant wins over config. `maxResponseBytes = grant ?? config ?? 512 KiB`
  (`web-access.ts:301`). The default grant always sets 512 KiB. Raising the config to 1 MiB alone
  changes nothing for `browse_url`. WP6 must remove the literal from the default grant so the
  config governs. A per-agent `tool_policy` override still wins. Stored policies hold only explicit
  entries (`deriveToolPolicyFromSkills` adds only `manage_bot` and `manage_agent_skills`), so the
  change reaches all agents (`apps/api/src/agents/agent-create-normalization.ts:69-95`).
- F2. `read_document` reads the same config key and has no grant (`web-access.ts:527`). Raising
  `tools.webAccess.browseUrl.maxResponseBytes` also raises the PDF fetch cap. **Owner decision: they
  share the one setting.** PDF text extraction memory at 1 MiB is untested; see Risks.
- F3. `maxToolResultChars` does not cap tool results in the loop (see table). Enforcing it would
  cut the 50,000-character default page to 4,000 / 8,000 / 16,000. So the plan does not enforce it.
- F4. Nomad ignores `tempStorageMb` and has no mount or tmpfs setting. This is why the web cache is
  a plain workspace folder and the plan makes no infrastructure change.
- F5. The soft quota needs a per-tier value inside the container. That is an env var, not the
  runtime config JSON.
- F6. `sandbox/`, the installed-skill folders (`.agents`, `.claude`, `agent`) and dependency
  folders (`node_modules`, `.git`) must be left out of the quota walk (see interpretations and
  Review fixes R1, R2).
- F7. Platform docs are regenerated by `pnpm build`, so the script is the source of truth.
- F8. A new container env var must be added to `IGNORED_ENV_VARS` in `env-example-drift.test.ts`.

## Design

### 0. Shared rules

Units and ranges
- All character counts, offsets and limits are Unicode code points. A page never splits a
  surrogate pair. Where a boundary would split one, the page is one character shorter.
- File sizes are bytes. `maxFileBytes` is 10,485,760.
- `read_file` and `read_file_lines` stream the file (64 KiB chunks through `StringDecoder('utf8')`).
  They never hold the whole file. Invalid UTF-8 becomes U+FFFD, as `fs.readFile(..., 'utf8')` does
  today. The totals (`totalChars`, `totalLines`) need a full scan on every call. A sequential scan of
  10 MiB should take tens of milliseconds, small next to an LLM call (unverified; WP2 adds a
  benchmark test with a generous bound). A byte offset cannot be mapped to a character offset
  without a scan, so I did not add an index or cache (KISS).

Params
- Numbers use `z.coerce.number().int()` because models send numbers as strings (see commit
  `96a2d25b`, and `web-access.ts` `maxResults`). Avoid `.positive()`; use `.min(1)`, because
  `convertZodToJsonSchema` normalises Draft 4 flags and some providers reject them
  (`tools/registry.ts`).
- Maximums that come from config (`readMaxChars`, `writeMaxChars`, `maxEntries`) cannot be in the
  static Zod schema. The tool body checks them after parsing and returns a `file.limit_too_large`
  style error that names the maximum. Loud failure, not silent clamping.

Results
- Success: `{ success: true, data }`. Put small metadata keys first and the big text key
  (`content`, `matches`) last. `JSON.stringify` keeps insertion order, so a result cut to 1,000
  characters by stale truncation still shows the path, range and `nextOffset`.
- Failure: `{ success: false, error, errorCode, retryable: false, fault: false }`. `fault: false`
  for content-level errors, so the tool circuit breaker does not trip. Real disk failures (EIO and
  ENOSPC) use `fault: true` and `errorOwner: 'platform'`, which also notifies the operator
  (`agent-message-broker.ts:127`). EACCES is not a platform fault: it is `file.permission_denied`
  with `errorOwner: 'agent'` and `fault: false` (Review fix R4). Existing error strings of the
  current tools stay as the first sentence where tests match them; the `errorCode` and the
  next-step sentence are added (Design 0a).
- Error codes (namespaced dot strings, like `validation.invalid_payload` and `skill.user_only`
  already in the repo):

| Code | Used when |
|---|---|
| `file.path_invalid` | `resolveWorkspacePath` fails (absolute, `..`, escapes the root) |
| `file.reserved_path` | `checkReservedDir` refuses (write side) |
| `file.not_found` | missing file or directory |
| `file.is_directory` / `file.not_a_file` | path is a directory / not a regular file (FIFO, device) |
| `file.too_large` | file larger than `maxFileBytes` on read, search or edit |
| `file.write_too_large` | the write would take the file over `maxFileBytes` |
| `file.content_too_long` | text over `writeMaxChars` |
| `file.limit_too_large` | `limit` or `maxMatches` over the configured maximum |
| `file.quota_exceeded` | write would pass the workspace quota, or the walk hit its file cap |
| `file.permission_denied` | EACCES or EPERM on a path (agent-owned; not a platform fault) |
| `file.io_error` | EIO or ENOSPC from the host disk (`errorOwner: 'platform'`, `fault: true`) |
| `edit.text_not_found`, `edit.ambiguous_match`, `edit.no_change` | `edit_file` |
| `search.invalid_pattern` | regex does not compile |

#### 0a. Message standard (owner request, 2026-11-15)

Rule: every error and every limit-hit result says (1) what happened, with the numbers, (2) why, if
it is not obvious, and (3) the exact next call, written with the tool signature. The next step is
inside the `error` text (the model reads it; the failure JSON also carries `errorCode`). Also:

- About 350 characters at most. Plain English. No stack traces. No absolute container paths: use
  workspace-relative paths. No file lists in messages (they cost tokens; the agent can call
  `list_files`).
- `errorOwner: 'agent'` for anything the agent can fix, including EACCES. `errorOwner: 'platform'`
  only for real disk failures (EIO, and ENOSPC when the host disk is full): that notifies the
  operator, and the base skill already tells the agent how to word a platform fault to the user
  (briefly, no technical detail). The message for it says not to retry and to tell the user. Confirm how `agent.ts` builds `errorOwner` and `errorCode` into the
  failure JSON (`agent.ts:2349`) and set the fields the platform already uses.
- Success results carry a `hint` only when it helps: a truncated page, an incomplete search, a
  search with matches, a capped list. Never on a plain success. `hint` is a short sentence. In
  result key order it comes after the small metadata keys and before the big text key, so it
  survives the stale-result cut to 1,000 characters (Design 10).
- Messages come from one module, `apps/worker/src/tools/file-messages.ts`, one function per code.
  The tools do not build message strings inline. Stale-result hints (Design 10), the `saveError`
  text (Design 9) and the paging hints use the same module and the same helper (0b).

Templates (the implementer may improve the wording, but must keep the three parts and the
signatures; `<...>` is filled in at run time):

| Code or result | Message the agent sees |
|---|---|
| `file.path_invalid` | `Path "<path>" is not allowed. Use a path relative to the workspace root, for example job-search/jobs.json, with no leading / and no ... Check folders with list_files(path).` |
| `file.reserved_path` | `'sandbox' is reserved for code execution. Write to another folder, for example notes/<name>.` |
| `file.not_found` | `File not found: <path>. Check the name with list_files(path: "<parent>") or find it with search_files(path, query).` Under `web-cache/`, add: `Cached pages are cleared when the agent restarts; call browse_url(url) again.` |
| `file.is_directory` | `<path> is a directory. List it with list_files(path: "<path>"). For delete_file, to delete it and everything inside it call delete_file(path: "<path>", recursive: true).` (The second sentence only for `delete_file`.) |
| `file.delete_too_many` | `<path> holds <n> files; the limit per call is <max>. Delete its subfolders one at a time: list them with list_files(path: "<path>"), then delete_file(path: "<path>/<sub>", recursive: true).` |
| `file.reserved_path` (delete) | `<path> is managed by the platform and cannot be deleted.` (workspace root, `sandbox`, and the top-level `platformDirs`) |
| `file.not_a_file` | `<path> is not a regular file, so it cannot be read.` |
| `file.too_large` | `<path> is <size> MiB; the limit is <max> MiB. Read part of it with read_file_lines(path, startLine, limit) or find text with search_files(path, query).` (edit: `...too large to edit.`) |
| `file.write_too_large` | `This write would make <path> <size> MiB; the limit is <max> MiB. Continue in a new file with append_file(path, content).` |
| `file.content_too_long` | `Content is <n> characters; the limit per call is <max>. Split it and call append_file(path, content) once per part.` (for `write_file`: first part with write_file, the rest with append_file) |
| `file.limit_too_large` | `limit <n> is above the maximum <max>. For large files use read_file_lines(path, startLine, limit) or search_files(path, query).` |
| `file.quota_exceeded` | `The workspace is full (<used> of <quota> MiB used; largest: <dir1>/ <n> MiB, <dir2>/ <n> MiB, <dir3>/ <n> MiB). Free space with delete_file(path), or delete_file(path: "<dir1>", recursive: true) for a whole folder; check a file's size with stat_file(path) and list a folder with list_files(path: "<dir1>"). Then repeat this call.` The three largest top-level folders come from the quota walk, which already has the totals. Walk-cap variant: `The workspace has more than <cap> files, so its size cannot be measured. Delete a folder you no longer need with delete_file(path: "<dir>", recursive: true); list folders with list_files(path).`  (Never suggest a folder in `platformDirs`.) |
| `edit.text_not_found` | `oldText was not found in <path>. Copy it exactly, including spaces and line endings, from read_file_lines(path, startLine, limit), or locate it with search_files(path, query).` (If CRLF is the cause, say so.) |
| `edit.ambiguous_match` | `oldText matches <n> places in <path>. Add more surrounding text to oldText, or set replaceAll: true. See where with search_files(path, query: oldText).` |
| `edit.no_change` | `oldText and newText are the same, so nothing was changed.` |
| `search.invalid_pattern` | `Invalid pattern: <engine message>. Fix it, or set regex: false to search for the text literally.` (Only if regex ships.) |
| `file.io_error` (EIO, ENOSPC) | `A platform problem stopped <action> on <path> (<code>). Do not retry; tell the user.` with `errorOwner: 'platform'`. |
| `file.permission_denied` (EACCES) | `Permission denied for <path>. Choose another path, for example under notes/, or check the file with stat_file(path).` with `errorOwner: 'agent'`. |
| `read_file` paged (hint) | `More text remains. Continue with read_file(path, offset: <nextOffset>) or search_files(path, query).` |
| `read_file_lines` paged (hint) | `More lines remain. Continue with read_file_lines(path, startLine: <nextLine>).` |
| `search_files` with matches (hint) | `Read around a match with read_file_lines(path: "<file>", startLine: <line - 5>, limit: 20).` |
| `search_files` incomplete (hint) | `Search stopped: <reason>. Narrow it with path or query, or raise maxMatches (max <n>).` |
| `list_files` capped (hint) | `Showing <n> of <total>. Continue with list_files(path, offset: <nextOffset>).` |
| `browse_url` `saveError` | As Design 9, with the signatures: `...delete files with delete_file(path), for example in web-cache/, then call browse_url(url) again.` |

#### 0b. Signature helper

- `apps/worker/src/tools/tool-signature.ts`: `toolSignature(name)` returns
  `read_file_lines(path, startLine?, limit?, maxChars?)` built from the tool's Zod parameters
  (`?` marks optional). `toolCall(name, args)` returns an example such as
  `read_file_lines(path: "jobs.json", startLine: 115, limit: 20)` and checks that `name` is a known
  tool and every key is a real parameter. A wrong name or key throws in tests (and in production
  falls back to the bare name; it never throws at run time).
- Messages, tool descriptions and the stale-result hints use it. If using the tool registry causes an
  import cycle, use each tool module's exported schema, or a static map guarded by the drift test
  below. The implementer decides.
- Text that cannot call the helper (system skill instructions in `packages/domain`, which has no
  dependencies, and the markdown docs) is covered by a drift test in the worker: every
  `tool(...)` signature in `FILE_MANAGEMENT_SKILL.instructions`, in `file-tools.md` and in the
  templates above must match `toolSignature()` for a known tool.

#### 0c. Discoverability rule (from the tools audit)

No tool may require an argument the agent neither has nor can get. The audit table
(`docs/tech/agents/tools/audits/2026/06/001-tools-audit.md`) gets rows for the new tools with the
"Agent Has Info?" column. The sources are:

| Tool and argument | Where the agent gets it |
|---|---|
| `read_file.path`, `read_file_lines.path`, `search_files.path`, `edit_file.path`, `delete_file.path` | `list_files`, `search_files` (`file`), `browse_url` (`savedTo`), or a name the agent chose earlier |
| `read_file_lines.startLine` | `search_files` (`line`), `read_file_lines` (`nextLine`), `read_file` (`totalLines`) |
| `read_file.offset` | `read_file` (`nextOffset`), `search_files` (`offset`) |
| `edit_file.oldText` | `read_file_lines` (`content`) |
| `append_file.path` | chosen by the agent (a new or existing file) |
| `list_files.offset` | `list_files` (`nextOffset`) |

Paths
- Every tool calls `resolveWorkspacePath(root, path)`. Write tools also call `checkReservedDir`.
- Reads use `stat` and require a regular file, so a FIFO planted by sandboxed code cannot block a
  read forever.
- Symlink swap between resolve and open is an existing race (also in today's tools). Not changed.
- A missing file under `web-cache/` gets an extra sentence: the cache is cleared on restart, call
  `browse_url` again.

Limits module (new)
- `apps/worker/src/tools/file-limits.ts`: `getFileToolLimits()`, `getWorkspaceQuotaBytes()`,
  `getWebCacheConfig()`. They read `AGENT_RUNTIME_CONFIG_JSON` and `AGENT_WORKSPACE_QUOTA_MB` at call
  time (like `getRuntimePolicy`, so tests can set env) and parse `tools.files` with
  `FileToolsConfigSchema.parse(raw ?? {})`. Defaults come from the schema, so an older worker that
  sends no `tools.files` still gives the same values. The last parse is memoised by raw string.
- Tool descriptions interpolate the effective numbers when the module loads (same timing as
  `_runtimeConfig` in `web-access.ts:112`). Tests that change env after import will not change
  descriptions. That is acceptable.

### 1. `read_file` (extend)

```ts
params: {
  path: string,                 // min 1
  offset?: number,              // code points, >= 0, default 0
  limit?: number,               // code points, >= 1, default readDefaultChars, max readMaxChars
}
data: {
  path, offset, returnedChars, totalChars, totalLines,
  nextOffset: number | null,    // null when the page reaches the end
  truncated: boolean,           // true when nextOffset !== null
  content: string,              // last key
}
```

- Files up to `maxFileBytes` open. A larger file returns `file.too_large` with the size and the max.
- Default page is 50,000 characters. Behaviour change: a file over 50,000 characters used to come
  back whole (up to 1 MiB). It now returns the first page and `nextOffset`.
- `limit` over the maximum returns `file.limit_too_large`.
- `offset` past the end returns an empty page with `totalChars`, `nextOffset: null`.
- Empty file: `totalChars: 0`, `totalLines: 0`, `content: ""`.
- `totalLines` is the number of `\n` plus 1 if the file does not end in `\n` (0 for an empty file).
- Description warns: a page costs about one token per four characters, so 500,000 characters is
  about 125,000 tokens and can overflow a small context window. Prefer `search_files` or
  `read_file_lines`.

### 2. `read_file_lines` (new, category `read-filesystem`)

```ts
params: {
  path: string,
  startLine?: number,           // first line, 1-based, default 1
  limit?: number,               // number of lines, >= 1; default: as many as fit maxChars
  maxChars?: number,            // character cap, code points, >= 1, default readDefaultChars (50,000), max readMaxChars (500,000)
}
data: {
  path, startLine, endLine: number | null, totalLines,
  nextLine: number | null,      // pass back as `startLine`; null when done
  truncated: boolean,           // true when nextLine !== null
  lineCut?: true,               // one line was longer than the cap and was cut
  lineStartOffset?: number,     // only with lineCut: char offset of that line, for read_file
  content: string,              // lines exactly as in the file, original line endings kept
}
```

- No line-number prefixes, so the text can be copied into `edit_file`.
- Stops before the line that would take the page over `maxChars`. `maxChars` over `readMaxChars`
  returns `file.limit_too_large`. Only whole lines are returned, except when the first line alone
  exceeds `maxChars`: then its first `maxChars` characters are returned, `lineCut: true`, and
  `nextLine` is the following line. The agent continues inside that line with `read_file` and
  `lineStartOffset`.
- Beyond the last line: `content: ""`, `endLine: null`, `nextLine: null`.

### 3. `search_files` (new, category `read-filesystem`)

```ts
params: {
  path?: string,                // file or directory; default "" (workspace root)
  query: string,                // 1..maxQueryChars (200), no newline
  regex?: boolean,              // default false (literal)
  caseInsensitive?: boolean,    // default false
  maxMatches?: number,          // 1..200, default 20
  contextLines?: number,        // 0..3, default 0
}
data: {
  path, query, regex,
  returnedMatches, filesScanned, bytesScanned, skippedBinary, skippedLarge, skippedLongLines,
  incomplete: boolean,
  incompleteReason?: 'max_matches' | 'result_chars' | 'max_files' | 'max_bytes' | 'deadline' | 'max_depth' | 'regex_timeout',
  stoppedAt?: { file: string, line?: number },
  matches: Array<{ file, line, offset, text, before?: string[], after?: string[] }>,  // last key
}
```

- Results are pointers: file, 1-based line, character offset (for `read_file`), and the matching
  line cut to 300 characters. For a long line the cut is a window around the match, with `…` on
  the cut ends, not the first 300 characters.
- Budget: with the default `maxMatches` the result text is capped near 8,000 characters. When the
  agent raises `maxMatches`, the cap becomes the shared default (50,000).
- Scan limits (operator config): 500 files, 50 MiB scanned per call, 3 s deadline, depth 8,
  regex pattern 100 characters, query 200, regex lines over 2,000 characters are skipped for regex
  matching and counted in `skippedLongLines`. Binary files (a NUL byte in the first 8 KiB) are
  skipped and counted. Files over `maxFileBytes` are skipped and counted.
- Walk: sorted names, depth first. Symlinks are never followed (even inside the workspace). Default
  skipped directories are the shared lists in config `tools.files`: `platformDirs` (top level only:
  `sandbox`, `.agents`, `.claude`, `agent`) and `dependencyDirs` (any depth: `node_modules`, `.git`).
  The same lists are used by the quota walk (Design 8). An explicit `path` inside one of them is
  searched.
- Hitting any limit returns the matches found so far with `incomplete: true`, the reason and where
  it stopped. It is not an error. `max_matches` means "there may be more".
- Literal search streams each file line by line (`StringDecoder`, carry the partial line) and uses
  `indexOf` (lower-cased for `caseInsensitive`). A one-line 5 MiB JSON file is fine for literal
  search (the whole line is one string).
- Regex: the pattern is compiled on the main thread to give `search.invalid_pattern`. The main
  thread streams the lines. It sends batches of lines to one worker thread per call. The worker
  runs `RegExp.exec` and returns hit indexes. The main thread waits with the remaining deadline.
  On timeout it calls `worker.terminate()` and returns `incomplete: true`,
  `incompleteReason: 'regex_timeout'`. The worker is created with `eval: true` and a small
  self-contained CommonJS string, so there is no extra file to compile or resolve under `tsc`,
  `tsx` or `vitest`. It sets `resourceLimits.maxOldGenerationSizeMb` (64) to protect the container.
  No new dependency.
- Implementer's decision (owner, 2026-11-15): the implementing agent decides whether regex ships.
  It must attempt regex first, with the worker approach above. If it proves too complex, it falls
  back to literal-only search without asking. "Too complex" means any of: (a) the worker cannot be
  made to run reliably under the `tsc` build, `tsx` dev and `vitest` and in the agent container
  image; (b) `terminate()` does not stop a catastrophic pattern within the deadline; (c) the timeout
  tests stay flaky after two honest attempts (per the "failed twice, step back" rule in
  `AGENTS.md`). RE2 or any other new dependency still needs the owner's approval, so it is not a
  fallback the implementer may take alone.
- If it falls back to literal-only: remove the `regex`, `maxRegexChars` and `regexLineMaxChars`
  parts from the tool schema and description (do not leave a parameter that always fails), keep
  `incompleteReason` values for the literal path, remove the `regex_timeout` value, and write the
  reason and what was tried in `results.md` in this folder. Regex then becomes a follow-up plan.
  Everything else in `search_files` is unchanged.
- Multi-line queries are refused by the schema (`query` must not contain `\r` or `\n`).

### 4. `append_file` (new, category `write-filesystem`)

```ts
params: { path: string, content: string, ensureNewline?: boolean /* default true */ }
data:   { path, bytesAppended, newlineAdded: boolean, sizeBytes }
```

- `content` over `writeMaxChars` (16,000) returns `file.content_too_long` and points to repeated
  appends. 16,000 characters fits the 4,096-token output limit with margin (about 4 characters per
  token, unverified for non-English text).
- With `ensureNewline` true, if the file exists, is non-empty and its last byte is not `\n`, one
  `\n` is added before the content. The content is otherwise untouched. A new file starts empty and
  gets no leading newline. The newline and the content go in one `appendFile` call.
- Checks, in order: `checkReservedDir`, `resolveWorkspacePath`, not a directory, resulting size
  `<= maxFileBytes` (`file.write_too_large`), quota (`file.quota_exceeded`). Creates parent
  directories.
- Description says plainly that appending twice writes twice.

### 5. `edit_file` (new, category `write-filesystem`)

```ts
params: { path: string, oldText: string /* min 1 */, newText: string, replaceAll?: boolean /* default false */ }
data:   { path, replacements, sizeBytes, bytesDelta }
```

- `oldText` and `newText` are each capped at `writeMaxChars`.
- `oldText` not found: `edit.text_not_found`. The text says to copy it exactly from
  `read_file_lines`, including whitespace. If the file has `\r\n` and `oldText` has only `\n`, the
  message says so.
- More than one match and `replaceAll` not true: `edit.ambiguous_match` with `matchCount` so the
  agent can add context.
- `oldText === newText`: `edit.no_change`.
- Loads the file (limit 10 MiB, checked first), replaces in memory and writes atomically: a temp file
  in the same directory (`wx`), then `rename`. The temp file is removed on any error. Expected peak
  memory is about 3 to 5 times the file size (string, copy, buffer): up to about 50 MB for a 10 MiB
  file, inside a 512 MB container (unverified; WP4 measures it).
- Rename replaces the inode, so mode and owner would change. After writing the temp file, copy the
  mode and, because the runtime is root, `chown` to the original uid and gid (best effort). Without
  this, a file made by sandboxed code (user `agent`) would become root-owned and unwritable by that
  code. Unit tests cannot prove `chown`; it is a live check.
- Quota check uses the net growth (`max(newSize - oldSize, 0)`). The temporary second copy during the
  write is not counted (soft quota).
- Returns the summary, never the file.

### 6. `write_file` (guidance and cap)

- No logic change except: reject `content` over `writeMaxChars` with `file.content_too_long` ("use
  `append_file` for more"), then the same checks as `append_file` (file size, quota). The quota
  check uses net growth when overwriting.
- Recommendation: add the explicit cap. Reasons: the model output limit makes longer writes
  unlikely to arrive intact, a clear error that names `append_file` is better than a cut-off call,
  and it keeps all write tools on one config value. Cost: a write over 16,000 characters that used
  to work now fails. The operator can raise `writeMaxChars`. (Behaviour change; listed in the
  CHANGELOG.)
- Description guidance: keep each write under about 12,000 characters; use `append_file` for more.

### 7. `list_files` (cap)

```ts
params: { path?: string, offset?: number /* >= 0, default 0 */, limit?: number /* >= 1, default 500, max 2,000 */ }
data:   { path, entries, totalEntries, offset, nextOffset: number | null, truncated, }  // entries last
```

- Same sort as today. `truncated` is true when `nextOffset !== null`.

### 7a. `delete_file` (add `recursive`)

```ts
params: { path: string, recursive?: boolean /* default false */ }
data:   { path, deleted: true, filesDeleted, bytesFreed }
```

Description of `recursive` (owner-approved wording; fill `<maxDeleteFiles>` from config when the
description is built):

> Set to true to delete a folder and everything inside it. This cannot be undone. Without it, a
> folder path is refused. A folder with more than `<maxDeleteFiles>` files is refused; delete its
> subfolders one at a time.

The tool description becomes: "Delete a file from the agent workspace. With `recursive: true`,
delete a folder and its contents. The sandbox directory is reserved and cannot be deleted."

- `recursive: false` (default): exactly today's behaviour. A folder is refused with `file.is_directory`
  and the message now names `recursive: true` (Design 0a).
- `recursive: true` on a file: deletes the file, same as today (the flag only matters for folders).
- `recursive: true` on a folder: first walk it (use `lstat`; do not follow symlinks) to count files
  and sum sizes. If the count is over `tools.files.maxDeleteFiles` (default 5,000, config), refuse
  with `file.delete_too_many` and delete nothing. Otherwise remove it with `fs.rm(..., { recursive:
  true })`. A symlink inside the folder is removed as a link; its target is never touched. A path that
  is itself a symlink is unlinked, never followed. Return `filesDeleted` and `bytesFreed`, so the
  agent sees the space it freed.
- Refused (`file.reserved_path`, message in Design 0a): the workspace root (path `""`, `.` or
  anything that resolves to the root), `sandbox`, and the top-level `platformDirs` (`.agents`,
  `.claude`, `agent`), because deleting them breaks the installed skills. This is the plan's default;
  the owner can change the list in config.
- Always call `resolveWorkspacePath` first, and check the resolved path again against the root
  before `fs.rm`.
- No quota check (deletes only free space). Log the call at `info` with the path and the count (the
  agent runtime already logs tool calls).
- Not atomic. If `fs.rm` fails half way, return `file.io_error` or `file.permission_denied` and say
  how many files were deleted so far if known.
- No automatic deletion elsewhere: this is still only the agent's own call (owner rule).

### 8. Workspace quota (soft)

- New `apps/worker/src/tools/workspace-quota.ts`: `getWorkspaceUsage(root)` and
  `assertWithinQuota(root, addBytes)`.
- Usage: walk the workspace, sum `lstat` sizes of regular files, do not follow symlinks, skip the
  `platformDirs` (top level only: `sandbox`, `.agents`, `.claude`, `agent`) and the `dependencyDirs`
  (any depth: `node_modules`, `.git`). Both lists are config (`tools.files`) and are shared with
  `search_files`. The platform dirs hold installed skill copies the platform put there; the
  dependency dirs can hold thousands of files the agent cannot remove with `delete_file`. Also record
  the total per top-level folder, so the quota message can name the three largest (Design 0a). Cap
  the walk at 2,000 files (an assumed default, `quotaWalkMaxFiles`). If the walk hits the cap the
  usage is unknown, so the write fails with `file.quota_exceeded` and the walk-cap message (Design
  0a). Loud failure, not a guess. (Review fixes R1, R2.)
- `delete_file` with `recursive: true` removes a folder (Design 7a), so the agent can always free
  space without a shell. The quota messages name it.
- Called before `write_file`, `append_file`, `edit_file` and the `browse_url` cache save. Not
  called by reads or `delete_file`.
- The quota comes from `AGENT_WORKSPACE_QUOTA_MB`. If it is missing (stub or legacy path) the code
  falls back to `sandboxDefaults.workspaceDiskMb` in the runtime config JSON, so a quota always
  exists.
- It is soft. `execute_shell`, `execute_code` and the document materialiser write outside these
  tools and can overshoot between checks. Hard enforcement (Docker `StorageOpt`, Nomad
  `ephemeral_disk` or a quota filesystem) is a later infrastructure change.
- Web-cache interaction: `web-cache/` is a plain folder on the same disk, so it is counted. A full
  cache reduces room for the agent's own files. Nothing deletes cache files automatically (owner
  rule): the web-cache size cap (`webCache.sizeMb`) and the quota stop new saves, and the agent frees
  space with `delete_file`. The cache cap is checked first, then the quota.

### 9. `browse_url` and the web cache

Params and result

```ts
params: { url: string, limit?: number /* chars; default readDefaultChars; max readMaxChars */ }
data: {
  url, title,
  truncated: boolean,           // true when the inline text is cut (same meaning as in read_file)
  sourceTruncated: boolean,     // true when the fetch cap was hit, so even savedTo is not the whole page
  totalChars, returnedChars,
  nextOffset: number | null,    // only when savedTo is set
  savedTo?: string,             // "web-cache/<name>.txt"
  saveError?: string,           // the page was too long but could not be saved; says why and what to do
  content: string,              // first page, last key
}
```

- Field meaning (Review fix R3): `truncated` means the inline `content` is shorter than the cleaned
  text, exactly as in `read_file`. Today's `truncated` ("the source hit the fetch cap") moves to
  `sourceTruncated`. `browse_url` has no `offset` parameter: `nextOffset` is an offset into the saved
  file, so the continue hint is `read_file(path: "<savedTo>", offset: <nextOffset>)`. Update the
  existing tests and any code that reads the old `truncated` (search for it before changing).
- Fetch cap: 1 MiB (config `tools.webAccess.browseUrl.maxResponseBytes`) after removing the literal
  512 KiB from the default grant (F1). A page whose `Content-Length` is over the cap is still
  refused, as today.
- The inline page is the first `limit` characters of the cleaned text. If the cleaned text is
  longer than one page, the full cleaned text is also saved and `savedTo` is returned. Small pages
  write nothing. Behaviour change: pages over 50,000 characters used to come back whole (up to 512
  KiB) and now come back as a first page plus `savedTo`.
- Name: `<host-slug>-<sha256(finalUrl)[0..12]>.txt`. The same URL overwrites the same file. No path
  input from the model or the page.
- Design (owner decision, 2026-11-15): the web cache is a plain folder inside the workspace
  (`/workspace/web-cache`). There is no tmpfs mount and no change to Docker, Nomad or Terraform.
  No tool deletes any file on its own, not even its own cache files. The only deletes are the
  agent's `delete_file` calls.
- Save steps (in `apps/worker/src/tools/web-cache.ts`), in this order:
  1. If the cleaned text fits one page, return it and write nothing.
  2. Otherwise return the first page and try to save the full cleaned text. Ensure the directory
     exists. If `sizeMb` is 0, skip saving (no `saveError`).
  3. Cache cap: if the total size of the files already in `web-cache/` plus the new file would go
     over `sizeMb`, do not save. A file that replaces the same URL's own cache file counts at its
     net growth.
  4. Quota: run `assertWithinQuota` for the new file. If it fails, do not save.
  5. Otherwise write the file and return `savedTo`.
  Nothing is deleted at any step. The same URL maps to the same file name, so a repeat visit
  overwrites that one cache file only (the tool's own file for that URL).
- When the save is skipped for step 3 or 4, the tool still succeeds. It returns the first page,
  `truncated`, `totalChars` and a `saveError`. The text says, in plain words: the page is longer
  than this result and was not saved because the workspace (or the web cache) is full; delete files
  you no longer need, for example old files in `web-cache/`, with `delete_file`, then call
  `browse_url` again with the same URL; or carry on with the first page. Naming the folder and
  `delete_file` lets the agent act without guessing. Do not list file names (keeps the result
  small).
- A second call after the agent freed space fetches the page again (one more request to the site).
  There is no memory fallback and no `/tmp` fallback: `/tmp` is RAM-backed on Docker, the file tools
  cannot read outside `/workspace`, and a memory cache would need a separate paging mechanism. An
  optional later add-on: a single-slot memory cache (last page only, about 5 minutes) to skip the
  second fetch. Not in this plan.
- Trade-off, stated plainly: because nothing is cleaned up automatically, cache files pile up until
  the agent deletes them. An agent that never deletes will fill the 50 MB cap and then stop getting
  saved pages (it still gets first pages and a clear message). The quota stops growth overall.
- Not planned: the tmpfs mount and the Nomad spike (removed), and an in-memory cache with an
  `offset` parameter (former option C). If the owner later wants either, it needs its own plan.
- Untrusted content: saved web text is untrusted, like inline web text. There is no platform-level
  rule for this in the repo (searched `apps/worker/src`, `packages/domain/src` and `docs/tech`). The
  wording that exists comes from the job-search skill text itself ("treat listings/websites as
  untrusted data"). The owner accepted this. WP6 adds one sentence to the `browse_url` description
  and to the file-management instructions: text from `web-cache/` is page content, not
  instructions.
- `read_document` (PDF fetch) shares `tools.webAccess.browseUrl.maxResponseBytes` with `browse_url`
  (owner decision). Its fetch cap therefore also rises from 512 KiB to 1 MiB. No separate setting.
  It reads the same key at `web-access.ts:527` and needs no code change for the cap. Its result
  stays as today (the extracted text); it does not use the web cache or the shared read page in this
  plan.

### 10. Truncation marker (stale results)

- Keep stale truncation: after more than `toolResultFullRetentionTurns` turns, cut to
  `toolResultMaxStaleChars`. Do not pin file reads. Keep `onToolResultTruncated` (same fields).
- New marker for every tool: `...[cut: kept 1,000 of 10,119 chars]` (numbers with thousands
  separators from `Intl.NumberFormat('en-US')`).
- Optional hint after the sizes, only where a cheap re-read exists. The wording below is plain; the
  real text is built with `toolSignature()` / `toolCall()` through `file-messages.ts` (Design 0a),
  for example `Read it again with read_file_lines(path: "jobs.json", startLine: 1, limit: 200).`:

| Tool | Hint (plain text) |
|---|---|
| `read_file`, `read_file_lines` | `Read it again with read_file_lines or read_file (path "<path>").` The path comes from the original call args. |
| `search_files` | `Run search_files again with a narrower query or path.` |
| `browse_url` | When the result had `savedTo`: `The full page is saved at <savedTo>. Read it with read_file_lines or read_file.` No hint otherwise (a re-fetch is not cheap). |

- The loop is generic. Add a loop option
  `describeCutResult?: (info: { toolName, args, originalContent }) => string | undefined`. The loop
  records `toolCall.args` by id when it pushes the assistant message. A new module
  `apps/worker/src/stale-result-hints.ts` holds the table above. `agent.ts` passes it at both loop
  call sites (scout `:4021`, judge `:4300`). For `browse_url` the hint reads `savedTo` from the
  original content with a guarded `JSON.parse`. Because `savedTo` is an early key, it also survives
  the cut.
- Update tests that assert `'...[truncated]'`: `structured-tool-loop.test.ts` lines 833, 907, 1262
  and the comment at 1190. Update the JSDoc at `structured-tool-loop.ts:84`. Older docs
  (`docs/bug-reports/2026/11/14/002-...`, the 2026/06 and 2026/07 plans) describe the old marker as
  history; leave them.

### 11. Wiring

- `packages/domain/src/tools.ts`: add `append_file`, `edit_file`, `read_file_lines`, `search_files`
  to `KNOWN_AGENT_TOOL_NAMES` (`:115`) and to `TOOL_CATALOG` (`:216`). Categories: `read_file_lines`
  and `search_files` are `read-filesystem`; `append_file` and `edit_file` are `write-filesystem`.
  Update the `read_file` catalog text.
- `packages/domain/src/skills.ts`: `FILE_MANAGEMENT_SKILL` (`:247`) `requiredTools` and
  `instructions`; `LONG_RUNNING_TASK_SKILL.requiredTools` (`:516`). Existing agents with
  `file-management` get the tools with no new skill. Instruction lines stay short.
  `FILE_MANAGEMENT_SKILL.requiredTools` and the long-running skill must stay equal
  (`packages/db/src/agent-runtime-descriptor.test.ts:91` compares with the constant).
- `apps/worker/src/tools/filesystem.ts` re-exports the new tools in `filesystemTools`, so
  `tools/index.ts` and the existing registry test (`tool-registry.test.ts:159`) need no change.
- Both `WORKSPACE_CONTEXT_TOOL_NAMES` sets (`runtime-composition.ts:919`, `scout-dispatch.ts:10`):
  add `read_file_lines`, `search_files`, `append_file`, `edit_file`. Also add `stat_file`, which both
  sets already omit (small fix, same lines).
- Platform docs: edit the entry in `scripts/ts/build-docs-index.ts:615-643`, then run
  `pnpm --filter @herobids/scripts run build-docs-index`. Commit only the file-management hunk if
  the regeneration shows unrelated differences.
- `docs/tech/agents/tools/audits/2026/06/001-tools-audit.md:89-95` lists file tool args; add the new
  tools and params (audit table, optional but cheap).
- `CHANGELOG.md` under `[Unreleased]`: Added (four tools, web cache, quota), Changed (`read_file`
  paging, `browse_url` inline page, `list_files` cap, `write_file` cap, truncation marker).
- No new operator env var. `AGENT_WORKSPACE_QUOTA_MB` is container-injected: add it to
  `IGNORED_ENV_VARS` in `env-example-drift.test.ts` with a comment. No `.env*.example` change. If
  review finds a real operator env var, update the matching `.example` in the same change.

## Config

`config/default.yaml` (under `agentRuntime`, next to the existing `tools:` block):

```yaml
  sandboxDefaults:
    workspaceDiskMb: 100         # soft app-level workspace quota (MiB); fallback when a tier has no value
  resourceProfiles:
    free:
      workspaceDiskMb: 100       # soft workspace quota (MiB). Not RAM, not tmpfs. See tools.files
    starter:
      workspaceDiskMb: 100
    pro:
      workspaceDiskMb: 500
  tools:
    files:
      maxFileBytes: 10485760     # largest file the file tools open or grow to (10 MiB)
      readDefaultChars: 50000    # default page for read_file, read_file_lines and the browse_url inline page
      readMaxChars: 500000       # largest `limit` (read_file, browse_url) or `maxChars` (read_file_lines) an agent may ask for (about 125k tokens)
      writeMaxChars: 16000       # per-call text cap for write_file, append_file and edit_file
      quotaWalkMaxFiles: 2000    # files counted when summing workspace size; over this the write fails
      maxDeleteFiles: 5000       # most files delete_file(recursive: true) removes in one call; a bigger folder is refused
      platformDirs: [sandbox, .agents, .claude, agent]  # top-level folders the platform manages; skipped by the quota walk and by default searches
      dependencyDirs: [node_modules, .git]              # folders skipped at any depth by the quota walk and by default searches
      list:
        defaultEntries: 500
        maxEntries: 2000
      search:
        defaultMatches: 20
        maxMatches: 200
        lineMaxChars: 300
        defaultResultChars: 8000 # result text cap at the default match count
        contextMaxLines: 3
        maxFiles: 500
        maxScanMb: 50
        deadlineMs: 3000
        maxDepth: 8
        maxQueryChars: 200
        maxRegexChars: 100
        regexLineMaxChars: 2000
    webAccess:
      browseUrl:
        maxResponseBytes: 1048576  # 1 MiB (was 524288); the default grant no longer overrides it
      webCache:
        sizeMb: 50               # tool-enforced cap on the web-cache folder (MiB); 0 turns saving off. Nothing is deleted automatically
        dir: web-cache           # under the workspace root
```

Zod, in `packages/domain/src/config/schema.ts` (defaults live here only):

```ts
export const FileToolsConfigSchema = z.object({
  maxFileBytes: z.number().int().min(1024).max(104_857_600).default(10_485_760),
  readDefaultChars: z.number().int().min(1).default(50_000),
  readMaxChars: z.number().int().min(1).default(500_000),
  writeMaxChars: z.number().int().min(1).default(16_000),
  quotaWalkMaxFiles: z.number().int().min(1).default(2_000),
  maxDeleteFiles: z.number().int().min(1).default(5_000),
  platformDirs: z.array(z.string().min(1)).default(['sandbox', '.agents', '.claude', 'agent']),
  dependencyDirs: z.array(z.string().min(1)).default(['node_modules', '.git']),
  list: z.object({ defaultEntries: z.number().int().min(1).default(500), maxEntries: z.number().int().min(1).default(2_000) }).default({}),
  search: z.object({ /* keys above with the same defaults */ }).default({}),
}).default({}).refine((c) => c.readDefaultChars <= c.readMaxChars && c.list.defaultEntries <= c.list.maxEntries, { message: '...' });

export const WebCacheConfigSchema = z.object({
  sizeMb: z.number().int().min(0).default(50),
  dir: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).default('web-cache'),
}).default({});
```

- `AgentRuntimeConfigSchema.tools` (`schema.ts:1594`) gets `files: FileToolsConfigSchema`.
  `WebAccessToolsConfigSchema` (`:1262`) gets `webCache`. `browseUrl.maxResponseBytes` default
  becomes `1024 * 1024` and is shared by `read_document`.
- `sandboxDefaults` (`:1532`) gets `workspaceDiskMb: z.number().int().min(1).default(100)`. Each
  `resourceProfiles` entry (`:1557`) gets `workspaceDiskMb: z.number().int().min(1).optional()`
  (optional so an existing profile without it still validates; `default.yaml` sets all three).
- `RuntimeResourceProfile` (`packages/domain/src/ports/runtime.ts:11`) gets
  `workspaceDiskMb?: number`.
- `staging.yaml` and `production.yaml`: no override planned. Add one only if the staging soak shows a
  need (for example a smaller `webCache.sizeMb` on 512 MB tiers).

Who reads what

| Value | Read by | How |
|---|---|---|
| `tools.files.*`, `tools.webAccess.*` | agent container, worker tools | `AGENT_RUNTIME_CONFIG_JSON` (`getFileToolLimits()`, `getWebCacheConfig()`) |
| `webCache.sizeMb`, `webCache.dir` | agent container, `browse_url` | `AGENT_RUNTIME_CONFIG_JSON` (`getWebCacheConfig()`). No change to the Docker manager or the Nomad adapter. |
| `workspaceDiskMb` (effective, per tier) | launcher -> container | `AgentRuntimeLauncher.launch` resolves the profile (`agent-runtime-launcher.ts:384`), adds `workspaceDiskMb` to `resources`, and sets `env['AGENT_WORKSPACE_QUOTA_MB']`. `index.ts:348` `defaultResources` gets the `sandboxDefaults` value. |

Restart note: policy is passed at container start. After a config change, restart the agents.

## Implementation instructions

For the implementer.

- Read the whole plan first, including "Review fixes", "What this will and will not fix" and the
  decision table. File and line references are pointers that will drift; confirm them in the code
  before relying on them.
- Work on a new branch. One atomic commit per work package (one logical change per commit). Do not
  commit unless the owner asks; if the owner asks, do not push to `main`. Do not stage or touch
  unrelated files.
- Build in this order: WP1, then WP2. **Stop for owner review after WP2**, then WP3 and WP4. **Stop
  for review after WP4.** Then WP5, WP6, WP7. Say which WPs you ran in parallel.
- After each WP run the focused tests, then `pnpm lint`, `pnpm test` and `pnpm build`
  (`AGENTS.md`). Do not skip the drift tests.
- Write `results.md` in this folder as you go: decisions you took (for example regex shipped or fell
  back to literal), deviations from the plan and why, measured numbers, and anything left
  unverified.
- If an approach fails twice, stop and explain (`AGENTS.md`). Do not add a dependency, change
  infrastructure, or change behaviour that this plan marks as documentation-only without the owner's
  approval.
- Do not run the live stack or change the running agents yourself; the live checks are for the
  owner (see "Live verification and rollout").

## Work packages

Each WP is shippable and testable on its own. Run `pnpm lint` and the focused tests after each.

Rule for every WP that adds or changes a tool: all its errors and hints come from `file-messages.ts`
(Design 0a), and the WP is not done until each of its error codes has a test (Test plan, "Messages").
The tool's `description` states the unit of every parameter and names its companion tools with
`toolSignature()` (for example `read_file` points to `read_file_lines` and `search_files`).

| WP | Scope | Depends on | Status |
|---|---|---|---|
| WP1 | Foundation | none | DONE |
| WP2 | Read side | WP1 | DONE |
| WP3 | Truncation marker | WP2 (hint targets) | DONE |
| WP4 | Write side | WP1 | PENDING |
| WP5 | `search_files` | WP1 | PENDING |
| WP6 | `browse_url` and web cache | WP1 | PENDING |
| WP7 | Docs and wrap-up | WP2 to WP6 | PENDING |

Parallel after WP1: WP2, WP4, WP5 and WP6 touch mostly separate files and can run at the same
time. Shared files with small, separate hunks: `filesystem.ts` (WP2, WP4), `tools.ts` and
`skills.ts` (each WP adds its own tool name). WP3 can start once WP2 has `read_file_lines`; its
`search_files` and `browse_url` hints land with WP5 and WP6.

### WP1. Foundation

1. `schema.ts`: add `FileToolsConfigSchema`, `WebCacheConfigSchema`, `sandboxDefaults.workspaceDiskMb`,
   profile `workspaceDiskMb`, `tools.files`, `webAccess.webCache`; raise `browseUrl.maxResponseBytes`
   default. Export the new types.
2. `ports/runtime.ts`: `workspaceDiskMb?`.
3. `config/default.yaml`: the snippet above, with one comment per key.
4. `apps/worker/src/tools/file-limits.ts` (reader, memoised).
5. `apps/worker/src/tools/file-text.ts`: code-point helpers, a streaming page reader (by characters)
   and a streaming line reader, used by `read_file`, `read_file_lines`, `search_files`, `edit_file`.
6. `apps/worker/src/tools/workspace-quota.ts`.
7. `agent-runtime-launcher.ts`: add `workspaceDiskMb` to `resources` (profile, then default); set
   `AGENT_WORKSPACE_QUOTA_MB` in `env` (move or extend the env build so it runs after the profile is
   resolved). `index.ts:348`: add `workspaceDiskMb` to `defaultResources`.
8. `env-example-drift.test.ts`: add `AGENT_WORKSPACE_QUOTA_MB` to `IGNORED_ENV_VARS`.
9. `apps/worker/src/tools/tool-signature.ts`: `toolSignature()` and `toolCall()` (Design 0b), and the
   signature drift test.
10. `apps/worker/src/tools/file-messages.ts`: one function per code in Design 0a, using the helper.
    The tool WPs call it; no tool builds a message string inline.

Tests: schema defaults and bounds; reader falls back to schema defaults when JSON lacks
`tools.files`; quota walk (sum, cap, `sandbox/` skipped, symlinks not followed); launcher puts the
tier value in the env; `RuntimeResourceProfile` carries the field.

### WP2. Read side

1. `read_file`: new params and result; stream by characters; `file.*` codes; keep today's error
   strings.
2. `read_file_lines` in a new module, re-exported from `filesystem.ts`.
3. `list_files`: `offset`, `limit`, `totalEntries`, `nextOffset`, `truncated`.
4. Tool descriptions (short, with the token-cost warning).
5. Wiring for `read_file_lines`: `KNOWN_AGENT_TOOL_NAMES`, `TOOL_CATALOG` (update `read_file` text),
   `FILE_MANAGEMENT_SKILL`, `LONG_RUNNING_TASK_SKILL`, the two `WORKSPACE_CONTEXT_TOOL_NAMES` sets.

### WP3. Truncation marker (and the `maxToolResultChars` item)

1. `structured-tool-loop.ts`: new marker, `describeCutResult` option, record call args by id.
2. `stale-result-hints.ts` with the `read_file` and `read_file_lines` rows now; `search_files` and
   `browse_url` rows added in WP5 and WP6.
3. `agent.ts`: pass `describeCutResult` at both call sites.
4. Update the tests that assert the old marker.
5. `maxToolResultChars` (recommended, no behaviour change): leave the value and the logic. Fix the
   misleading name's effect with documentation: JSDoc on the field in
   `packages/domain/src/runtime-composition.ts:27` and `schema.ts`, and the comment in
   `default.yaml:573` ("caps the copy of a tool result kept in cross-tick history; it does not cap
   results in the current loop"). Add a help line under the field in the agent runtime policy UI,
   using the same pattern as `maxHoldDurationHelp`: a new message id
   `agents.runtimePolicy.maxToolResultCharsHelp` in `en.ts`, `ar.ts` and `hi.ts`
   (`apps/web/src/app/i18n/locales/`), rendered under the `maxToolResultChars` field in
   `apps/web/src/features/agents/RuntimePolicySection.tsx` (the existing `field === 'maxHoldDurationMs'`
   block at about line 270 is the model). English text (owner wording): "Does not limit what the
   model sees in the current run. Only applies to the copy of each tool result kept in history."
   Translate the Arabic and Hindi strings. The label and the setting do not change. Enforcing the
   name literally is rejected (F3). No behaviour change (owner decision: document only).

### WP4. Write side

1. `append_file` and `edit_file` in new modules, re-exported from `filesystem.ts`.
2. `write_file`: cap, quota and file-size checks, description guidance.
3. Quota check in all three (net growth for overwrite and edit).
4. Atomic write helper with mode and best-effort owner preservation.
5. Wiring for `append_file` and `edit_file` (as WP2 step 5).
6. `delete_file`: add `recursive` (default false), `maxDeleteFiles`, the protected paths and the new
   messages (Design 7a). No wiring change (`delete_file` is already in the catalog, the skills and
   the context sets); update its catalog description and the audit table row.

### WP5. `search_files`

1. Literal scanner: file walk, line streaming, limits, `incomplete` results, match windows, offsets.
2. Regex path: compile check, batch protocol, `eval` worker, deadline and `terminate()`.
3. Wiring (as WP2 step 5) and the stale hint row.
4. Implementer's decision: attempt the regex path (steps 1 and 2). If it is too complex (criteria
   in Design 3), fall back to literal-only search as described there, record the reason in
   `results.md`, and continue with the rest. The implementer decides; the owner does not need to
   approve the fallback. Adding RE2 or another dependency does need approval.

### WP6. `browse_url` and the web cache

1. Default grant: remove `maxResponseBytes` from `browse_url` (`capability-policy.ts:122-126`).
2. `web-access.ts`: `limit` param, first page, `totalChars`, `savedTo`, key order, fetch cap from
   config. Keep SSRF, https-only and redirect checks untouched.
3. `web-cache.ts`: save, cache-cap check, quota check, the `saveError` text. No deletion of any
   file, no sweep, no eviction.
4. Stale hint row for `browse_url`.
5. `read_document` shares the raised cap (no code change). Add a test that a PDF between 512 KiB and
   1 MiB is now fetched and extracted, and measure memory during the staging soak.
6. No infrastructure work: no change to `docker-agent-manager.ts`, `nomad-runtime-adapter.ts`,
   `index.ts` for the cache, or any Terraform. (The tmpfs mount and the Nomad spike were removed on
   2026-11-15.)

### WP7. Docs and wrap-up

1. `file-management` instructions in the repo's skill-writing style (`docs/tech/agents/skill-authoring.md`,
   "Writing style"): "You can..." phrasing and one line per tool with its signature, for example
   `read_file_lines(path, startLine?, limit?, maxChars?)`. Keep it short (prompt cost). Then the
   platform docs entry in `scripts/ts/build-docs-index.ts`; regenerate.
2. New `docs/tech/agents/tools/file-tools.md`, in the style of `agent-creation-tools.md`:
   - source links (`filesystem.ts` and the new modules) and a link to this plan;
   - visibility ("shown when": agents with `file-management`; scout gets the read tools);
   - a tool table (`Tool | Input | What it does`) for all file tools and the `browse_url` page and
     `web-cache` behaviour;
   - parameter and result schemas, and the paging fields (`nextOffset`, `nextLine`, `truncated`);
   - a limits table with the config key and default for each limit (read default and max, file
     size, write cap, list, search, quota, web cache);
   - an error table: code, when, and the next step the message gives (Design 0a);
   - the workspace quota and the web cache (no automatic deletion, what happens when full);
   - security notes: path rules, symlinks, reserved `sandbox/`, regex safety if it ships;
   - "Known gaps" (soft quota, `append_file` not idempotent, ephemeral workspace) and "Not in MVP"
     (`download_file`, hard disk limits);
   - operator config (`tools.files`, `webCache`, `workspaceDiskMb`).
3. New `docs/tech/agents/tools/README.md` that writes the conventions down, because none is written
   today: the page layout above, the namespaced error code rule, the message standard (Design 0a),
   the signature style, the discoverability rule (Design 0c), and how to keep the audit table up to
   date. Link it from `docs/best-practices/README.md` if that index lists tool docs.
4. `docs/tech/agents/tools/audits/2026/06/001-tools-audit.md`: update the file-tool rows
   (`read_file` args, `list_files` paging, `delete_file` `recursive`, `browse_url` `limit`) and add rows for `read_file_lines`,
   `search_files`, `append_file` and `edit_file` with the "Agent Has Info?" column (Design 0c).
5. `docs/tech/agents/tool-access-and-sandboxing.md`, "Filesystem And Process Policy": add the
   soft workspace quota per tier, the file tool limits, and the web cache (a plain workspace folder,
   nothing deleted automatically). `docs/tech/agents/tools/permission-levels.md`: a note that file
   tools are scoped to the workspace at every permission level and subject to the quota (the
   "Filesystem scope" row).
6. `CHANGELOG.md`.
7. `docs/best-practices/agent-runtime.md`: a short "File tools and read limits" section (limits are
   operator config, per-call caps, the soft quota, the cost note).
8. Check every relative link in the new and changed docs resolves.
9. Measure the prompt cost of the new schemas, instructions and messages (see Test plan) and record
   it.

## Test plan

Unit tests are behaviour-named. Use a temp dir for `AGENT_WORKSPACE_ROOT`, as
`filesystem.test.ts` does.

`read_file`
- "returns the first page and nextOffset for a file longer than the default page"
- "returns the whole file with nextOffset null when it fits in one page"
- "returns the same text across consecutive pages with no gap or overlap"
- "never splits a surrogate pair at a page boundary" (emoji at the boundary)
- "pages multi-byte UTF-8 text by characters, not bytes" (Chinese, Arabic, accents)
- "counts totalLines for a file with and without a trailing newline"
- "opens a file of exactly 10,485,760 bytes" and "refuses a file one byte larger with file.too_large"
- "pages a 10 MiB file in bounded memory" (stream; assert a time bound only generous)
- "returns an empty page for an empty file", "returns an empty page for an offset past the end"
- "rejects a limit above the maximum with file.limit_too_large", "accepts limit equal to the maximum"
- "returns file.not_found for a missing file", "returns file.is_directory for a directory"

`delete_file` (Design 7a)
- "deletes a file exactly as before when recursive is not given", "refuses a folder with
  file.is_directory and the message names recursive: true", "deletes a folder and its contents with
  recursive: true and reports filesDeleted and bytesFreed", "recursive: true on a file deletes the
  file", "refuses a folder with more files than maxDeleteFiles and deletes nothing", "does not follow
  a symlink inside the folder and leaves its target untouched", "unlinks a symlink path without
  touching its target", "refuses the workspace root, sandbox and the top-level platform dirs", "refuses
  a path that escapes the workspace", "deletes nested folders", "frees quota so a refused write
  succeeds afterwards", "the disk-full message names delete_file with recursive: true and a real
  folder".
- "refuses a path that escapes through a symlink", "refuses .. and absolute paths"
- "reads a file under sandbox/" (existing behaviour kept)
- "adds the restart hint when a web-cache file is missing"

`read_file_lines`
- "returns whole lines exactly as in the file, with no line numbers"
- "keeps CRLF line endings"
- "returns nextLine that continues with no gap", "returns nextLine null at the end"
- "stops before the line that would pass maxChars", "uses the default cap when maxChars is not given",
  "accepts maxChars equal to the maximum and rejects one above it with file.limit_too_large"
- "cuts a single over-long first line, sets lineCut and lineStartOffset"
- "honours limit in lines", "returns endLine null past the end", "handles an empty file"
- "handles a file of one very long line"

`list_files`
- "returns at most the default number of entries and truncated true", "pages with offset and limit",
  "returns totalEntries", "rejects a limit over the maximum"

`search_files`
- Literal: "finds a literal match with file, line, offset and text", "is case sensitive by default and
  case insensitive on request", "cuts a long line to a window around the match", "returns context
  lines", "stops at maxMatches and sets incomplete max_matches", "caps result text at the default
  budget and at 50,000 when maxMatches is raised", "searches a single file path", "searches a
  directory recursively in sorted order", "skips binary files and counts them", "skips the platform
  dirs (top level only) and the dependency dirs (any depth) by default", "searches a folder named
  agent that is not at the top level", "searches inside a skipped dir when the path names it", "does
  not follow symlinks", "rejects a multi-line query", "rejects a
  query over 200 characters", "returns incomplete max_files, max_bytes and deadline results with
  stoppedAt" (inject small limits and a fake clock), "skips files over 10 MiB".
- Regex: "finds a regex match", "rejects an invalid pattern with search.invalid_pattern", "rejects a
  pattern over 100 characters", "times out a catastrophic pattern (`(a+)+$` on a long `a` line),
  terminates the worker and returns partial matches with regex_timeout", "skips regex lines over
  2,000 characters and counts them", "does not leave a worker running after the call".

`append_file`
- "creates a missing file with no leading newline", "adds one newline when the file does not end
  in one", "adds none when ensureNewline is false", "adds none when the file ends in a newline",
  "adds none to an empty file", "refuses sandbox/", "refuses content over writeMaxChars", "refuses
  a result over 10 MiB", "refuses a write that passes the quota", "creates parent directories".

`edit_file`
- "replaces a single match and returns the count", "fails with edit.text_not_found", "fails with
  edit.ambiguous_match and matchCount when there are several", "replaces all with replaceAll",
  "reports a CRLF mismatch hint", "fails with edit.no_change", "leaves the file untouched on every
  failure", "writes atomically (no temp file left, also on error)", "keeps the file mode", "refuses
  sandbox/", "refuses a result over 10 MiB", "refuses a file over 10 MiB", "respects the quota",
  "edits a 10 MiB file".

`write_file`
- "keeps today's behaviour for content under the cap", "refuses content over writeMaxChars and names
  append_file", "counts net growth against the quota when overwriting".

Quota
- "sums regular files, skips the platform dirs and the dependency dirs, does not follow symlinks",
  "a top-level folder named agent is skipped but notes/agent is counted", "names the three largest
  top-level folders in the quota message", "node_modules with thousands of files does not hit the
  file cap", "fails when the walk hits the file cap and the message says delete_file removes one file
  at a time", "fails the write that would pass the quota and allows one at the limit", "falls back to
  sandboxDefaults when the env var is missing", "counts web-cache".

Messages (Design 0a; each tool WP adds the cases for its own codes)
- "every error code in the table has a test that asserts the errorCode, the numbers in the message,
  and at least one tool signature"
- "disk full: file.quota_exceeded names the usage and tells the agent to call delete_file(path), and
  after a delete the same call succeeds"
- "file.too_large points to read_file_lines and search_files with their real parameter names"
- "edit.ambiguous_match gives the match count and points to search_files"
- "write_file content over the cap points to append_file"
- "search_files with matches returns a hint with a read_file_lines call for the first match; an
  incomplete search returns the reason and how to narrow it; a search with no matches has no hint"
- "paged read_file, read_file_lines and list_files return a continue hint; the last page and a
  plain success have none"
- "the hint key comes before the content key in the serialized result, so it survives the stale cut
  to 1,000 characters"
- "every message is at most 350 characters for a long path, and contains no absolute container path"
- "an IO error (EIO, ENOSPC) is errorOwner platform and says not to retry"
- "EACCES is file.permission_denied with errorOwner agent and fault false, and does not notify the
  operator"
- Signature drift: "every tool(...) signature in the messages, the tool descriptions,
  FILE_MANAGEMENT_SKILL.instructions and file-tools.md names a known tool and real parameters and
  matches toolSignature()"
- "toolCall() throws in tests for an unknown tool or parameter and falls back to the bare name in
  production"

`browse_url` and the web cache
- "returns the whole text inline when it fits one page and writes nothing", "returns the first page,
  totalChars and savedTo when it does not", "saved file holds the full cleaned text", "same URL
  overwrites the same file", "never deletes any file, also when the cache is full", "returns the
  page with saveError and saves nothing when the cache cap would be passed", "returns the page with
  saveError and saves nothing when the quota would be passed", "truncated is true when the inline
  text is cut even if the source was not capped", "sourceTruncated is true only when the fetch cap
  was hit", "the continue hint names read_file with savedTo and nextOffset", "saveError names
  delete_file and the
  web-cache folder", "saves again after the agent deleted a file and called again", "counts a
  re-save of the same URL at its net growth", "skips saving without an error when sizeMb is 0",
  "still blocks private hosts, http and unsafe redirects" (existing tests keep passing), "uses the
  config cap when no grant sets one" (guards F1), "default grant no longer sets maxResponseBytes for
  browse_url".

Truncation marker
- "writes the kept and original sizes in the marker for every tool", "adds the read_file re-read hint
  with the path from the call", "adds the search_files hint", "adds the browse_url hint only when
  savedTo is present", "keeps the marker idempotent (one truncation per message)", "does not touch
  pinned tools", "still calls onToolResultTruncated with the same fields". Update the three existing
  assertions on `'...[truncated]'`.

Wiring and drift
- "every new tool is in KNOWN_AGENT_TOOL_NAMES and TOOL_CATALOG with the right category" (existing
  drift tests, `tools.test.ts:15`, `tool-registry.test.ts:159`, `createToolRegistry` assertion).
- "FILE_MANAGEMENT_SKILL.requiredTools resolve against the registry"; "LONG_RUNNING_TASK_SKILL lists
  the same file tools".
- "the scout read-only tool list includes read_file_lines and search_files and excludes append_file
  and edit_file" (`getReadOnlyToolNames`).
- "both WORKSPACE_CONTEXT_TOOL_NAMES sets include the new tools".
- "the visible tool set for base + file-management + web-access + programming + email stays within
  the smallest `maxVisibleToolSchemas`".
- "env-example-drift passes with AGENT_WORKSPACE_QUOTA_MB listed".
- "the runtime policy section shows the maxToolResultChars help line, and en, ar and hi all define
  agents.runtimePolicy.maxToolResultCharsHelp" (the existing locale parity test, if any, covers the
  keys).
- "read_document fetches and extracts a PDF between 512 KiB and 1 MiB under the shared cap".
- Measure the prompt cost: `JSON.stringify(registry.getDefinitions(fileTools))` size before and
  after, plus the instruction text; record in `results.md`. I estimate about 1,000 to 1,600 tokens
  per call for four tools (unverified).

Gates (from `AGENTS.md`): focused `vitest run` per file, then `pnpm lint`, `pnpm test`,
`pnpm build`. `pnpm build` regenerates `platform-docs-data.ts`; check its diff is only the intended
hunk. Integration: `pnpm test:integration` should be unaffected; run it if the DB is up.

Live (the owner runs these; I did not run the stack)
- `scripts/shell/tests/run-all-tests.sh --e2e` and `scripts/shell/tests/run-extra-tests.sh --all`.
- The `job-searcher` local stack, with the same model and skill text as the baseline. See below.

## Live verification and rollout

Baseline (owner's session, same agent): 37 ticks, 7.2M tokens, 191 LLM calls, about 160 `read_file`
calls, `jobs.json` read twice on 18 of 36 ticks, 10,119 and 11,478 character results cut to 1,000.

After WP2 to WP5 are on the local stack (rebuild the agent image, restart the agent so it gets the
new policy and skill revision):

1. Ask the agent for a task that needs a large file (a 3 to 10 MiB generated file in its workspace).
   It should page, search or edit, not fail.
2. Run the `job-searcher` skill for a few ticks. Compare with the baseline, using the `agent_messages`
   join on `payload->>'tickId'` (as in `docs/features/2026/11/14/003-agent-run-status-hint/plan.md`):
   tokens per tick, LLM calls per tick, count of `read_file` / `read_file_lines` / `search_files` /
   `append_file` / `edit_file` calls, and size of file-tool results.
3. Check the logs for `Truncated stale tool result` and read the stored message: it should carry the
   new marker and, for file reads, the hint.
4. Read a sample of the real error and hint messages in `agent_messages` (tool results) for: a
   missing file, an over-limit read, a search, a paged read, and a full workspace (lower
   `workspaceDiskMb` locally to force it). Check that the agent follows the signature in the message
   on its next call, and that it frees space and retries after a full-workspace message.
5. Check whether results get saved. This is the open behavioural question. If it does not change,
   the follow-up is the skill (Follow-ups).
6. Local Docker: `docker exec` into the agent container, browse a long page, and check that
   `/workspace/web-cache/` holds the saved file, that `read_file_lines` and `search_files` read it,
   that a full cache returns the "free space and call again" message without deleting anything, and
   that `edit_file` on a file made by sandboxed code keeps its owner.
7. Memory: watch container memory while `edit_file` runs on a 10 MiB file and while a regex search
   runs.

Staging (the owner): deploy the application change and soak. No infrastructure step is needed.
Compare tokens per tick and cost against the Cost Review Checklist. Production only after the
staging soak.

Rollback (config only; restart agents, because policy is passed at container start)
- Read size: set `readDefaultChars` and `readMaxChars` high and `maxFileBytes` to 1048576 to get
  close to the old `read_file` behaviour (the result shape only gains fields).
- `browse_url`: set `webCache.sizeMb: 0` to stop saving; raise `readDefaultChars` to get the old
  inline size; set `browseUrl.maxResponseBytes` back to 524288.
- Quota: set `workspaceDiskMb` very high.
- Write cap: raise `writeMaxChars`.
- Code rollback is a normal revert of the tool changes; the tool names stay in the catalog until
  removed from the skills.

## Risks and open items

- Large reads can overflow small-context models. 500,000 characters is about 125k tokens. The
  50,000 default (about 12k tokens) protects most runs. A model-aware clamp is a follow-up. The
  scout gets `read_file` too and its model is a cheaper, smaller one; the default page applies there.
- Regex worker thread. There is no `worker_threads` use in the repo today. Risks: complexity, a
  stuck thread, memory. Mitigation: the `eval` worker, a hard deadline with `terminate()`, a
  64 MB heap limit, a test that proves no worker survives. Fallback (implementer's decision, no
  approval needed): literal-only search, see Design 3 and WP5 step 4. Regex is then a follow-up.
- Soft quota. Code tools and `execute_shell` can overshoot between checks. The walk cap (2,000) is
  an assumed default. The walk costs up to 2,000 `lstat` calls per write. Hard limits are later
  infrastructure work.
- Web-cache files pile up. Nothing deletes them automatically (owner rule), so an agent that never
  calls `delete_file` fills the 50 MB cache cap, after which it still gets first pages and a clear
  message but no saved files. The workspace quota bounds total growth. If this proves annoying in the
  staging soak, the options are a larger `sizeMb` or a later, owner-approved cleanup rule.
- Version skew (checked in the review): the runtime config schema is not strict at the root (the
  only `.strict()` in that part of `schema.ts` is a nested placement-timeouts object), so an older
  agent image given the new `tools.files` keys drops them instead of crashing. `getDefinitions`
  skips tool names missing from an older image's registry. So an old image with the new skill
  revision does not crash, but its prompt names tools it does not have, and a call returns
  "unknown tool". Deploy the worker and the agent image together and restart agents (the plan
  already says agents need a restart).
- The quota fallback (`sandboxDefaults.workspaceDiskMb`, used when `AGENT_WORKSPACE_QUOTA_MB` is
  missing, for example on the Docker legacy path where the manager builds its own env) ignores the
  tier, so a pro agent would get the free value there. Acceptable (the launcher path sets the tier
  value); note it in `results.md` if the legacy path is found to be used.
- A repeat call after freeing space fetches the page again (one more request to the site). Accepted
  for the MVP; a single-slot memory cache is a small later add-on.
- No infrastructure is touched, so there is no RAM or tmpfs risk from the web cache. The only
  container-level addition is the `AGENT_WORKSPACE_QUOTA_MB` env var from existing launcher code.
- `edit_file` memory: about 50 MB peak for a 10 MiB file (unverified).
- `append_file` is not idempotent. If a call times out and the agent retries, the text is written
  twice. The result reports `sizeBytes` so the agent can check, and the description says so.
- Tool-call logging (`agent.ts:1968`) logs `args` at `info`. A 16,000 character append is one big
  log line. Existing behaviour for `write_file`; not changed here.
- Messages and hints cost tokens. Mitigation: about 350 characters at most, hints only when they
  help, no file lists, the hint placed before the content so it survives the stale cut. Measure the
  total with the prompt-cost check (WP7 step 9).
- The signature helper can create an import cycle with the tool registry, and domain text
  (system skill instructions) cannot call it. Mitigation: the static-map option and the drift test
  (Design 0b). The signature style in skill text adds a few lines of prompt on every call.
- Wording drift: message templates are in one module and tested for signatures, but not for
  quality. Read a sample of real messages in the live runs (Live verification) and fix unclear ones.
- `maxToolResultChars` is not what its name says (F3). Documented in code comments and in a UI help
  line, not changed. A later behaviour change needs its own approval.
- `read_document` now fetches PDFs up to 1 MiB (shared setting). PDF text extraction memory at that
  size is untested on a 512 MB container. Check memory in the staging soak; if it is a problem, the
  fix is a separate `readDocument.maxResponseBytes` setting (a small change, not built now).
- Prompt cost of four more tool schemas and about six more instruction lines on every call, for every
  agent with `file-management` (about 3 to 4% of the 37.6k average per call, if my estimate is
  right; unverified). It only pays off if the model uses the tools to read less.
- Visible-tool cap: four more tools per file-management agent. The smallest cap is 64 (style
  `careful`, `schema.ts:362`). Tools are added skill by skill and the cap drops the rest silently
  (`runtime-tool-visibility.ts:45`). The test in the plan guards this.
- Tool-count assertions in tests: I found none with a fixed total (they compare against
  `KNOWN_AGENT_TOOL_NAMES.length`). Run the full suite to confirm.
- Existing running agents need a restart (and the API restart that syncs the new skill revision) to
  see the new tools. How the runtime descriptor picks the revision for an existing agent is not
  verified (unverified).
- `read_file` counts in characters (`offset`, `limit`) and `read_file_lines` counts in lines
  (`startLine`, `limit`, plus `maxChars` for the character cap). Both use `limit`, with different
  units. The descriptions state the unit for each parameter. Watch for mix-ups in the live runs.
- A separate copy of the tool catalog exists in the traderton repo (`packages/domain/dist/tools.d.ts`
  lists the same file tools). File tools are platform tools, not trading logic, so I did not plan any
  change there (unverified whether it needs the new names).
- The web cache and quota do not protect against `execute_shell` writing a huge file. Out of scope.

Cost Review Checklist (`docs/best-practices/agent-runtime.md`)
- New `requestWakeDrivenTick()` path? No.
- Emits `instance.context.snapshot`? No.
- New repeating failure mode? Possibly an agent retrying `file.quota_exceeded` or `search` timeouts
  each turn. These are `fault: false`, so the tool circuit breaker does not count them. The agent can
  fix them with its own tools (delete a file, narrow a query), so they are not session-breaker
  cases. The error text names the fix. The existing turn caps bound a loop.
- `pnpm test` including the `SessionCircuitBreaker` tests: run the full suite.

## Items that need human approval

Status of each gate after the owner's review on 2026-11-15:

1. Nomad web-cache tmpfs spike. **Closed. Removed from the plan on 2026-11-15 (the owner does not
   want to touch infrastructure). The spike was never run.**
2. Web-cache design. **Decided: a plain workspace folder with no automatic deletion (former option
   B). Former option C (memory cache with `offset`) is not planned. A later change to either needs
   its own plan.**
3. `maxToolResultChars`. **Decided: document only, plus a UI help line (WP3 step 5). No behaviour
   change. Any later behaviour change needs its own approval.**
4. `read_document` fetch cap. **Decided: it shares the one `browse_url` setting (1 MiB). No separate
   setting. The untested PDF extraction memory at 1 MiB is tracked in Risks.**
5. Removing the literal 512 KiB from the default `browse_url` grant (F1). **Approved.**
6. Regex fallback. **Decided: the implementer attempts regex and may fall back to literal-only search
   without asking. RE2 or any other new dependency still needs approval.**
7. The interpretations marked "confirm" in the table above. **Done: see "Review answers".**
8. Production rollout and any production config values. **Not yet.**
9. Hard disk limits (Docker or Nomad): future infrastructure work, needs its own plan and approval.
   **Not in this plan.**

## Acceptance criteria

- `read_file` returns a page of at most `readDefaultChars` by default and up to `readMaxChars` on
  request, with the metadata above, for files up to 10 MiB; larger files give `file.too_large`.
- `read_file_lines`, `search_files`, `append_file` and `edit_file` exist, are in the catalog, the
  known names, `file-management` and `long-running-task`, and pass the drift tests.
- The scout can use `read_file_lines` and `search_files` and cannot use `append_file` or `edit_file`.
- `search_files` never blocks the agent process. If regex ships: a catastrophic regex returns
  partial results with `regex_timeout` within the deadline, and the worker is gone. If the
  implementer fell back: the tool is literal-only, has no regex parameter, and `results.md` says
  why.
- Writes that would pass the file-size cap or the workspace quota fail with a clear error and leave
  the file unchanged.
- `list_files` is capped and pageable.
- `browse_url` honours the 1 MiB config cap, returns a first page, and saves the full text to
  `web-cache/` when longer. The web cache is bounded by its own cap and the quota. When it is full
  the tool saves nothing, deletes nothing, and tells the agent to free space and call again.
- The stale marker shows kept and original sizes for every tool and a re-read hint for the four
  tools above. Tests for the old marker are updated.
- No new literal for an operator-tunable value; all values are in `default.yaml` and the Zod schema.
- Every error code in Design 0a is covered by a test, and every message names the next call with a
  signature that matches `toolSignature()`. A disk-full write tells the agent to call
  `delete_file(path)`; a search result tells the agent how to call `read_file_lines`. The drift
  test passes.
- `docs/tech/agents/tools/file-tools.md` and `docs/tech/agents/tools/README.md` exist, the audit
  table has rows for the four new tools with "Agent Has Info?", the sandboxing and permission docs
  are updated, and every relative link resolves.
- The `file-management` instructions use the signature style and stay short.
- `AGENT_WORKSPACE_QUOTA_MB` is in `IGNORED_ENV_VARS`; no `.env*.example` drift.
- `pnpm lint`, `pnpm test` and `pnpm build` pass. `CHANGELOG.md` is updated. The platform docs index
  is regenerated, with only the intended diff.
- A `results.md` in this folder records the live comparison against the baseline and the measured
  prompt-cost change before staging.

## Follow-ups

- `download_file`: its own plan, when a real use case appears. Pitfalls to design for: internal
  addresses and SSRF (reuse `isHostPrivate`, re-check redirects), counting bytes while streaming (not
  trusting `Content-Length`), disk fill (quota and total caps), timeouts, no overwrite by default,
  binary files, untrusted content, and the ephemeral workspace.
- The job-search skill in `openaidom-skills`, after the staging tests (for example `jobs.jsonl`
  with `append_file`, and `search_files` instead of re-reading the whole list).
- Hard disk limits for `/workspace` (Docker `StorageOpt` or Nomad `ephemeral_disk`).
- A model-aware clamp of the read size, using the model's context window.
- Mirror the file-tool limits in the web UI runtime policy view, if operators want to see them.

## Unverified items

- All live numbers (7.2M tokens, 191 calls, 160 reads, 10,119 and 11,478 characters): from the owner's
  session, not re-run here.
- Hetzner `cx23` disk size: the owner confirmed about 40 GB (not in the repo).
- Resolved: there is no platform-level "treat web text as untrusted" rule; the wording comes from the
  job-search skill text. See Design 9.
- Memory and time estimates: 10 MiB scan time, `edit_file` peak memory, regex worker memory,
  `browse_url` HTML parse at 1 MiB, and PDF text extraction memory at 1 MiB (`read_document`).
- Prompt-cost estimate for the four new tool schemas.
- That 16,000 characters fits a 4,096-token output for all languages (about 4 characters per token
  assumed).
- Whether existing running agents pick up a changed system-skill revision without being recreated.
- Whether any test outside my greps hard-codes a tool total or the old truncation marker.
- Whether the traderton copy of the tool catalog needs the new names.

## Outstanding Issues

### WP1. Foundation
- M: `workspace-quota.ts` swallows ENOENT at any depth; a folder removed mid-walk gives a silent partial sum. Handle per directory, treat only a missing root as empty.
- M: `file-messages.ts` `shown()` shortens long paths, so call examples with `recursive: true` use a non-callable path. Use the full path in call examples.
- M: `quotaExceeded` walk_capped branch suggests deleting `topDirs[0]`, which is partial. State sizes are partial or choose differently.
- L: `file-limits.ts` casts parsed JSON; prefer a small Zod schema.
- L: No upper bounds on `readMaxChars`, `writeMaxChars`, `list.maxEntries`, `search.maxMatches` in `FileToolsConfigSchema`.
- L: `tool-signature` strict mode depends on `NODE_ENV === 'test'`.
- L: `browseUrl.maxResponseBytes` default is 1 MiB before WP6 removes the 512 KiB grant literal.
- L: Legacy launcher path without envConfig does not set the quota env (theoretical).

### WP2. Read side
- M: Long-path message test weakened (repeat 12 → 3) because full-path call examples exceed the ~350-char cap for paths of ~100+ chars. Owner decision on the cap needed.
- M: Missing tests: multi-byte/emoji text straddling 64 KiB chunks; cut first line followed by more lines; `limit` with `maxChars`; "Later lines:" hint; string-typed args via Zod coercion.
- M: Plan text stale: `truncated` for `read_file_lines` is `nextLine !== null || lineCut`; WP2 step 1 "keep today's error strings" is superseded by Design 0a; add `file.not_a_directory` to the Design 0a table.
- M: Scout/context sets wiring for `read_file_lines` and `stat_file` not asserted in `scout-dispatch` / composition tests.
- L: TOCTOU between `resolveWorkspacePath` and open; file growth after `stat`; coercion of `""`/`null` to 0; unused `ReadableFile.sizeBytes`; 5 s wall-clock 10 MiB test may flake; `list_files` reads the whole directory.

### WP3. Truncation marker
- M: `staleReadHint` embeds the agent-supplied path twice with no length bound; may bloat the cut marker.
- M: `describeCutResult` could throw if `toolCall()` strict mode is active (strict is test-only, so likely low).
- L: Hint also added to error-payload results; `toolCallArgsById` never pruned; ar/hi translations need native review; long yaml comment; DOM test uses `previousElementSibling`; visual check of help line in en/ar/hi outstanding.
