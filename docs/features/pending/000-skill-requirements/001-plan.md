# Skill requirements: external skills declare what they need, the platform supplies it

**Status:** draft, revised 2026-11-19 after owner decisions (sticky removal without a table, no auto-removal, wider vocabulary). **No code written.**
**Origin:** evaluation of agent `b4a4db8b` (`.ignore/eval/2026/11/19/b4a4db8b-8e60-4bc7-8d81-875819072e02/01/REPORT.md`, finding 1). The `job-search` skill needs task continuity, the agent was created without `long-running-task`, and nothing assigned it. An external skill cannot name a platform skill (it must run on any platform), so the need is written as a platform-neutral word and resolved by the platform.

## 1. Goal

An external skill states what it needs in its frontmatter. When it is installed on an agent, the platform works out which of its own skills provide each need, assigns the missing ones, and tells the user and the agent what it did. Generic: no job-search code, no per-skill special cases.

```yaml
---
name: job-search
description: ...
metadata:
  requires: task-continuity, filesystem, web-research, messaging, durable-storage
---
```

One word can map to **one skill or several skills added together**, and a skill can be named by several words (section 6.2).

**This plan also removes the existing text-derived special case:** the code that reads an external skill's `allowed-tools` frontmatter and, on a `Bash` match, assigns `system/programming` (section 6.11). After this plan, a skill gets platform skills only by declaring `metadata.requires`.

## 2. Definition of done (behaviours, frozen before implementation)

Per `docs/lessons/definition-of-done-and-goalpost-drift.md`: done is a behaviour of the running system, checked on local docker compose with the real `job-search` skill. Only the owner may change these.

| # | Behaviour |
|---|-----------|
| D1 | An agent created with `job-search` and without `long-running-task` starts with `long-running-task` (and `file-management`, via the existing inferred dependency) assigned, `assignment_source = 'dependency'`, its tools visible on tick 1. |
| D2 | A restart changes nothing: no duplicate rows, no duplicate events. |
| D3 | An agent that already has a provider (from the user, the agent or a blueprint) gets no change. |
| D4 | A word the platform does not know is ignored and logged. The agent starts normally. |
| D5 | A user-only skill is never assigned through a requirement. |
| D6 | If the owner's plan does not allow a provider, the requirement is recorded as unmet, the agent starts, and the agent is told in its first prompt. No silent upgrade. |
| D7 | If the broker is unreachable at start, the agent still starts; the next start retries. |
| D8 | A skill with no `metadata.requires` is left alone: nothing is assigned on its behalf. (One deliberate change from today: `allowed-tools: Bash` no longer assigns `programming`, see D12.) |
| D9 | **Removal is sticky:** a user (or the agent) who removes an auto-added skill does not get it back at the next start, until the requiring skill's `requires` changes. |
| D10 | `evaluate-job-search-agent` check P5 passes on a fresh agent with no manual skill assignment. |
| D11 | `email` reports "skill assigned, no linked mailbox yet" when the owner has no email connection; it does not claim `send_email` works. |
| D12 | The `Bash` special case is gone: an external skill whose `allowed-tools` mentions `Bash` does **not** cause `programming` to be assigned. No code reads `allowed-tools` to decide skills. |

## 3. Non-goals

- No change to any skill's instructions or to how a system skill works.
- No operator-editable mapping in v1 (code constant, section 6.8).
- No auto-removal of a skill when nothing requires it any more (decided).
- **No on/off flag** (decided 2026-11-19): we are pre-launch and can tear down staging and production, so the feature is simply on once deployed and a bad mapping is fixed by a code change.
- **No UI badge or any web change for now** (decided 2026-11-19). See Phase 3.
- No resolution at API create time: the `SKILL.md` is not available there (section 5).
- No auto-assignment of external-backend skills such as `trading` (section 6.2).

## 4. Terminology and how it fits the pending capability program

The pending program (`docs/features/pending/000-capability-foundations/`, status draft or ready, **not yet implemented in code**) defines the platform's "capability" vocabulary: native capabilities (`messaging`), external backends (`trading`, `automation`), families (`email`, `chat`, `inbox`) and a tool-ownership manifest with categories `core`, `general`, `native:messaging`, `external:*` (009). The code today has only part of it: `capabilityFamilies` on `SkillDefinition`, set **only on `email`** (`['email']`), used for connection readiness (`readinessByFamily`, `grantedConnectionsByFamily`), the `GET /capabilities` route and UI badges.

So:

