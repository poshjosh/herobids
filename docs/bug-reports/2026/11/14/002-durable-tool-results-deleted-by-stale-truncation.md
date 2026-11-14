# Bug Report: Durable tool results (loaded skills, docs, schemas) are silently deleted by stale tool-result truncation

- **Status:** OPEN
- **Severity:** High
- **Date:** 2026-11-14
- **Summary:** An agent assigned the external `job-search` skill did not follow it: it never created the skill's durable-state files (the search ledger `search/search-ledger.json`, the run-state file `search/run-state.json`, and the report-state file `reports/report-state.json`), and it ran a discovery batch (the skill's Step 3, Discover Opportunities) before establishing the persistent storage and schedules the skill requires first — Step 0 mandates verifying persistent storage and a configured scheduler as prerequisites, and the skill's Search Rotation / Continuity sections require the durable-state files and scheduled runs before continuous discovery. It also did not validate lead sites. The agent self-reported that the skill text "was cut off and some of it was unavailable" when it loaded the skill. The mechanism is the stale tool-result truncation in the structured tool loop: a `read_skill` result (15665 bytes, ~15.3 KB) is silently sliced to 500 chars once it is more than 3 turns old within the same tool loop, and the back half of the skill — where the ledger/run-state/report-state setup and the later Procedure Steps live — is thrown away. The truncation applies to every tool result equally and logs nothing, so run logs do not show it happened.

## Symptom

A user ran the local Docker compose stack, created and started agent `job-searcher` (`http://localhost:8090/agents/9e53f14b-2045-4854-b0e4-22d725ab8c99`) with the external `job-search` skill assigned. The agent failed to follow the skill:

- It did not create the skill's durable-state files: the search ledger (`search/search-ledger.json`), the run-state file (`search/run-state.json`), or the report-state file (`reports/report-state.json`).
- It ran a discovery batch (the skill's Step 3, "Discover Opportunities") *before* establishing the persistent storage and schedules the skill requires first. The skill's Step 0 is a prerequisite check — verify a readable/writable persistent data directory and confirm the scheduler is configured — and the Search Rotation and Continuity and Recovery sections require the durable-state files and separately scheduled runs before sustained discovery begins. The agent skipped those prerequisites and ran discovery first.
- It did not validate lead sites.

The agent self-reported that when it loaded the skill, the instructions "was cut off and some of it was unavailable."

## Root Cause

> This is a mechanism-level diagnosis from reading the code and the numbers. It was **not** confirmed from run logs, because the truncation is silent — it mutates message content in place and logs nothing (see below). The numbers and code paths below all line up with the symptom.

External skills use progressive disclosure. The full `SKILL.md` body is installed to disk intact and later loaded on demand:

1. **Install is intact.** `apps/worker/src/external-skill-startup.ts` installs the skill at agent start; `readInstalledSkillBody` (`external-skill-startup.ts:107`) reads the file and `stripFrontmatter` (`external-skill-startup.ts:122`) removes only the YAML frontmatter. No truncation here. `job-search` is 15665 bytes (~15.3 KB) on disk.

2. **`read_skill` returns the entire body as the tool result.** When the agent calls `read_skill` (`apps/worker/src/tools/read-skill.ts`), the full body is returned as `data.instructions = body` (`read-skill.ts`, `executeReadSkill`, around line 160). The comment there even notes the body is "also returned here so the agent can act on it this tick."

3. **The structured tool loop silently truncates stale tool results.** In `apps/worker/src/structured-tool-loop.ts`, at the start of every turn the loop walks all `tool` messages and hard-slices any whose age (`turnIndex - addedAtTurn`) exceeds `toolResultFullRetentionTurns` **and** whose content length exceeds `toolResultMaxStaleChars` (`structured-tool-loop.ts:84-93`):

   ```ts
   const age = turnIndex - msg.addedAtTurn;
   if (age > options.toolResultFullRetentionTurns && msg.content.length > options.toolResultMaxStaleChars) {
     msg.content = msg.content.slice(0, options.toolResultMaxStaleChars) + '...[truncated]';
   }
   ```

   This is **silent**: it mutates `msg.content` in place and logs nothing (`structured-tool-loop.ts:89`). So run logs will not show that it happened.

4. **The effective budgets make the cut aggressive.** Defaults (`config/default.yaml → defaultBudgets`, lines 569–577): `maxHistoryTokens: 40000`, `maxToolResultChars: 4000`, `toolResultFullRetentionTurns: 3`, `toolResultMaxStaleChars: 500`. The agent style runtime defaults (`AGENT_STYLE_RUNTIME_DEFAULTS`) in `packages/domain/src/config/schema.ts` are tighter still: careful 250 chars / 2 turns (`schema.ts:335-336`), balanced 500 / 3 (`schema.ts:364-365`), bold 1000 / 5 (`schema.ts:393-394`). The hard operator ceiling `RUNTIME_POLICY_CEILINGS` is 2000 chars / 10 turns (`schema.ts:194-195`).

**Net:** a `read_skill` result (15665 bytes, ~15.3 KB) is chopped to 500 chars + `...[truncated]` once it is more than 3 turns old within the same tool loop. The instructions the agent missed — `search/search-ledger.json`, `search/run-state.json`, `reports/report-state.json`, and the later Procedure Steps — all live in the back half of the skill, well past the 500-char cut.

### Nuance: the system-prompt re-injection race

The full loaded body **is** re-injected into the system prompt on subsequent ticks via `renderSkillPromptBlock` → `buildSystemPrompt` (`apps/worker/src/runtime-composition.ts:2545,2579-2583`), and that path is **not** truncated. So there is a race:

- Across ticks, the next tick's system prompt carries the full skill body again.
- But if the agent reasons off the truncated `read_skill` **tool result** within a long tool loop on the **same tick** (more than 3 turns after it loaded the skill), it sees only the first 500 chars + `...[truncated]`.

The `@herobids/llm` boundary does not truncate message/tool content (`packages/llm/src/llm-provider.ts:63`, `599-603`), so the only truncation is the one in the tool loop.

### Scope: the truncation does not discriminate by tool

The stale-truncation block applies to **every** tool result equally — it keys only on `age` and `content.length`, never on the tool name. The real problem is that some tool results are **durable instructions / state** the agent must keep following, and those must not be silently deleted, whereas most tool results are transient data that is fine to shrink.

Tool messages are emitted in the same file with `toolName` and `addedAtTurn` already set (`structured-tool-loop.ts:173-180`), so the tool name is available at the point a result enters the message list.

### Related history (read)

- **Prior bug reports:** `grep` across `docs/bug-reports/` for truncation / tool-result / skill-loading turns up only skills-**table** truncation reports (`2026/06/08/001-skills-truncated-before-e2e.md`, `2026/06/08/002`, and the 06/09–06/18 follow-ups) and a portfolio-context-block issue (`2026/10/05/006`). **No earlier report covers the stale tool-result truncation or a loaded skill being cut off.** This is new.
- **`git log` — `apps/worker/src/structured-tool-loop.ts`:** the truncation logic was introduced by `5a8f2e7b feat(llm): implement stale tool result truncation in structured tool loop`. Later commits on the file (`ca3bf27d`, `65e8cb58` LLM billing/optimisation; `2fde6d16` skillOps / per-turn tool getter) did not change the truncation rule. So the defect has been present since `5a8f2e7b`.
- **`git log` — `apps/worker/src/tools/read-skill.ts`:** `fde57c00` (Phase 4 T5–T7) added `read_skill` + progressive disclosure; `cd241243`, `f03e5c6c`, `2e005613` refined skill/connection handling and kept backend tools after install. The tool has always returned the full body as `data.instructions`; nothing there shrinks it. The interaction is purely between `read_skill`'s full-body result and the loop's blind truncation.

### Why it was not seen earlier

- The truncation is silent (no log line), so nothing in a run points at it. It only surfaces as downstream "the agent did not follow the skill" behaviour, which is easy to misread as a model/prompt problem.
- It only bites when the agent stays in a single tool loop for more than `toolResultFullRetentionTurns` turns after loading a large skill, and then relies on the tool result rather than the re-injected system-prompt copy. Short loops, or agents that re-read the skill each tick, never hit it.
- Small skills (under `toolResultMaxStaleChars`) are never truncated, so the problem is invisible until a large skill like `job-search` (15665 bytes, ~15.3 KB) is used.
- The system-prompt re-injection path makes the body look present on later ticks, masking that the same-tick tool result was gutted.

## Fix

> OPEN — the code lands in a separate task. Planned approach:

Add a message-level **pin** flag on tool messages so durable tool results are exempt from stale-truncation:

1. Add an optional `pinned?: boolean` to the `tool` message variant of `LlmMessage` (`packages/llm/src/llm-provider.ts:63` — the `role: 'tool'` line), alongside the existing `addedAtTurn`.
2. In the stale-truncation block (`structured-tool-loop.ts:84-93`), skip any message with `pinned === true`.
3. At the tool-message emit site (`structured-tool-loop.ts:173-180`), set `pinned: true` when `toolCall.name` is one of the durable tools.

**The 6 durable tools to exempt** (verified registered tool names):

| Tool | File | Why durable |
|---|---|---|
| `read_skill` | `apps/worker/src/tools/read-skill.ts:169` | Full skill instructions the agent re-reads and acts on |
| `load_skill` | `apps/worker/src/tools/load-skill.ts:66` | Add + load a skill in one call — same full-instructions payload |
| `read_app_docs` | `apps/worker/src/tools/platform-docs.ts:287` | Full content of a documentation page or schema |
| `get_schema` | `apps/worker/src/tools/schema.ts:13` | JSON Schema the agent builds payloads against |
| `read_agent_document` | `apps/worker/src/tools/agent-documents.ts:14` | Full text of a user-sent document |
| `get_message` | `apps/worker/src/tools/conversation-read.ts:103` | Full-text escape hatch for a message `get_thread` cut short |

**Rationale:** these return durable instructions / schemas / full documents / the full-text escape-hatch message that the agent re-reads and acts on. Everything else — web / search / http / code / exec / list results — is transient data that stays truncatable and typically has its own byte budget or a cheap re-fetch path, so it should keep shrinking. There are **76 distinct registered agent tools** in total; only these 6 carry durable, must-follow output.

## Files Changed

> OPEN — to be filled when the fix lands. Expected:

- `packages/llm/src/llm-provider.ts` — add `pinned?: boolean` to the `tool` message variant.
- `apps/worker/src/structured-tool-loop.ts` — skip pinned messages in the stale-truncation block; set `pinned` on emit for the 6 durable tools.
- `CHANGELOG.md`

## Verification

> To be completed when the fix lands (this report is OPEN). Will cover: a loaded large skill (`job-search`, 15665 bytes / ~15.3 KB) survives a long tool loop intact while a transient tool result in the same loop is still truncated; `pnpm lint`; and a re-run of the `job-searcher` agent confirming it creates the durable-state files (search ledger / run-state / report-state) and sets up the required persistent storage and schedules before running discovery.

## Outstanding Issues

Low-severity, non-blocking (recorded during review of the bug-report draft):

- **[Bug report] Line-citation precision.** The per-tier `toolResultMaxStaleChars` citations (`schema.ts:335-336`, `364-365`, `393-394`) bracket the correct region but are off by ~1 line; the `toolResultMaxStaleChars` values sit at 335 / 364 / 393 and the `toolResultFullRetentionTurns` lines precede them (334 / 363 / 392). All quoted values are accurate; the ranges are cosmetic.
- **[Bug report] Tool-count figure.** "76 distinct registered agent tools" is sourced from `TOOL_CATALOG` in `packages/domain/src/tools.ts` (asserted against the live registry); it is not load-bearing for the fix, which names the 6 durable tools explicitly.
