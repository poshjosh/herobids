# Plan: Prompt Coordination Without Templates

Date: 2026-06-11

---

## Overview

Fix prompt drift by making the worker the single prompt-composition authority, keeping the stored agent prompt as pure user intent, and moving tool-level prompt guidance closer to the live tool definitions.

This plan deliberately does not start with template files. The immediate problem is not lack of templating; it is that prompt content is assembled from multiple sources that can drift:

- web create flow appends operator metadata into the stored prompt
- worker prompt builder adds more runtime metadata and skill prose
- skill prose can describe tool arguments that the live tool schema does not expose

The target state is:

1. `agents.prompt` stores only the user objective
2. the worker composes the final runtime prompt from typed sections
3. operator metadata is rendered once, from runtime state, not embedded in the goal
4. tool guidance is sourced from the tool catalog or another shared prompt metadata surface, not duplicated ad hoc in skill text
5. prompt snapshots catch drift quickly in tests

---

## Dependency Graph

```text
Step 1 (shared goal normalization)
	-> Step 2 (web stores pure user goal)
		-> Step 3 (UI stops parsing operator context from prompt text)

Step 1
	-> Step 4 (worker prompt builder uses normalized goal and typed sections)
		-> Step 5 (tool guidance single source)
			-> Step 6 (task/reminder policy block)
				-> Step 7 (compiled prompt tests and preview hardening)
```

---

## Steps

### Step 1 - Introduce shared goal normalization for legacy prompts

Files:

- `apps/web/src/features/agents/agent-display.ts`
- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/scout-dispatch.ts`
- `packages/domain/src/` new shared helper file, for example `agent-goal.ts`

Changes:

1. Create a shared helper that extracts the canonical user goal from stored prompt text.
2. Support current and legacy prompt shapes by stripping the `Operator context:` suffix when present.
3. Use that shared helper in the worker prompt builder so legacy agents do not continue leaking operator metadata into `## Your Goal`.
4. Use the same helper in the scout prompt path so judge and scout see the same normalized goal.
5. Repoint existing web prompt-display helpers to the shared semantics or remove duplicate parsing logic if the helper can be consumed there.

Why first:

- This is the cheapest compatibility layer.
- It lets newer prompt assembly changes coexist with already-created agents whose stored prompt is polluted.

Risk:

- Existing prompts may contain user-authored text that literally includes `Operator context:`. The helper should only strip the marker when it matches the app-generated structure.

---

### Step 2 - Make the web create and edit flows store only pure user intent

Files:

- `apps/web/src/features/agents/AgentsPage.tsx`
- any edit-agent form helpers that reuse or mirror `buildPrompt`

Changes:

1. Replace `buildPrompt(...)` with a helper that returns only `intent.goal.trim()`.
2. Stop appending selected skills, trading binding, and risk tolerance into the stored prompt string.
3. Keep operator metadata in structured fields already owned elsewhere in the agent record, such as `skillIds`, execution mode, readiness, and trading bindings.
4. Confirm create and edit flows preserve backward compatibility for existing agents by leaving old prompt rows untouched while new saves write only the pure goal.

Dependency:

- Depends on Step 1 so the worker and UI can still render old records safely.

Open question:

- If any downstream workflow depends on the embedded `Operator context:` text, identify it before removing the write path. The current known consumer is the web display layer.

---

### Step 3 - Move operator-context rendering out of prompt parsing and into structured UI derivation

Files:

- `apps/web/src/features/agents/agent-display.ts`
- `apps/web/src/features/agents/AgentDetailPage.tsx`
- `apps/web/src/features/agents/AgentSummaryCard.tsx`
- any other agent UI surfaces that call `extractAgentOperatorContext(...)`

Changes:

1. Stop treating the prompt string as the source of operator metadata.
2. Derive display context from the actual agent record: selected skills, capability families, readiness, execution mode, and trading binding data already available from the API.
3. Retain legacy prompt parsing only as a temporary fallback for older rows if necessary.
4. Keep `extractAgentObjective(...)` focused on user intent only, with the shared normalization from Step 1.

Why this matters:

- As long as the UI keeps parsing operator context from the prompt field, the web layer will continue encouraging prompt-as-database behavior.

Risk:

- Some detail-page copy may need to be restructured because not all operator-context strings map one-to-one to current API fields.

---

### Step 4 - Refactor worker prompt composition into typed sections with one authority

Files:

- `apps/worker/src/runtime-composition.ts`
- optionally a new file such as `apps/worker/src/prompt-sections.ts`
- `apps/worker/src/prompt-timing-context.ts`

Changes:

1. Introduce an internal typed prompt-section model, for example:
	 - goal
	 - operating context
	 - tool guidance
	 - guard rails
	 - runtime context
2. Move `buildSystemPrompt(...)` away from direct string concatenation toward section assembly plus one final renderer.
3. Ensure `## Your Goal` uses normalized user intent only.
4. Remove duplicate goal and operator-context restatement from `## Runtime Context` where it adds no unique information.
5. Keep `Core Platform` facts that are genuinely runtime-scoped, such as agent ID, visible tools, and budgets, but avoid repeating data already rendered prominently above.

Dependency:

- Depends on Step 1.

Design constraint:

- This is not a template-file system. It is a typed renderer with one code path.

---

### Step 5 - Make tool guidance come from a shared source with the live tool catalog

Files:

- `packages/domain/src/tools.ts`
- `apps/worker/src/tools/registry.ts`
- `apps/worker/src/tools/messaging.ts`
- `apps/worker/src/tools/tasks.ts`
- `packages/domain/src/skills.ts`

Changes:

1. Extend the worker tool model with prompt-facing metadata, for example `promptGuidance`, `usageNotes`, or a similar field that can be rendered safely alongside the actual schema.
2. Keep argument-level semantics near the tool implementation instead of only in skill prose.
3. Update `send_message` guidance so the prompt no longer claims support for fields that the exposed schema does not currently provide.
4. Reduce `SkillDefinition.instructions` to capability-level guidance and workflow advice, not parameter-level truth that can drift.
5. Render tool guidance in the prompt from the visible tool definitions selected by the registry.

Key mismatch to resolve in this step:

- `packages/domain/src/skills.ts` tells the model to set `messageClass` and `emailDelivery`
- `apps/worker/src/tools/messaging.ts` currently exposes only `body` and `subject`

Open question:

- Decide whether to expose `messageClass`, `emailDelivery`, and `contextRef` through the live `send_message` tool schema, or remove those instructions from prompt guidance for now. The plan should not assume that expanding the schema is always the right answer.

---

### Step 6 - Add a small prompt policy block for reminder and task-management agents

Files:

- `packages/domain/src/skills.ts`
- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/runtime-composition.test.ts`

Changes:

1. Use existing `promptRendererHints` to drive a reminder/task-specific instruction block.
2. When `schedule_reminder` is visible, add concise execution rules such as:
	 - prefer `schedule_reminder` over `create_task` for one-shot reminders
	 - when reminder context is present, send the reminder message once and do not reschedule blindly
	 - if the target time is already passed, act immediately rather than attempting to schedule in the past
3. Keep the block short and deterministic so it behaves like policy, not narrative fluff.

Dependency:

- Depends on Step 4 and Step 5 so the block sits inside the centralized renderer and does not duplicate tool semantics.

Risk:

- Natural-language time parsing is still model-dependent unless a later follow-up adds explicit deadline normalization. This step should improve behavior without taking on a full goal-parsing project.

---

### Step 7 - Add compiled prompt snapshots and prompt-preview checks

Files:

- `apps/worker/src/runtime-composition.test.ts`
- `apps/worker/src/scout-dispatch.test.ts`
- `apps/web/src/features/agents/` tests for prompt storage and display helpers
- optionally `apps/api/src/routes/agent-interactivity.test.ts`

Changes:

1. Add focused tests for the compiled personal-assistant prompt and a trading prompt.
2. Assert that:
	 - the goal block contains only normalized user intent
	 - operator context is not embedded in stored prompt text for new agents
	 - runtime context does not repeat the same metadata unnecessarily
	 - visible tool guidance matches the live schema-backed catalog
3. Add a regression test for legacy prompts that still contain `Operator context:` to prove normalization works.
4. Verify the compiled prompt returned by `GET /agents/:id/prompt` remains readable and reflects the refactored builder when the agent is running.

Why this is required:

- Without snapshot-style coverage, prompt drift will reappear quietly.

---

## Risks And Open Questions

1. Legacy prompts already stored in the database may contain embedded operator metadata. The plan assumes compatibility handling in the worker and UI, not a mandatory data migration.
2. `send_message` currently has broker/protocol support that is richer than the exposed tool schema. Decide whether prompt truth should move toward the schema or the schema should expand toward the broker contract.
3. The UI may need a new explicit operator-context summary component because it can no longer rely on parsing human-readable metadata out of the prompt string.
4. Reminder-time normalization is still a separate concern from prompt coordination. This plan improves prompt behavior, but a full deadline parser may belong in a later feature if reminder goals remain important.
5. If any non-web writer stores prompt text with operator metadata, it must be removed or normalized too; this plan currently targets the known web create flow.

---

## Test Strategy

### Unit tests

- `apps/worker/src/runtime-composition.test.ts`
	- normalized goal rendering
	- no duplicate operator context in compiled prompt
	- task/reminder policy block appears only when relevant
- `apps/worker/src/scout-dispatch.test.ts`
	- scout prompt uses normalized goal
- `apps/web/src/features/agents/` tests
	- create flow stores pure user goal
	- detail and summary surfaces derive operator context from structured agent data, not from the prompt
- tool registry or tool metadata tests
	- prompt guidance generation stays aligned with visible tools

### Integration tests

- API or worker integration coverage for `GET /agents/:id/prompt`
	- compiled prompt reflects the centralized renderer
	- legacy stored prompt still compiles to a clean goal block

### Manual verification

1. Create a new personal-assistant agent and confirm the database `prompt` field stores only the user objective.
2. Start the agent and inspect `GET /agents/:id/prompt` to confirm a single operator-context rendering path.
3. Compare a running prompt before and after the refactor for a reminder agent and confirm the drift points are removed.

---

## Recommended Execution Order

1. Step 1 - shared goal normalization
2. Step 2 - store pure goal from the web flow
3. Step 3 - UI structured operator context
4. Step 4 - centralized typed prompt sections in the worker
5. Step 5 - shared tool guidance source
6. Step 6 - reminder/task policy block
7. Step 7 - tests and preview checks

This order fixes the ownership boundary first, then centralizes assembly, then removes schema drift, and only after that adds task-specific guidance.
