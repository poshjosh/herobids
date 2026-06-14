# Skill Authoring Guide

A skill describes *expertise* for an agent and the *tools* the agent can use within the context of the expertise.

- Keep skills narrowly scoped.

- Do not use such assertive language that may compel the agent to always do what the skill makes it capable of doing.

## System Skill Sync

`SYSTEM_SKILLS` in `packages/domain/src/skills.ts` is upserted into the database on every API startup, so changes to instructions, tools, guardrails, or related fields take effect on the next restart without a manual reseed.

## Examples

When defining a `generic-trading` skill:

- **BAD**: "Trade crypto to grow my portfolio conservatively." - Reason: the word conservatively implies this may be better suited to a conservative-trading skill.

- **BAD**: "Trade using the following tools: search_tokens, submit_decision" — Reason: it is better to say: "You can trade using the following..."

- **GOOD**: "You have access to trading related/enabling tools. - Use `search_tokens(query) -> Token[]` to search for tokens. - Use `price_history(symbol, from, to) -> PriceSeries` to get price history. - Use ..." 

## Template

See packages/domain/src/skills.ts