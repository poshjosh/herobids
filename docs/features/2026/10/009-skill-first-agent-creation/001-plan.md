# 009 — Skill-first agent creation (guided chat + form reorder)

**Date:** 2026-10-02. **Status:** plan (ready to implement).
**Owner decisions:** recorded inline as **D0–D8**. No open questions remain.

## For the implementing agent (read first)

You can execute this plan without prior conversation context. Rules:

- **Line numbers are indicative, not exact** (`~line NNN`). The code may have
  drifted. ALWAYS locate targets by the named symbol/string (e.g.
  `GREETING_CONTENT`, `buildBaseHeader`, `CreateAgentFlow`,
  `resolveSuggestedSkillIds`), not by line number.
- **Scope guardrails — do NOT touch:**
  - `SkillPicker.tsx` or its behavior (D6).
  - The `/skills` API route / endpoint, and the `list_available_skills` tool
    handler (stays internal-only, D2).
  - Any of the four chat prompt builders beyond the specific edits in A1/A4.
    (`detectPresetFromContent` IS removed — but only per A3, and only after the
    grep confirms no other caller.)
  - The agents DB schema (the preset is throwaway chat metadata — D0).
- **Git:** herobids is **local-only — never push.** Commit locally in logical
  units. Do not modify git config or use `--force`/`--amend` on pushed commits.
- **Verification commands (run from repo root `herobids/`):**
  - Typecheck/lint: `pnpm lint`  (this is `tsc --noEmit`)
  - Web build: `pnpm --filter @herobids/web run build`
  - Web unit tests: `pnpm --filter @herobids/web exec vitest run`
  - API unit tests: `pnpm --filter @herobids/api exec vitest run`
    (or target a file: `… exec vitest run src/routes/chat.test.ts`)
  - Full suite + e2e: `scripts/shell/tests/run-all-tests.sh --e2e`
- **E2E needs the full stack** (Postgres + Redis + API + web + boundary) brought
  up by the wrapper script above. If the stack cannot be started in your
  environment, run everything else, then **report** that e2e was not run — do NOT
  fake or skip-assert it.
- When a step says "grep before deleting," do the grep and act on real results;
  do not assume.
- Keep the `AGENTS.md` conventions (ESM, strict TS, no `any`/`@ts-ignore`,
  Result-style error handling where the codebase already uses it).

## Goal

Make agent creation **intent-first**, consistent with the already-adopted
principle that agent identity derives from skills, not a "type" (DECISIONS
P2-2). Two independent-but-related changes:

1. **Guided chat:** drop the "What kind of agent?" question and its two preset
   buttons. The greeting asks what the user wants; a short LLM classifier picks
   the preset (`trading` / `personal-assistant` / `custom`) from the first
   message and writes it to the existing thread metadata. Skills are resolved
   from the user's intent and disclosed only on the final confirmation summary.
   **The existing
   preset mechanism and prompt builders are kept — this is additive, not a
   rewrite.**
2. **Create/Edit form:** put the objective/prompt input **first**, and remove
   the create form's "Suggested skills" dropdown (a disguised type selector).

## Decisions (locked)

- **D0.** Preset is auto-selected (not asked). Keep the existing preset
  mechanism + four prompt builders; replace the greeting buttons with a short
  temperature-0 LLM classifier that maps the first user message to `trading` /
  `personal-assistant` / `custom`, written to `thread.metadata.summary.preset`
  before prompt selection (order-safe). A tool was rejected (would resolve a turn
  late). The preset is throwaway chat metadata — NOT persisted on the agent.
- **D1.** Guided chat resolves skills on the user's behalf — the LLM keeps
  calling `list_available_skills` and picks; it does NOT ask the user to choose
  skills or enumerate them in prose. (Owner: option "a".)