- **Feature name and code:** "requirement" (`metadata.requires`, `SkillRequirementDefinition`). It is the skill-side declaration. It does not reuse `capabilityFamilies` (which means "connection family") or `capability-policy.ts` (tool tiers).
- **Vocabulary words reuse the program's ids wherever one exists** (`messaging`, `email`), so there is no second taxonomy. Words for abilities the program classes as `core` or `general` (`task-continuity`, `filesystem`, `web-research`, `durable-storage`) are new but follow the same naming (lowercase, hyphenated, platform-neutral).
- **When the registry in 009 lands,** `satisfiedBy` for native capabilities should be derived from it instead of listed by hand (lessons doc rule 6: copies drift). Until then the requirement registry is a small code constant with a consistency test against `SYSTEM_SKILLS` and tool ownership.

## 5. Current state (verified in source on 2026-11-19)

| Fact | Where |
|------|-------|
| `SKILL.md` is read only inside the agent runtime: at agent start (`installExternalSkillsAtStart`, called from `apps/worker/src/agent.ts` ~L4676-4712, before the first tick) and in `add_skills` / `read_skill` / `load_skill`, all via `activateExternalSkill`. | `apps/worker/src/tools/skills.ts` L133; `apps/worker/src/external-skill-startup.ts` L47 |
| At API create time an external ref is a placeholder row (name = last ref segment, empty description). | `packages/db/src/external-skill-catalog.ts` `upsertExternalSkill`; `apps/api/src/index.ts` L193-217 |
| Only `name` and `description` are persisted from the frontmatter. | `external-skill-catalog.ts` |
| `parseSkillFrontmatter` is a flat line parser, not YAML. A nested `metadata:` block yields `metadata: ''` plus the indented keys as **top-level** keys; the inline `{ }` form yields a raw string. | `skills.ts` L186-209 |
| The only text-derived special case today: `Bash` in an external skill's `allowed-tools` makes `add_skills` add `programming` through the broker and report it as `autoResolved`. Runs only in `add_skills`, not at start; not persisted, not shown in the UI. **Removed by this plan (6.11).** | `detectExternalSkillBashDependency` L245-266 and step 5b L672-700 in `apps/worker/src/tools/skills.ts` |
| `assignment_source` is free text (`user_select`, `guided_setup`, `blueprint_instantiate`, `go_live`, `agent_self`); the TS unions allow four of them. Nothing in `apps/web` or `apps/api` reads it; the agent API returns only `skillIds`. | `packages/db/src/skill-assignment.ts` L160, L177; greps of `apps/web/src` and `apps/api/src` |
| A PATCH is a full replace of an agent's skills; existing rows keep their source and other columns, and update `skill_revision_id` and `order_index`. The edit form re-sends current ids, so a user can uncheck any skill. No restart or reload signal for skill changes was found in `apps/api/src/routes/agents.ts`. | `skill-assignment.ts` `syncAgentSkillAssignmentsInTx` |
| Agent-initiated adds go through the broker (`handleSkillAdd`: plan entitlements, user-only and `base` checks), then `onSkillsChanged` hot-reloads the descriptor and tool visibility. | `apps/worker/src/agents/agent-message-broker.ts` ~L866-1040; `agent.ts` L2222 |
| User-only skills are refused by the tool and the broker. | `USER_ONLY_SKILL_IDS`, `isUserOnlySkill` in `packages/domain/src/skills.ts` |
| Dependencies between system skills are inferred from tool ownership (`inferDependsOn`): this is why `long-running-task` brings `file-management`. | `skills.ts` L617 |
| No word-to-skills mapping exists. `SKILL_PRESET_MAP` maps presets to skills at creation only. | `skills.ts` L515 |

