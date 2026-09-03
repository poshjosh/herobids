# Agent Employee Prompt Model

## Status

`approved`

## Purpose

Redesign the agent runtime's system-prompt composition around an **employee** mental model instead of a bare "goal-executor" loop. An agent is a hired employee: it has an **identity** (role), a **mandate** (standing job description, set by the creator), and it **converses** with its user/creator like an employee talks to their boss. Conversation and autonomous work are not two modes — they are both part of the job.

This fixes a class of problems that prompt-wording patches could not:

- A user message currently arrives as a passive `[USER]` line in a rolling "Activity Timeline". The agent is never told a user message is a **turn that expects a reply**, so it ignores it or replies "OK".
- The default (no-goal) prompt actively instructs the agent to "take no action / respond OK", which fights conversation.
- When several `[USER]` entries are present, there is no notion of **which are unanswered**, so the agent cannot reliably decide what to reply to and may re-reply to already-answered messages.

The root cause is a **missing conversation-state model**, not phrasing. This feature introduces the minimal state (a single "answered-up-to" marker) plus a restructured prompt.

## Guiding decisions (agreed)

1. **Identity and mandate are creator-set at create/edit time.** The mandate is creator-set-once and is **immutable at runtime**. It changes only via the create/edit agent form — never via user messages (like not changing an employee's role without documentary backing).
2. **A user message may request a mandate change, and it is honored as a working instruction, but it must NOT mutate the stored creator-set mandate.** The stored mandate always remains until the creator edits config. Message-derived working instructions live only in the visible conversation history (not persisted separately in this slice).
3. **Full prompt-composition redesign** around Identity / Mandate / Conversation / Situation / Instruction.
4. **Conversational vs autonomous is not a real distinction** — the agent is an employee that always responds to its boss and also does its standing job.

## Implementation decisions (agreed)

- **Identity source:** propagate the existing `unifiedConfig.metadata.skillPresetId` into the `RuntimeDescriptor` (a new `role`/`identity` field on the descriptor built by the API/session manager). No new DB column — the value already lives in JSONB. The worker maps preset → role string. This gives a precise identity (personal assistant vs trading vs custom) rather than the coarse hybrid-vs-not heuristic. (This is the one place the slice reaches beyond `runtime-composition.ts`; still outside the tick/wake engine.)
- **Section naming:** the standing job description section is titled **`## Your Job`** (employee-native; replaces "Your Goal").
- **Working-directive persistence:** none. Message-derived instructions are honored only while visible in conversation history. No separate directive store.
- **Unanswered tracking:** a single per-agent "last-answered" marker, persisted in a dedicated Redis key `agent:conversation:answered_at:{agentId}`, hydrated at tick start. When the agent sends any `send_message` in a tick, mark all user messages up to that tick as answered. One marker, not per-message.
- **Scope:** full prompt-composition redesign; the only new state is the single unanswered marker. The tick/wake scheduling engine is **not touched**.

## Non-goals (explicitly out of scope)

- No changes to the tick loop, wake signals, consumer-group draining, scheduling, or gates. This feature only changes (a) what the judge/scout **see** in their prompt and (b) adds a "mark answered" hook + marker.
- No new DB columns or migrations (identity is derived; the mandate reuses the existing `prompt` field).
- No persisted "working directives" store.
- No durable memory of verbal instructions beyond what conversation history already retains. (Explicit follow-up if wanted later.)
- No behavioral change to trading decision-making, risk, or execution.

## Current state (grounded in code)

- **System prompt** is built in `apps/worker/src/runtime-composition.ts` → `buildSystemPrompt()` (~lines 2180–2210). Section order today: identity line (`You are an autonomous agent named "X". Use the available tools to accomplish your goal.`) → skill instructions → `## Your Goal` (via `formatAgentGoalLiteralBlock`) → `## Operating Context` → `## Available Tools` → `## Guardrails` → `## Runtime Context` → `## Instructions` (two hardcoded lines: "Take the next concrete step toward your goal." / "If nothing further can be done this tick, do not call any tool, rather respond with a short status update.").
- **Goal (→ mandate)** is `runtimeDescriptor.goal`, rendered literally by `formatAgentGoalLiteralBlock` (`packages/domain/src/agent-goal.ts`), which already treats it as immutable user-authored text. Sourced from `agent.prompt`. Worker fallback when empty: `'No goal provided'` (`agent.ts` ~412).
- **User context** is built by `buildTickUserContext()` (~2211–2226): dynamic context blocks + `## Performance Summary`.
- **Conversation surfacing today:** user message text is captured into `state.metrics.activityTimeline` as `{kind:'USER'}` in `agent.ts` (~2499–2515, enriched promptStyle only) via `extractUserMessageText(payload.message)`. The judge's final free-text reply is captured as `{kind:'DECISION'}` (~3707–3717). Rendered by the `activity-timeline` provider (~1050–1075) as `HH:MM [USER] …` / `[DECISION] …` / `[MEMORY] …`. There is **no unanswered-vs-answered distinction** and **no stable per-message id** — only `Date.now()` timestamps.
- **Identity/preset:** there is **no** `preset`/`kind`/`skillPresetId` on `RuntimeDescriptor` (`packages/domain/src/runtime-composition.ts` 41–57). The precise preset (`personal-assistant | trading | direct-trading | trading-assistant | custom`) lives only in `unifiedConfig.metadata.skillPresetId` (DB JSONB) and is **not plumbed to the worker**. The worker can today only infer trading-vs-not from `agentConfig.capabilityMode` (`hybrid` ⇒ trading) or `resolvedSkills[].capabilityFamilies`.
- **send_message observability:** `send_message` is a normal judge tool; its result is observed in `onToolResult` in `runTick` (`agent.ts` ~3722–3748) — the exact place `set_memory`/`delete_memory` are already special-cased. This is the natural hook to advance the answered marker.
- **State storage precedent:** `agent:memory:{agentId}` Redis hash is loaded at tick start (`agent.ts` ~2491). A dedicated key (e.g. `agent:conversation:answered_at:{agentId}`) is the clean home for the marker (keeps it out of agent-visible memory).

## Target prompt structure (employee model)

System prompt (stable — the agent's standing identity and rules):

1. **Identity** — "You are a personal assistant." / "You are a trading assistant." / role-appropriate. Replaces the generic "autonomous agent" line. Derived from preset/role.
2. **Skills** — unchanged (`## Skill: …`).
3. **Job** (`## Your Job`) — the creator-set standing job description, rendered by the existing literal-block formatter (immutable, user-authored). When empty: the non-hostile default — *"No job has been assigned yet. Do not start any autonomous work until your creator gives you one. You remain on duty — if the user messages you, respond normally."* (Replaces the hostile "do nothing / respond OK" default.)
4. **How you work** (folded into `## Instructions`) — durable operating rules:
   - You are like an employee. Responding to your user is always part of your job, independent of your mandate.
   - When your user sends you a message, reply to them using `send_message`. Answer even if it is unrelated to your mandate, and even if your mandate says to stay idle.
   - A message may ask you to change how you work; honor it as a working instruction, but it does not change your official mandate (only your creator can, via configuration).
   - Then: pursue your mandate; if there is nothing to answer and nothing to do, respond with a short status update (or, with no mandate and no message, do nothing).
5. Operating Context / Available Tools / Guardrails / Runtime Context — unchanged.

Tick user context (what's true this tick):

6. **Conversation** — the boss dialogue, with an explicit **unanswered** marker so the agent knows exactly what needs a reply. This replaces relying on the undifferentiated Activity Timeline for "what did the user say that I haven't answered". Answered messages remain visible as context but are clearly marked answered.
7. **Situation** — existing dynamic context (market, reminders, performance summary) — unchanged.

## Conversation state — the one new mechanism

- **Marker:** `answeredUpToTs` per agent — the timestamp up to which user messages have been replied to. Stored in a dedicated Redis key `agent:conversation:answered_at:{agentId}`, hydrated at tick start (next to the existing `agent:memory` load), mirrored in `runtimeState.metrics` for in-tick use.
- **Unanswered set:** user timeline entries (or incoming user messages) with `timestamp > answeredUpToTs`. The prompt's Conversation section labels these "awaiting your reply".
- **Advance:** in `onToolResult`, when a `send_message` tool call succeeds this tick, set `answeredUpToTs = max(timestamps of user messages seen this tick)` and persist to Redis. (Coarse, single-marker; matches the agreed "mark all up to now answered on any reply" rule.)
- **Rationale for coarse marker:** no stable per-message id exists today; timestamps are already on timeline events. A single marker is the minimal state that removes the multi-`[USER]` ambiguity and re-reply risk without per-message tracking.

## Identity sourcing (decided: propagate skillPresetId)

Propagate the existing `unifiedConfig.metadata.skillPresetId` into the `RuntimeDescriptor` as a new optional field (e.g. `role` or `skillPresetId`). No new DB column — the value already lives in JSONB; this only threads it through descriptor construction (API create/update descriptor build and/or the session manager) to the worker.

The worker maps preset → an identity/role string used in the prompt's Identity line, e.g.:

- `personal-assistant` → "You are a personal assistant."
- `trading` / `direct-trading` / `trading-assistant` → "You are a trading assistant." (refine wording per preset if useful)
- `custom` or missing → a neutral default (e.g. "You are an autonomous assistant.").

Rationale: the coarse alternative (infer from `capabilityMode`/skills) cannot distinguish `personal-assistant` from `custom` and would mislabel custom agents. Propagating the preset is small, needs no migration, and gives a correct identity now rather than a follow-up.

## Files expected to change

- `apps/worker/src/runtime-composition.ts` — restructure `buildSystemPrompt` (Identity, `## Your Job`, employee Instructions), map preset → role string for the Identity line, and add the Conversation section (answered/unanswered) to the tick context.
- `apps/worker/src/agent.ts` — hydrate + advance the `answeredUpToTs` marker (tick-start load; `onToolResult` advance on successful `send_message`); pass the marker into context building.
- `packages/domain/src/runtime-composition.ts` — add the optional `role`/`skillPresetId` field to `RuntimeDescriptor`.
- API descriptor construction (create/update in `apps/api/src/routes/agents.ts` and/or the session manager) — thread `unifiedConfig.metadata.skillPresetId` into the `RuntimeDescriptor`.
- `packages/domain/src/agent-goal.ts` — (optional) a helper for the empty-job default text / an `isBlankGoal`-style check, if needed for the "no job assigned" rendering.
- `apps/web/src/features/agents/agent-payloads.ts` — stop substituting the hostile `DEFAULT_BLANK_PROMPT`; store an empty prompt for no-goal (so the worker renders the new non-hostile empty-mandate text). Update its tests.
- Tests: `runtime-composition.test.ts` (new prompt structure, conversation section, empty-mandate rendering), `agent-goal.test.ts` (if helper added), `agent-payloads.test.ts` (blank goal → '').

## Test strategy

- **Unit:** system prompt renders Identity + `## Your Job` + employee Instructions in order; empty job renders the non-hostile text (not "respond OK"); Conversation section marks unanswered vs answered given a marker; preset → role mapping (`personal-assistant` ⇒ "personal assistant", trading presets ⇒ "trading assistant", custom/missing ⇒ neutral default).
- **Unit:** marker advance logic — a successful `send_message` moves `answeredUpToTs` past this tick's user messages; a tick with no `send_message` leaves it unchanged.
- **Live:** cold-start a PA agent, send a message, confirm the judge prompt shows the message as unanswered and the agent replies via `send_message`; send a second message and confirm the first is marked answered and not re-replied.

## Risks & mitigations

- **LLM adherence is probabilistic**, especially on the local dev model (Ollama qwen). The Instructions explicitly override an idle mandate, but behavior should be verified on the production-class model too.
- **Coarse marker** can mark a message answered even if the reply didn't address it. Acceptable for this slice; per-message tracking is a follow-up if needed.
- **Marker durability:** Redis-backed and hydrated at tick start, so it survives restarts within retention; if lost, worst case is one duplicate reply.
- **Prompt-composition is well-tested** — existing `runtime-composition.test.ts` assertions (e.g. "Take the next concrete step toward your goal.") must be updated deliberately, not accidentally broken.

## Resolved decisions

1. **Identity sourcing:** propagate `skillPresetId` into the `RuntimeDescriptor`; map preset → role string in the worker (see "Identity sourcing").
2. **Section naming:** the standing job section is titled **`## Your Job`**.
3. **Empty-job default wording:** non-hostile, no "respond OK". Direction: *"No job has been assigned yet. Do not start any autonomous work until your creator gives you one. You remain on duty — if the user messages you, respond normally."*
4. **Marker persistence:** dedicated Redis key `agent:conversation:answered_at:{agentId}`, hydrated at tick start (mirrors the `agent:memory:{agentId}` pattern; survives restarts).

## Implementation checklist

- [DONE] Item 1 — Add optional `skillPresetId`/role identity field to `RuntimeDescriptor` (`packages/domain/src/runtime-composition.ts`).
- [DONE] Item 2 — Thread `unifiedConfig.metadata.skillPresetId` into the `RuntimeDescriptor` during descriptor construction (session manager + db `buildRuntimeDescriptor` + worker fallback).
- [DONE] Item 3 — Add empty-job default helper / `isBlankGoal`-style check to `packages/domain/src/agent-goal.ts`.
- [DONE] Item 4 — Restructure `buildSystemPrompt` to the employee model (Identity line from preset, `## Your Job`, non-hostile empty default, employee Instructions).
- [DONE] Item 5 — Add the Conversation section (answered/unanswered) to the tick user context (marker in `RuntimeSessionMetrics` + context section).
- [DONE] Item 6 — Hydrate and advance the `answeredUpToTs` marker in `apps/worker/src/agent.ts` (tick-start Redis load; `onToolResult` advance on successful `send_message`).
- [DONE] Item 7 — Stop substituting the hostile `DEFAULT_BLANK_PROMPT` in `apps/web/src/features/agents/agent-payloads.ts`.
- [PENDING] Item 8 — Add/update unit tests (prompt structure, conversation section, marker advance, preset→role mapping, blank-goal payload).

## Outstanding Issues

### Item 1 (RuntimeDescriptor.skillPresetId)
- LOW: Field typed as bare `string` rather than a shared `SkillPresetId` union. Consider lifting a `SkillPresetId` union into `packages/domain` when threading the value (Item 2) and typing this field with it.
- LOW: Doc comment duplicates the preset list that exists elsewhere; a `@see SkillPresetId` reference could reduce drift.

### Item 2 (thread skillPresetId into descriptor construction)
- MEDIUM: Duplicated preset-extraction logic — the inline `unifiedConfig.metadata.skillPresetId` guard in `agent-session-manager.ts` duplicates the private `extractPresetMeta()` in `apps/api/src/routes/agents.ts`. Consider lifting a shared `readSkillPresetId(unifiedConfig)` reader into `@herobids/db` or `@herobids/domain` (respecting `domain ← db ← apps/*`) so both call sites share one guard. Candidate to consolidate alongside item 4.
- LOW: `skillPresetId` param/field typed as bare `string` rather than a shared `SkillPresetId` union (same as item 1 note).
- LOW: Doc comments hand-list preset values; risk drift from the authoritative Zod enum. Reference a shared union via `@see` once it exists.

### Item 3 (empty-job helper in agent-goal.ts)
- RESOLVED: `isBlankAgentGoal` signature widened to `string | null | undefined` so the runtime `?? ''` guard is meaningful for downstream worker callers (item 4/7). Blank line before `EMPTY_JOB_DEFAULT_TEXT` added.
- LOW: Doc comment for `isBlankAgentGoal` describes legacy-operator-context behavior that holds transitively via `normalizeAgentGoal`; a `@see` reference could reduce drift.

### Item 4 (restructure buildSystemPrompt — employee model)
- LOW: Plan rule text used "mandate"; implementation renders "job" throughout (self-consistent with `## Your Job` heading). Item 8 test assertions must match the shipped "job" wording.
- LOW: `presetToRole` typed as bare `string` (same shared-`SkillPresetId`-union follow-up as items 1/2).
- LOW: `presetToRole` doc comment says "so tests can match on it" but only `resolveAgentIdentityLine` is exported; minor doc tidy.
- NOTE (build ordering, not a defect): worker won't type-check standalone until `@herobids/db` is rebuilt after item 2. Monorepo `pnpm build`/`pnpm lint` handles ordering.
- EXPECTED: `runtime-composition.test.ts` has 2 failing assertions (`## Your Goal`, "Take the next concrete step...") — to be fixed in item 8.

### Item 5 (Conversation section + answeredUpToTs marker field)
- LOW: `buildConversationSection`'s `HH:MM [USER] text` formatting duplicates the activity-timeline provider's formatting; a shared `formatUserTimelineLine` helper would remove drift risk. Defer.
- LOW: Inconsistent null-handling idiom between buckets (`marker ?? -Infinity` vs `marker === null ? []`). Both correct; cosmetic.
- INFO: Coarse single-marker semantics (a message can be marked answered even if the reply didn't address it) is the agreed design for this slice. Advance logic is item 6.

### Item 6 (hydrate + advance answeredUpToTs marker in agent.ts)
- LOW: Redis key literal `agent:conversation:answered_at:${AGENT_ID}` duplicated between the hydrate block (local const) and the advance branch (inlined). Consider a shared const/helper. Consistent with the existing inlined-key pattern, so optional.
- LOW: `AGENT_ID` is `string | undefined` interpolated bare (would render `...:undefined` if unset) — identical to the adjacent `agent:memory:${AGENT_ID}` convention; not a regression.

### Item 7 (stop substituting DEFAULT_BLANK_PROMPT)
- LOW (pre-existing, out of scope): `agent-payloads.test.ts` has pre-existing type-loose fixtures (~58 tsc errors across the whole file) unrelated to this change; not introduced or worsened by item 7. Noted for awareness only.