- **D2.** `list_available_skills` stays **internal-only** — no external/unified
  mode in the chat tool (keeps the create path fast; external search is a 10s
  third-party call, unsuitable for the LLM turn loop). (Owner: "No, at least for
  now.")
- **D3.** If no internal skill clearly matches the intent, **skip the skill step
  entirely** — the agent can load skills (internal or external) dynamically at
  runtime.
- **D4.** The **confirmation summary still lists** the resolved skills (for
  transparency/editability) — disclosed, never asked. (Owner: "Keep in summary".)
- **D5.** `create_agent` is called with `skillPresetId: 'custom'` + the resolved
  internal `skillIds`.
- **D6.** The form's `SkillPicker` and its merged internal+external search are
  **NOT touched** — skills in the form remain optional and as-is. (Owner: "Don't
  touch the form with respect to skills.")
- **D7.** Objective/prompt moves to the **top** of both the create and edit
  forms; the create form's "Suggested skills" dropdown is **removed** (with its
  dead code + i18n keys).
- **D8.** Trading/PA guidance in the chat is relocated into **conditional
  sub-sections** keyed off resolved skills, not a preset token. No trading copy
  surfaces unless a trading skill is resolved.

## Current state (verified, with references)

### Guided chat is backend-LLM-driven
- Web (`apps/web/src/features/chat/useGuidedSetup.ts`,
  `GuidedSetupPanel.tsx`) only renders messages/`actions` returned by the API.
  The frontend renders exactly three action types (`GuidedSetupActionRenderer.tsx`):
  `quick_replies`, `form`, `confirm`. **There is no skill-selection action** —
  so resolving skills on the user's behalf needs no new frontend action type.
- All flow logic is in `apps/api/src/routes/chat.ts`:
  - `GREETING_CONTENT` (line ~101) = "Hi! I can help you create an AI agent.
    What kind of agent are you looking for?"
  - `GREETING_ACTIONS` (line ~108) = two quick-reply buttons:
    `preset:personal-assistant`, `preset:custom`.
  - `detectPresetFromContent()` (~736) extracts a `preset:*` token from a short
    reply and persists it to `thread.metadata.summary.preset`.
  - System-prompt selection (~1642): `preset === 'trading' ? buildTradingPrompt
    : 'personal-assistant' ? buildPersonalAssistantPrompt : 'custom' ?
    buildCustomPrompt : buildBasePrompt`.
  - `buildBasePrompt` (~247) hardcodes a "## Greeting" block that re-asks the
    "What kind of agent" question and says "present the available presets
    (trading, personal assistant, custom)".
  - `buildCustomPrompt` (~391) ALREADY implements the desired flow: "Ask what
    they want their agent to do → use `list_available_skills` → suggest relevant
    ones → default to no skills if none expressed." This is the behavior we
    promote to the default.
  - `list_available_skills` tool handler (~1131): queries the local `skills`
    table only (`publicationStatus='published'`, limit 50). Internal-only. ✅ (D2)
  - `create_agent` tool schema (~556+) requires `skillPresetId` ∈ {trading,
    direct-trading, trading-assistant, personal-assistant, custom}; `skillIds`
    "only meaningful when skillPresetId is 'custom'".
  - `generateAgentName(preset)` (~684) and `synthesizePrompt(goal, preset,
    capital)` (~696) branch on preset string.
- Tests: `apps/api/src/routes/chat.test.ts` asserts greeting content + preset
  detection + prompt selection.

### Create form field order (today)
`CreateAgentFlow` (exported from `apps/web/src/features/agents/AgentsPage.tsx`,
`step === 'intent'` block, ~783+):
1. **Suggested skills** `<select>` (~789–834) — options "Choose skills manually"
   / "Trading starter" / "Personal assistant starter". Backed by
   `SuggestedSkillSetId` + `SUGGESTED_SKILL_SETS` + `resolveSuggestedSkillIds` in
   `agent-display.ts` (~20, ~22, ~81) and `IntentState.suggestedSkills` (~58, 286).
   i18n keys `agents.create.suggestedSkills(+.custom/.trading/.personalAssistant)`
   (en.ts ~341–344, with ar/hi twins).
2. **Skills** collapsible `SkillPicker` (~836+).
3. **Prompt + files + style** `PromptInputBlock` (~876+) — the objective.
4. **`AgentFormBody`** (~934+) — capital/connection/telegram/name/Advanced.

`requiresTradingSetup` is derived from selected skills' capability families
(`hasCapabilityFamily(skills, 'trading')`), NOT from the Suggested-skills
dropdown — so removing the dropdown does not break trading-control activation.

### Edit form field order (today)
`EditAgentModal.tsx`: `SkillPicker` (~534) THEN `PromptInputBlock` (~558).
No "Suggested skills" field (create-only).

### `CreateAgentPage.tsx`
Delegates the form to `CreateAgentFlow`; delegates guided chat to
`GuidedSetupPanel`. Default mode is form; `?ui=chat` opens guided.

---

## Work breakdown

> **Implementation status tracker** (coordinator-maintained):
> - Part B (create form prompt-first + remove Suggested-skills): **PENDING**
> - Part C (edit form prompt-first): **PENDING**
> - Part A (guided chat preset classifier): **PENDING**
> - Part D (docs & tests): **PENDING**

### Part A — Guided chat (backend): remove the "what kind of agent" question; auto-select the preset

**Design (minimal, NO rewrite).** Keep the existing preset mechanism and the
four prompt builders (`buildBasePrompt` / `buildTradingPrompt` /
`buildPersonalAssistantPrompt` / `buildCustomPrompt`) **as they are**. The ONLY
behavioral change: instead of asking the user to pick a type via greeting
buttons, we (a) ask an open "what do you want your agent to do?" greeting, and
(b) classify the user's first message into a preset with one short LLM call,
writing it to the existing `thread.metadata.summary.preset`. The existing
selector then loads the matching prompt. This is additive at one seam; it does
not touch the prompt builders, the tools, the fine-tuning machinery, or the DB
schema.

**Why a classifier call (not a tool):** the preset selects the *system prompt*,
which is chosen at the START of a turn, before the LLM runs. A tool is called
*during* the turn, so a tool-set preset would only take effect the following
turn (ordering problem). A short classify-then-build call on the first message
sets the preset before prompt selection — order-safe.

**A1. Greeting.** In `chat.ts`:
- Change `GREETING_CONTENT` (~line 101) to exactly: *"Hi! I can help you create
  an AI agent. What would you like your agent to do?"*
- **Delete the `GREETING_ACTIONS` constant entirely** (~line 108, the two preset
  buttons + its comment block). Then update the two consumers in `createThread()`
  (~line 749–786) — the greeting-message DB insert and the returned
  `greetingMessage` object — to use `actions: null` instead of
  `actions: GREETING_ACTIONS`. (The `ChatAction` import stays; it is still used
  elsewhere.)

**A2. Preset classifier.** Add a small helper (e.g. `classifyPreset`) and call
it where `detectPresetFromContent(content)` runs today (~line 2257), BEFORE
`invokeOnboardingLlm`:
- Only run when `effectiveMetadata?.summary?.preset` is not already set (classify
  once per thread; preset is sticky metadata).
- One `callLlmProvider` call (helper + `llmConfig`/`providersYaml` already in
  scope). Use the light model, `maxTokens` small (e.g. ≤5), temperature 0 if the
  provider path supports it. Prompt (deterministic, exact output):

  > Classify what the user wants their AI agent to do into ONE category.
  > Categories: `trading` (buys/sells/trades crypto, tokens, markets, a
  > portfolio), `personal-assistant` (email, scheduling, reminders, research,
  > general help). Reply with EXACTLY one of: `trading`, `personal-assistant`,
  > or `0` if neither clearly fits. Output only that token, nothing else.
  > User: "<first user message>"

- Map the result: `trading` → `'trading'`, `personal-assistant` →
  `'personal-assistant'`, anything else (including `0`, empty, or unexpected) →
  `'custom'`.
- Write it to `effectiveMetadata.summary.preset` (the preset block at ~line 2257
  that this replaces shows the exact metadata shape to use). The existing
  selector (~line 1642) consumes it unchanged.
- **Failure handling:** wrap in try/catch; on throw/timeout → default `'custom'`.
  Classification must NEVER block the conversation or agent creation.

**A3. Remove `detectPresetFromContent` (the classifier replaces it).** Once the
greeting buttons are gone (A1), nothing emits `preset:*` tokens, so
`detectPresetFromContent` is dead — and it overlaps the classifier (both write
`preset` from the user's message). The classifier is the **sole** preset-from-
message mechanism. Steps:
- **Grep first** for all callers/importers of `detectPresetFromContent` (and
  `KNOWN_PRESETS` / `MAX_PRESET_SELECTION_LENGTH` if only it uses them). Expected:
  the only call site is the preset block at ~line 2257 (which A2 replaces).
- Delete the function + its now-unused helpers + the old call-site block,
  replacing that block with the A2 classifier call.
- If the grep finds an unexpected external caller, keep the function and just add
  the classifier alongside — but report it. (Do not break another consumer.)

**A4. Silence + summary nudge (small prompt edits, D1/D4).**
- In `buildBaseHeader` (~line 120) replace the stale line
  "You have access to skill discovery (list_available_skills — use only for
  Custom AI or when the user asks about specific skills) to understand the
  available options." with exactly:
  "You have access to skill discovery (list_available_skills) to understand which
  capabilities (skills) exist so you can equip the agent based on the user's
  described intent."
- In each preset prompt's skill-handling guidance, ensure skills are resolved on
  the user's behalf and only disclosed on the confirmation summary.
  `buildCustomPrompt` already resolves skills from intent; add one line to it
  (and to `buildBasePrompt` if it is ever reached): "Do NOT ask the user to
  choose or list skills; resolve them silently and list them only in the
  confirmation summary." (This quoted instruction is to the LLM — "silently"
  here means "without interrogating the user about skills", and is intentional.)
  This is a 1–2 line addition per builder, not a rewrite.