**Which system skill owns which tools** (from each skill's `requiredTools`; this decides what a word can honestly map to):

| Skill | Tools | Ownership category in 009 |
|-------|-------|---------------------------|
| `base` (always present) | memory, tasks, reminders, `send_message`, `publish_artifact`, `get_thread`, skill management | `core`; messaging inbox is `native:messaging` |
| `file-management` | the nine file tools | `core` (agent workspace) |
| `long-running-task` | `finish_run` plus the file tools | `core` |
| `web-access` | `search_web`, `browse_url`, `read_document`, `make_http_request` (also `send_message`, `publish_artifact`) | `general` (stateless web tools) |
| `browser` | `browse_interactive` (also `send_message`, `publish_artifact`) | `external:automation`, skill-gated, needs browser pool capacity |
| `email` | `send_email`; `capabilityFamilies: ['email']` | `native:messaging`; needs explicit messaging activation **and a ready email connection** (006) |
| `programming` | `execute_code`, `execute_shell` | `general` / `core` |
| `platform-docs` | docs tools | `core` |

## 6. Design

### 6.1 Declaration and parsing

- **Form:** the nested block the Agent Skills spec shows. Metadata values are strings, so several words are comma-separated.
  ```yaml
  metadata:
    requires: task-continuity, filesystem
  ```
- **Parser:** a small separate function that reads the `metadata:` block's indented `key: value` lines into a `Record<string, string>`. `parseSkillFrontmatter` keeps its flat behaviour: today an indented `requires:` already leaks into a top-level `requires` key, and that accident must not become the contract (a test asserts a top-level `requires:` is ignored). No new dependency. The inline `{ ... }` form is unsupported in v1: logged as a warning, treated as no requirements.
- **Tokens (Zod, at this trust boundary):** split on commas, trim, lowercase, each `^[a-z][a-z0-9-]{1,40}$`, at most 10, duplicates collapsed. Bad tokens are dropped and logged. The value comes from a third-party repository and is untrusted data.

### 6.2 Vocabulary and the provider model (one word, many skills)

Registry in `packages/domain/src/skill-requirements.ts`, next to `SYSTEM_SKILLS`:

```ts
interface SkillRequirementDefinition {
  id: string;                      // 'task-continuity': the word authors write
  description: string;             // one line, shown in docs and the agent prompt
  satisfiedBy: readonly string[];  // skill ids (or 'base') that already provide it; any one is enough
  assign: readonly string[];       // skills to add when not satisfied; may be empty
}
```

- **Satisfied** = any id in `satisfiedBy` is already assigned (`base` always is). Who assigned it does not matter.
- **`assign` is a bundle:** every skill listed is added together. If any of them is not allowed for this user, add none and record the requirement as unmet: a half-installed bundle is worse than none. There is no "either of two skills" option (no mode field); add one only when a real word needs it.
- **Transitive skills need no entry.** Assigning a provider uses the existing add path with dependencies, so `long-running-task` brings `file-management`. The registry names what *provides* a word, not what it pulls in.
- **Empty `assign`:** the word is recognised and recorded as satisfied or unmet-by-design, never assigns anything (always-present skills, external backends).
- **A skill may name many words; a word may be provided by many skills** (`satisfiedBy` is a list, `assign` is a list). Both resolve independently.

#### v1 vocabulary

| Word | What it means for the skill author | Kind (per 009) | `satisfiedBy` | `assign` | Result on a fresh agent |
|------|------------------------------------|----------------|---------------|------------------|--------------------------|
| `task-continuity` | I can wake myself on a schedule and resume from saved state | `core` | `long-running-task` | `long-running-task` | adds `long-running-task` + `file-management` (inferred) |
| `filesystem` | I can read and write files in my workspace | `core` | `file-management` | `file-management` | adds `file-management` |
| `durable-storage` | I can keep records that survive a restart | `core` | `base` | none | always satisfied (memory tools are in `base`) |
| `messaging` | I can message the user in the platform | `native:messaging` | `base`, `email` | none | always satisfied (`send_message` is in `base`) |
| `email` | I can send email through the user's linked mailbox | family of `messaging` | `email` | `email` | adds `email`; readiness reported separately (below) |
| `web-research` | I can search the web, read pages, make HTTP requests and read documents | `general` | `web-access` | `web-access` | adds `web-access` |
| `web-automation` | I can drive a real browser: click, fill forms, read script-rendered pages | `external:automation`, skill-gated | `browser` | `browser` | adds `browser`; browser pool capacity is a runtime concern, not checked here |
| `code-execution` | I can run code or shell commands in a sandbox | `general` (`execute_code`) / `core` (`execute_shell`) | `programming` | `programming` | adds `programming`. **Replaces the removed `Bash` special case (6.11).** Grants a shell, so a skill should declare it only when it truly needs it. |

Recognised but **never auto-assigned** in v1: `trading` (an external backend; its skills are operator-approved external refs, not system skills). It is logged as `recognised, not assignable`.

**Decisions behind these rows**

- **`messaging` is not mapped to `email`.** Messaging the user is the platform inbox, always available through `base`. Assigning the `email` skill for it would add a skill that cannot work until the user links a mailbox, for every skill that merely wants to message the user. Email is its own word, matching the existing family id `email`. This follows 009/006: `send_message` is implicit, `send_email` needs explicit activation plus a ready email binding.
- **`email` reports readiness.** The skill is assigned, but `readinessByFamily['email']` says whether a connection exists. The resolver includes that in its report (`met, no linked mailbox yet`), so the agent can disclose it (D11). Assigning does not create a connection.
- **Web is split on the platform's own boundary, not by tool.** 009 and ADR 009 draw the line between stateless web tools (`general`, owned by `web-access`) and stateful browser automation (`external:automation`, skill-gated, provider lifecycle). So two words, `web-research` and `web-automation`. One word per tool (`web-search`, `page-reading`, `http-requests`, `document-reading`) was rejected: four words, one provider, no difference in behaviour, and a bigger vocabulary for authors to learn. `browser` does not own `browse_url`, so `web-automation` does not satisfy `web-research`.
- **`filesystem`, not `file-management`:** the skill id is an internal name; the word describes the ability.
- **Words never name an internal skill or tool.** Governance: a new word is a code change in `packages/domain` plus a line in the `openaidom-skills` README vocabulary.

### 6.3 Resolution algorithm

A pure function in the domain package, no I/O:

```
resolve(assignedIds, externalSkills[{id, requires[]}], registry, policy, readiness) ->
  { additions: [{skillIds, requiredBy, requirement}], satisfied[], unmet[{requirement, reason}], unrecognised[], notes[] }

for each (skill, word) sorted by (skill.id, word):
  def = registry[word]                     -> missing: unrecognised, continue
  if def.satisfiedBy intersects assigned   -> satisfied (add readiness note for `email`), continue
  if def.assign is empty                   -> satisfied-by-design or recognised-not-assignable, continue
  candidates = def.assign filtered by policy (not user-only, plan allows, selectable)
  every candidate allowed?                 add all : unmet(reason)      (bundle: all or nothing)
  assigned += added ids                    (so a later word sees it)
stop adding at MAX_AUTO_ASSIGNED (a code constant, 5); the rest are unmet(reason: cap)
```

Tested properties: deterministic order, idempotent (running on its own output adds nothing), bundle atomicity, cap, readiness note, unknown word, user-only candidate, empty `assign`.

### 6.4 Where and when it runs

| Trigger | Place | Why |
|---------|-------|-----|
| Agent start | `agent.ts` right after `installExternalSkillsAtStart` and **before** `resolveBackendApprovedSkills` / `snapshotToolBaselines` / `applyToolVisibility` (~L4697-4712) | The `SKILL.md` is on disk; tool visibility is baselined once, so additions must land first. |
| Skill added at runtime | `add_skills`, in the place step 5b occupies today (step 5b is deleted, 6.11), after `activateExternalSkill` | Same helper, same result, plus an `autoResolved` entry. |
| API create / PATCH | **Not used** | No `SKILL.md` there. A skill added by PATCH takes effect at the agent's next start (no reload signal was found), and its requirements resolve at that same start, so they land exactly when the skill does. |

Both sites call one shared worker helper: read `SKILL.md`, parse `metadata.requires`, skip if already resolved (6.5), call `resolve`, send additions through the existing broker `add` mutation, then re-resolve the descriptor (`onSkillsChanged` at runtime; a descriptor refetch at start). It never throws into agent start (D7).

**Broker change:** extend `ManageAgentSkillsPayloadSchema` (`packages/domain/src/agent-protocol.ts` L206) with optional `source: 'dependency'`, `requiredBy: [{skillId, requirement}]` and `resolvedFor: string`. The broker keeps its entitlement, user-only and `base` checks and writes the source and the marker in **one transaction**. The worker never writes `agent_skills` itself.

### 6.5 Provenance and sticky removal (one column, no new table)

An earlier draft proposed a `skill_requirements` table to remember dismissals and track many-to-many provenance. That is more than needed. Decision: **one nullable column** on `agent_skills`.

- `agent_skills.requirements_resolved_for text NULL`, set on the **external skill's own row**. Value: a hash of that skill's normalised, sorted `requires` set.
- At each start (and in `add_skills`), for each external skill: if the stored value equals the hash of the current `requires`, **skip resolution entirely**. Otherwise resolve, and store the hash **only if nothing was unmet or unrecognised**.
- Result:
  - **Sticky removal (D9):** after the first clean resolution, a provider the user removes is not re-added, because the skill is never re-resolved until its `requires` changes.
  - **Unmet is retried:** a plan upgrade or a newly recognised word is picked up at the next start, because nothing was stored.
  - **Idempotent (D2)** by construction, and no extra work on later starts.
- **Provenance** is `assignment_source = 'dependency'` on the provider row (extend the two unions in `skill-assignment.ts`, L160 and L177). Existing rows keep their source on conflict, so a skill the user chose is never relabelled. "Which skill asked for it" is not stored; it can be recomputed from the requiring skill's `requires` if the UI ever needs it.
- **Cost:** one migration (generated with `drizzle-kit generate`, journal consistent per `docs/best-practices`). `syncAgentSkillAssignmentsInTx` updates only `skill_revision_id` and `order_index` on conflict, so the column survives a PATCH.
- **Not covered, accepted:** a user who removes the provider *and* wants it back must re-add it by hand, or change the requiring skill's version. If the requiring skill is removed and re-added later, the fresh row has no marker and resolves again.

### 6.6 Visibility

- **Agent:** the first-tick prompt lists each external skill's requirements and their state, one line each (`met by long-running-task (added for job-search)`, `met; no linked mailbox yet`, `unmet: plan does not include ...`, `unrecognised: foo`). This is what lets the skill's own rule ("disclose missing capabilities, never claim unattended operation") work. The exact insertion point (the skill listing or a context block) is chosen in Phase 2 after reading `render-skill-prompt-block` and `RUNTIME_CONTEXT_PROVIDERS`.
- **Tool response:** `add_skills` returns `autoResolved: [{skill, requiredBy, requirement}]` (shape exists).
- **Audit:** a `skill_usage_events` row (`agent_assigned`, exists) and a structured log `skill_requirement_resolved` / `_unmet` / `_unrecognised`.
- **User:** no UI change for now (decided). The auto-added skill appears in the agent's skill picker like any other skill; the UI does not say why it is there. Revisit if users ask.

### 6.7 Removal

- User or agent removes a dependency skill: it stays removed (D9, 6.5).
- Requiring skill removed: the provider stays assigned (decided: no auto-removal). The `dependency` label tells the user it was added automatically.

### 6.8 Configuration

None. The mapping and the safety cap (`MAX_AUTO_ASSIGNED = 5`) are **code constants** in `packages/domain`, tested for consistency (every id exists in `SYSTEM_SKILLS`, none is user-only, no word names an internal skill). There is no on/off flag and no new operator config, environment variable or `.example` change. A bad mapping is fixed with a code change and a redeploy (decided: pre-launch, environments can be torn down).

### 6.9 Security and trust

- The external skill chooses **words only**; platform code decides which skills a word may add. An unknown word adds nothing.
- Refused regardless of input: user-only skills (D5), `base`, anything the plan disallows, anything past the cap.
- Metadata is Zod-parsed, bounded in length and count, and never put in a prompt as instructions; only the validated word and the resolved state reach the prompt.
- Every addition is audited and visible. A hostile repository can at worst request skills the platform offers any agent, at the owner's plan level.

### 6.10 Failure modes

| Failure | Behaviour |
|---------|-----------|
| `SKILL.md` missing or install failed | No requirements read; existing "listed but unavailable" handling. |
| Malformed frontmatter, inline `{}` form, bad tokens | Warn, drop the bad parts, continue with the rest. |
| Unknown word | `unrecognised`, logged, shown to the agent; marker not stored, so it is retried. |
| Broker unreachable or timed out at start | Log, agent starts, retried at the next start (D7). Bounded wait. |
| Provider not allowed by plan | `unmet`, shown to the agent, no partial bundle; retried at the next start. |
| Cap reached | Remaining words `unmet(cap)`. |
| Restart with a clean marker | Skipped entirely (D2). |
| Descriptor refetch fails after additions | Log; tools appear at the next hot-reload or start; no crash. |
| `email` assigned without a connection | Met, with a readiness note (D11); the skill's own tools stay unready as today. |

### 6.11 Removing the `Bash` special case

**What is removed**

- `apps/worker/src/tools/skills.ts`: `detectExternalSkillBashDependency` (L240-266), step 5b in `add_skills` (L672-700) with the `postInstallBrokerResult` variable and its uses in the response (L673, L691, L738, L753, L757), and the `PROGRAMMING_SKILL_ID` / `PROGRAMMING_SKILL_SLUG` constants (L20-21) if nothing else uses them afterwards. The `autoResolved` response field stays; the new helper fills it.
- Tests: delete `apps/worker/src/tools/skills-bash-detection.test.ts`; remove any Bash expectation in `skills.test.ts` and `skills-local-source.test.ts`; the fixture `__fixtures__/external-skill-source/example/skills/skills/echo-shell/SKILL.md` declares Bash, so keep it for install tests but drop what it proves about `programming`.
- Docs: `docs/features/pending/000-herobids-agnostic-skills/000-discovery.md` L86 warns that `allowed-tools: Bash` quietly grants `system/programming`; after removal that warning is moot, so update it. Historical plans under `docs/features/2026/**` stay as history.

**Why**

- It is invisible: a permission field (`allowed-tools`, from the Agent Skills spec) silently widens the agent's permissions to a shell. The discovery doc above already tells authors not to use it for that reason.
- It is the one place the code derives a decision from a skill's own text. `metadata.requires` becomes the only mechanism, with a visible, audited, bounded result.

**The deliberate behaviour change (D12)**

External skills from third parties that declare `allowed-tools: Bash` no longer get `programming` assigned for them. The agent can still add it itself (`add_skills system/programming`). If that proves a problem, the answer is for such a skill to declare `requires: code-execution`, **not** to restore the regex.

**State of our own skills**

As of 2026-11-19 no skill in `openaidom-skills` or `traderton-skills` carries `allowed-tools` in its working-copy frontmatter (checked; those edits were uncommitted at the time), so nothing of ours depends on the special case. The implementer re-checks before merging; if any skill still needs code execution, convert it to `requires: code-execution` after asking the owner.

**Order:** the removal ships in the same change as the helper that replaces step 5b, so the platform never has two mechanisms. **Check:** a search of `apps/` and `packages/` for `allowed-tools` and `detectExternalSkillBash` finds no runtime code.

## 7. Phases

Each phase ships on its own with a named exit check. No leftover is deferred without a home (lessons doc, rules 4 and 5).

### Phase 1: parsing, registry, pure resolver (no behaviour change)

- `packages/domain/src/skill-requirements.ts`: types, the v1 vocabulary, token parsing (Zod), `resolveSkillRequirements`.
- Metadata-block parser in the worker, beside `parseSkillFrontmatter`. It must tolerate the shape `traderton-skills` already uses, `metadata:` containing a `tags:` **list** (`- crypto`, `- trading`): list items and non-string values are skipped, and `requires` beside them is still read (test with a real `traderton-skills` frontmatter).
- **Verify, against code, every word's provider** (the table in 6.2 is from `requiredTools` on 2026-11-19): the consistency test fails if a `satisfiedBy` or `assign` skill is missing, user-only, or no longer owns the tools the word promises.
- **Exit:** unit tests for parsing, every resolver property in 6.3, and registry consistency. Nothing calls the resolver yet.

### Phase 2: apply at start and in `add_skills`, with sticky removal

- Shared worker helper; call sites in `agent.ts` (before backend discovery) and `skills.ts` (replacing step 5b).
- **Remove the `Bash` special case** (6.11): delete `detectExternalSkillBashDependency` and step 5b from `skills.ts`, delete `skills-bash-detection.test.ts`, clean up the fixtures and tests that depend on it.
- Broker payload extension; `'dependency'` source; the two unions; the `requirements_resolved_for` column and its migration; marker written in the broker's transaction.
- First-tick prompt lines (including the `email` readiness note); `autoResolved`; audit event and logs.
- Verify the whole chain on local compose first, then on staging (`docs/tech/agents/agent-runtime-rollout-guide.md`). No flag.
- **Exit:** D1 to D9, D11 and D12 pass on local docker compose with the real `job-search` once its metadata is published (Phase 4 step 1); D10 passes.

### Phase 3: UI badge. Not planned (decided 2026-11-19)

No UI work and no API change for now. The data a badge would need (`assignment_source = 'dependency'`) is stored by Phase 2, so it can be added later without a migration. Revisit if users ask why a skill is on their agent. Until then the user sees the skill in the agent's skill picker like any other, and the agent is told what was added (6.6).

### Phase 4: publish and document

**1. Update every skill in `openaidom-skills` and `traderton-skills`** (they already list the capabilities they need in prose; the metadata makes that machine-readable). Rules for the implementer:

- Declare **only** what the skill's own text says it needs ("Capabilities you may need", or its prose). Do not invent requirements.
- Map the prose to words with the table below. Keep the prose; the fallback for agents on other platforms depends on it.
- **If you are not sure, ask the owner.** Cases already known to be uncertain are marked "ask" below.
- Add the vocabulary section once, to the `openaidom-skills` README; the `traderton-skills` README links to it instead of copying it (copies drift).
- Add a CHANGELOG entry in each repo.

| Prose in the skill | Word |
|--------------------|------|
| search the web, browse or read pages, read documents, HTTP requests | `web-research` |
| a real browser, pages that need clicking or scripts | `web-automation` |
| save and re-read notes or files | `filesystem` |
| remember state across runs | `durable-storage` |
| schedule the next run or scan | `task-continuity` |
| message the user, publish results | `messaging` |
| send email through the user's mailbox | `email` |
| run code or shell commands | `code-execution` (replaces the removed `allowed-tools: Bash` behaviour; declare only when truly needed) |
| trade, trading capability | `trading` (recognised, never auto-assigned, F3; documents the need) |

| Repo | Skill | Proposed `metadata.requires` | Notes |
|------|-------|------------------------------|-------|
| openaidom-skills | `job-search` | `task-continuity, filesystem, web-research, messaging, durable-storage` | Settled. |
| openaidom-skills | `flight-deal-monitoring` | `web-research, filesystem, durable-storage, task-continuity, messaging` | Its list also has "read documents" (inside `web-research`) and "structured results/reports" (inside `messaging`). |
| openaidom-skills | `lost-or-stolen-item-finder` | `web-research, filesystem, durable-storage, task-continuity, messaging` | **Ask:** "browse or crawl pages that resist simple fetching" may mean `web-automation`. Declaring it makes the platform assign `browser`, so it should be required, not just helpful. |
| openaidom-skills | `raw-text-to-bitwarden-csv-converter` | `messaging` | **Ask:** it says "message it back or write it to a file", an either/or. There is no either/or in v1, so declare the one that is always available (`messaging`), or nothing. |
| traderton-skills | `ai4trade-trading-signals` | `web-research, filesystem, durable-storage, trading, messaging` | `trading` is documentation only for now. |
| traderton-skills | `crypto-trading` | `trading, messaging` | **Ask:** it lists no capabilities section; confirm what it needs. |
| traderton-skills | `crypto-bot-management` | `trading, messaging` | **Ask:** as above. It names platform tools directly, which is fine for a Traderton skill; making it platform-neutral is out of scope. |
| traderton-skills | `crypto-risk-monitoring` | `trading, messaging` | **Ask:** "watch positions over time" may need `task-continuity`, but its text does not say how it is woken. |

`traderton-skills` already carries `metadata.tags` as a list, so Phase 1's parser test uses its real frontmatter.

2. `docs/tech/agents/skill-requirements.md`: the registry, how to add a word.
3. Cross-link `docs/tech/agents/skill-authoring.md`; herobids CHANGELOG at release.
4. `.github/skills/evaluate-job-search-agent`: P5 reads "present, assigned by dependency or by the user"; add a check for the resolution log line.

- **Exit:** every skill in both repos either declares its requirements or has a recorded reason it declares none; a fresh agent created with only `job-search` selected passes P5 with no manual step.

## 8. Tests

| Layer | New tests | Pattern to follow |
|-------|-----------|-------------------|
| domain | `skill-requirements.test.ts`: tokens; registry consistency (ids exist, none user-only, tool ownership matches, no word names an internal skill); resolver properties (6.3) | `packages/domain/src/skills.test.ts` |
| worker | metadata-block parser (including the top-level `requires:` leak and a `metadata.tags` list beside `requires`); helper with fakes for broker and descriptor; marker skip and sticky removal; `add_skills` auto-resolve; start path never throws | `skills-user-only.test.ts`, `external-skill-startup.test.ts` (and the deleted `skills-bash-detection.test.ts` for its fake-installer approach) |
| worker (D12) | `allowed-tools: Bash` in an installed external skill no longer assigns `programming`; `code-execution` does | rewrite of the deleted Bash test |
| broker | `source: 'dependency'` and `resolvedFor` persist in one transaction; user-only and entitlement still refused | `agent-broker.test.ts` ("add action") |
| db | `'dependency'` preserved on conflict; `requirements_resolved_for` survives a PATCH upsert | `packages/db/src/skill-assignment.test.ts` |
| api | PATCH keeps the marker | `agent-external-skill-ref.integration.test.ts` |
| end to end | local compose: create an agent with `job-search` only; assert D1 to D3; restart (D2); remove `long-running-task`, restart (D9) | `evaluate-job-search-agent` checks |

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Removing the `Bash` special case changes behaviour for third-party skills that rely on it | Deliberate (D12); the agent can add `programming` itself; a skill that needs it declares `code-execution`. No skill of ours depends on it (6.11). |
| Hidden changes surprise users | Audited, shown to the agent from Phase 2, sticky when removed. The user sees the skill in the picker; no "why" label for now. |
| Prompt bloat: `long-running-task` adds about 1,200 words to every job-search agent | Accepted cost; measure the token impact in the Phase 2 evaluation. |
| A word drifts from what its skill provides | Phase 1 consistency test against `SYSTEM_SKILLS` and tool ownership; small reviewed vocabulary; derive from the 009 registry once it exists. |
| `email` assigned but useless without a mailbox | D11: readiness note, no claim of success. |
| `browser` assigned but the browser pool is full | Out of scope here; it is an existing runtime concern. Noted in 6.2. |
| Startup latency or a broker race | Bounded wait, non-fatal, retried. |
| Flat-parser quirk leaks a top-level `requires` | Separate metadata parser; test it. |
| Two skills require the same provider | Resolver is order-independent and idempotent; no per-requirer state is stored. |
| A skill's `requires` changes mid-life | The hash changes; resolved at the next start. |
| The pending capability program changes ids | Words reuse its ids; the Phase 1 test points at the registry once it exists. |

## 10. Decisions

**Resolved by the owner (2026-11-19):**

- Sticky removal: yes, **without a new table** (6.5, one column).
- No auto-removal of orphaned dependency skills.
- Ship more than `task-continuity`: the v1 vocabulary above, guided by `capabilityFamilies` and the 009 registry.

**Approved by the owner (2026-11-19):** O3 worker-only resolution; O4 new words need a code change plus a line in the `openaidom-skills` README (which `traderton-skills` links to); O6 the source is named `dependency`; O8 two web words (`web-research`, `web-automation`); O9 `messaging` satisfied by `base` with `email` as its own word; O10 `browser` is auto-assigned for `web-automation`.

**Decided 2026-11-19:** no on/off flag (6.8); no UI badge for now (Phase 3); remove the `Bash` special case code (6.11).

**Proposed, awaiting the owner's OK:** O13 add `code-execution` (maps to `programming`) to the v1 vocabulary as the replacement for the removed special case. Recommendation: yes; it is one row and gives skills that really need a shell an explicit, visible way to say so.

**Decided 2026-11-19 (also):** no `mode` field; `assign` is always a bundle (6.2). A "first allowed of several" option is added only when a real word needs it.

**Nothing is open.**

## 11. Effort (estimates, not commitments; about 2 days in total)

| Phase | Estimate |
|-------|----------|
| 1 | about half a day: the registry constant, the two parsers and the pure resolver, with tests |
| 2 | about 1 day: the agent-start hook and `add_skills` call site (replacing the removed `Bash` code, about an hour of that), the broker change, one column and migration, the prompt lines, and the live check on local compose |
| 3 | not planned |
| 4 | about half a day: eight skills in two repos, two READMEs, two CHANGELOGs, one doc page and the evaluator tweak, plus the owner's answers to the "ask" rows |

The main uncertainty is Phase 2: the items in section 13 (broker round trip at start, where the first prompt lists skills) are unverified. Earlier estimates (about 3.5 days) assumed the flag, the config schema, the requirements table and the UI badge, all since cut.

## 12. Follow-ups, each with a home

- **F1:** done in this plan (6.11): the `Bash` special case is removed and `code-execution` replaces it.
- **F2:** an operator-editable mapping, if a deployment needs different providers. Home: revisit when requested.
- **F3:** `trading` and other external-backend words that assign operator-approved external skills. Home: with the capability-foundations program (013, 014).
- **F4:** derive `satisfiedBy` for native capabilities from the 009 registry once implemented. Home: the capability-foundations program, phase that implements 009.

## 13. Unverified at planning time

Re-verify before Phase 2:

- The agent-start broker round trip (a Redis stream and a reply list) when the worker is restarting. Not exercised here.
- Where exactly the first-tick prompt lists external skills (`render-skill-prompt-block`, `RUNTIME_CONTEXT_PROVIDERS` in `apps/worker/src/runtime-composition.ts`). Not read.
- Whether `onSkillsChanged` (`agent.ts` L2222, defined only when `db && agentRepo` exist) can run before the first tick, or whether start should refetch the descriptor directly.
- That a PATCH really does not re-resolve or restart a running agent. A grep of `apps/api/src/routes/agents.ts` found no signal; confirm before relying on "lands exactly when the skill does" in 6.4.
- `readinessByFamily` is computed per family from the assigned skills when the descriptor is built (`packages/db/src/agent-runtime-descriptor.ts` L262-313), so a freshly added `email` skill has a readiness entry only after the descriptor is refetched. The `email` note in 6.3 therefore runs after that refetch. How it reports an agent with no mailbox is not yet checked.
- The pending program's docs are drafts; ids there may change.
- Every other user of `postInstallBrokerResult`, `PROGRAMMING_SKILL_ID`, `PROGRAMMING_SKILL_SLUG` and the `echo-shell` fixture. A grep on 2026-11-19 found them only in `skills.ts`, `skills-bash-detection.test.ts`, `skills.test.ts` and `skills-local-source.test.ts`; confirm at removal time.
- Line numbers are from 2026-11-19 and will move.
