# Skill Authoring Guide

A skill describes *expertise* for an agent and the *tools* the agent can use within the context of the expertise.

- Keep skills narrowly scoped.

- Do not use such assertive language that may compel the agent to always do what the skill makes it capable of doing.

## Two kinds of skills

| Kind | Where it lives | How it's created | When to use |
|------|---------------|-----------------|-------------|
| **System skill** | `packages/domain/src/skills.ts` (`SYSTEM_SKILLS`) | Code — upserted on API startup | Platform capabilities that every deployment needs (trading, bot-management, web-access, etc.) |
| **Markdown skill** | `docs/agents/skills/*.md` | Drop a file — setup scripts POST it via the API | User-facing skills, integrations, workflows, external skill registry guides |

## Markdown skills

Any `.md` file in `docs/agents/skills/` with YAML frontmatter is automatically posted to the platform by the setup scripts (`quick-setup.sh`, `quick-setup-remote.sh`). No code changes required.

### Adding a new skill

1. Create a markdown file in `docs/agents/skills/`. Use a descriptive kebab-case name (e.g. `weather-monitoring.md`).

2. Add YAML frontmatter with the required fields:

```markdown
---
name: Weather Monitoring
description: >-
  Monitor weather conditions and send alerts when severe weather
  is detected in configured locations.
tags:
  - weather
  - monitoring
requiredTools:
  - search_web
  - browse_url
  - set_memory
  - get_memory
  - schedule_reminder
  - send_message
---

You have access to weather data sources and alerting tools.

- Use `search_web` to query weather services...
```

3. The body (everything after the closing `---`) becomes the skill's `instructions` field — this is what the agent sees in its system prompt when the skill is assigned.

4. Run `quick-setup.sh` (or `quick-setup-remote.sh` for production). The script reads every `*.md` in the folder, parses the frontmatter, and calls `POST /skills` for each one. Skills that already exist (matched by `name`) are skipped.

### Frontmatter fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Display name. Must be unique — the setup script uses this to detect duplicates. |
| `description` | Yes | string | Short description shown in the skill catalog. Use `>-` for multi-line. |
| `tags` | Yes | string[] | Searchable tags. One per line, prefixed with `- `. |
| `requiredTools` | Yes | string[] | Tools the agent needs when this skill is assigned. Must be names from `KNOWN_AGENT_TOOL_NAMES`. |

| `promptTemplate` | No | string | Pre-populated starter text for the agent goal field. Use `\|` for multi-line blocks. |

### What not to put here

- **Agent prompts** (goal text for a specific agent instance) go in `docs/agents/prompts/`, not `docs/agents/skills/`. Prompts are not skills — they're injected directly into an agent's goal field, not posted to the skill catalog.
- **System skills** that every deployment needs should be defined in `packages/domain/src/skills.ts` and synced via `syncSystemSkills`. Markdown skills are for optional, user-facing capabilities.

## System Skill Sync

`SYSTEM_SKILLS` in `packages/domain/src/skills.ts` is upserted into the database on every API startup, so changes to instructions, tools, guardrails, or related fields take effect on the next restart without a manual reseed.

**Single sync owner:** `syncSystemSkills(db)` is called exactly once, in `apps/api/src/index.ts` before route registration. Do not call it from within route modules or middleware — doing so makes route registration a hidden write path and makes the sync order hard to reason about. Test and bootstrap code that does not go through `index.ts` must call `syncSystemSkills(db)` explicitly before mounting routes.

## Writing style

When defining a skill (system or markdown):

- **BAD**: "Trade crypto to grow my portfolio conservatively." — Reason: the word conservatively implies this may be better suited to a conservative-trading skill.

- **BAD**: "Trade using the following tools: search_tokens, submit_decision" — Reason: it is better to say: "You can trade using the following..."

- **GOOD**: "You have access to trading related/enabling tools. - Use `search_tokens(query) -> Token[]` to search for tokens. - Use `price_history(symbol, from, to) -> PriceSeries` to get price history. - Use ..." 

## Template

System skills: see `packages/domain/src/skills.ts`

Markdown skills: see existing files in `docs/agents/skills/`