**A5. Builders & tools unchanged otherwise.** Do NOT delete or restructure
`buildTradingPrompt` / `buildPersonalAssistantPrompt` / `buildCustomPrompt` /
`buildBasePrompt`, the checkpoint/fine-tuning text, `list_available_skills`
(stays internal-only, D2), or `create_agent`. `create_agent` continues to pass
the classified `skillPresetId`; the preset still derives config/skills as today.

**A6. Tests.** Update `apps/api/src/routes/chat.test.ts`:
- Greeting assertion → new capability-neutral text; assert the greeting has NO
  `quick_replies` actions.
- Add a `classifyPreset` unit test: `"help me trade crypto"` → `trading`;
  `"manage my email"` → `personal-assistant`; vague/empty → `custom`; LLM
  throw → `custom` (mock `callLlmProvider`).
- Remove the `detectPresetFromContent` tests (the function is deleted in A3).

### Part B — Create form: prompt-first, remove Suggested-skills

**B1. Reorder** `CreateAgentFlow` (`AgentsPage.tsx`, `intent` step): move the
`PromptInputBlock` block to the **top** (before skills). Suggested order:
1. Prompt + files + style (objective)
2. Skills (`SkillPicker`, collapsible — unchanged per D6; consider defaulting
   expanded since it's now the sole skill control — optional, confirm in review)
3. `AgentFormBody`

**B2. Remove Suggested-skills** `<select>` block (~789–834) entirely.

**B3. Remove dead code:**
- `agent-display.ts`: `SuggestedSkillSetId` (type), `SUGGESTED_SKILL_SETS`,
  `resolveSuggestedSkillIds`.
- `AgentsPage.tsx` `IntentState`: `suggestedSkills` field + its initializer
  (~286) + any references in state updates.
- i18n: delete `agents.create.suggestedSkills`, `.custom`, `.trading`,
  `.personalAssistant` from `en.ts`, `ar.ts`, `hi.ts` (keep catalogs aligned —
  catalog-consistency test). Record in `008-orphan-i18n-key-sweep.md` ledger as
  removed.

**B4. Verify trading activation.** With Suggested-skills gone, selecting a
trading skill via `SkillPicker` must still: set `requiresTradingSetup`, show the
Capital field, and show the Advanced "Capabilities" tab. (Derivation is already
skill-based; this is a verification, not a change.)

### Part C — Edit form: prompt-first

**C1.** `EditAgentModal.tsx`: reorder so `PromptInputBlock` (~558) precedes
`SkillPicker` (~534). No Suggested-skills field exists here. `SkillPicker`
untouched (D6).

### Part D — Docs & tests

**D-docs.** Update `docs/tech/user-acceptance-tests.md`. The rows to change are
quoted verbatim below (as of 2026-10-02 — match on the ID, not line number).
Preserve the table format and the `Status` column convention. Prefer updating
the Steps/Expected/Notes rather than deleting rows.

**GC-07 — invert (was: Suggested-skills exists; now: removed + prompt-first).**
Current:
```
| GC-07 | Create flow has NO type selector; "Suggested skills" dropdown only pre-selects skills | Open create form; inspect top of form and review summary | No agent "type"/identity selector. A "Suggested skills" dropdown exists ("Choose skills manually" / "Trading starter" / "Personal assistant starter") that only pre-selects skills. | ✅ | 2026-10-01: Selecting "Trading starter" pre-selected "Bot Management, Trading" skills (editable via "Edit skills") and surfaced the trading Capital field. Review summary showed only Name/Style/Capability mode — no type row. |
```
Replace the Test Case / Expected with: NO agent "type" selector AND NO
"Suggested skills" dropdown; the objective/prompt input is the FIRST field in
the create form; the skills picker (optional) sits below it. Add a dated note
("2026-10-02: Suggested-skills dropdown removed; objective/prompt moved to top").

**MC-05 — adjust greeting expectation.** Current:
```
| MC-05 | Empty state — no agents | Open the agents page with a fresh account | No "No agents yet" empty state; guided chat is the default entry point for new users; metrics show zeros | ✅ | 2026-08-05: Empty state removed — new users land on the guided chat instead; metrics show 0 on fresh account |
```
Expected still holds; just ensure any guided-chat greeting reference reflects the
new neutral greeting (no "what kind of agent" question, no preset buttons).

**MC-06 — unchanged behavior, verify.** Current:
```
| MC-06 | "Create agent" button navigates | Click the create-flow title | Expands the create flow panel (guided chat by default); `?create=1` forces it open | ✅ | 2026-08-05: Clicking the "Create AI agent" title expands the flow; `?create=1` forces expansion |
```
No change expected; verify the panel still opens.

**AG-03a / AG-03b / AG-03c — adjust guided-chat wording.** Current:
```
| AG-03a | Create flow panel — new user | Open `/agents` with 0 agents | Create flow is expanded by default showing guided chat; no header CTA button | ✅ | 2026-08-05: New user sees guided chat expanded; no "New AI agent" button |
| AG-03b | Create flow panel — returning user | Open `/agents` with ≥1 agent | Create flow is collapsed; "Create AI agent" title still visible; clicking it expands | ✅ | 2026-08-05: Collapsed with title visible; click expands to guided chat |
| AG-03c | Create flow — switch forms | Expand the flow; click the header switch | Toggles between guided chat and the plain form; switch label updates | ✅ | 2026-08-05: "Use the form" ↔ "Use guided chat" toggles correctly |
```
Behavior is unchanged (panel expand/collapse, form switch). Only update any
Expected/Notes text that implies the guided chat opens with a "what kind of
agent" question or preset buttons — it now opens with the neutral
"What would you like your agent to do?" greeting and no quick-reply buttons.

**New row — guided-chat intent → preset classification + summary disclosure
(D0/D1/D4).** Add a GC-row asserting: greeting asks what the agent should do (no
type buttons); after the user describes a trading goal the flow collects trading
setup, and after a non-trading goal it does not; the pre-create confirmation
summary lists the resolved skills by name.

**008 ledger.** In `docs/features/2026/10/008-orphan-i18n-key-sweep.md`, note
that `agents.create.suggestedSkills` + `.custom` + `.trading` +
`.personalAssistant` were removed by this change (Part B3).

**D-tests.**
- Unit: `AgentFormBody.test.tsx`, `create-agent-setup.test.ts`,
  `agent-display.test.ts` (drop `resolveSuggestedSkillIds` cases),
  `chat.test.ts` (A6).
- E2E journeys to review/adjust: `13-agents-setup-card.spec.ts`,
  `14-create-agent-setup-escape-hatch.spec.ts`, `18-create-flow-panel.spec.ts`
  (any assertions about field order / Suggested-skills / greeting text).

## Verification (Definition of Done)

1. `pnpm lint` (root `tsc --noEmit`) green.
2. `pnpm --filter @herobids/web run build` green.
3. Web vitest green (incl. catalog-consistency + i18n-regressions).
4. API vitest green (incl. `chat.test.ts`).
5. E2E suite green (journeys 13/14/18 updated).
6. Manual/UAT: greeting asks intent (no type buttons); describing an email task
   attaches internal email skills (without asking the user to pick them) and
   shows them on the summary;
   describing a trading task triggers the trading sub-flow; create form shows
   objective first with no Suggested-skills dropdown; edit form shows objective
   before skills.
7. UAT doc + 008 ledger updated.

## Risks & notes

- **Part A is deliberately minimal.** Keep all four prompt builders, the tools,
  and the fine-tuning machinery intact. The only new logic is the classifier
  helper + greeting edit + 1–2 line silence/summary nudges. This avoids the
  risk of regressing trading-agent creation that a full prompt rewrite carried.
- **Classifier caveat — billing.** The extra classify call consumes LLM tokens.
  Use the light model + tiny maxTokens; either fold its usage into
  `chatUsageBillingRecorder` or accept it as negligible with a code comment. Run
  it once per thread (only when `preset` is unset) so it is not re-billed every
  message.
- **Classifier caveat — failure.** `callLlmProvider` can throw/timeout. Default
  to `'custom'` on any failure; classification must never block creation.
- **No new frontend action type needed** — resolving skills on the user's behalf
  is a prompt-level change; the existing `confirm` summary card carries the
  disclosed skills (D4).
- **Backend-first independence:** Part A is independent of Parts B/C and can land
  and verify separately. Parts B/C are low-risk frontend reorders + dead-code
  removal.
- **i18n removals** (Part B) must hit all three locales to keep
  catalog-consistency green.
- Before deleting symbols (`detectPresetFromContent` in A3; Part B's
  `SuggestedSkillSetId` / `resolveSuggestedSkillIds` / `IntentState.suggestedSkills`),
  grep for other call sites and update accordingly. Do NOT delete any `chat.ts`
  prompt builder as part of this change.

## Suggested sequencing

1. Part B + Part C + their tests/docs (low-risk, fast win).
2. Part A (chat prompt rework) + `chat.test.ts`.
3. Part D docs + full verification sweep.

## Outstanding Issues

Non-blocking (LOW) observations recorded during implementation review. No
critical/high issues outstanding.

### [Part B] Create form prompt-first + remove Suggested-skills
- **LOW** — `SkillPicker.onChange` simplified to `({ ...state, skillIds })` (dropped the now-dead `suggestedSkills: 'custom'` sync). Correct; noted for awareness only.
- **LOW** — The removed dropdown `onChange` used to force `authorizationMode: 'direct'` on starter-set selection. No replacement needed: `IntentState` still initializes `authorizationMode: 'direct'`. No behavior lost.
- **LOW** — Part B3's "record i18n removals in `008-orphan-i18n-key-sweep.md` ledger" and B1's optional "default SkillPicker expanded" are deferred to Part D (ledger) / left as-is (expand default is optional).
