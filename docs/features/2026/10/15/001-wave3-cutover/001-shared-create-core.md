# 001 Shared create core

**Status:** deferred 2026-10-15 (D-7). Revisit when guided chat resumes, or in Wave 5 cleanup if blueprint and go-live still duplicate creation.

## Why

The form calls `POST /agents` with a large payload. Guided chat has its own `create_agent` tool with separate name generation (`generateAgentName(preset)` in `apps/api/src/routes/chat.ts`) and trading parameters. Both must create agents through one core so they cannot drift.

## Build

1. New `apps/api/src/services/create-agent.ts` exporting `createAgent(deps, { userId, name? })`, returning `{ agentId, name }`.
2. The core does the base insert only:
   - name: the given name, or a generated one from `agent-name-service.ts` (already unique per user with retry);
   - status `stopped`; empty prompt (blank goal); no skills, no connections, no trading profile;
   - plan limit check (`checkAgentLimit`, as `POST /agents` does today).
3. **Copy the non-trading defaults from the code, not from memory.** Model policy, tick interval, cost preset and similar fields are set by `POST /agents` in `apps/api/src/routes/agents.ts` (around L529 onward). The core must set the same values for a non-trading agent.
4. `POST /agents` keeps its current behaviour. For the base insert it calls the core, then applies the existing optional branches (trading, full payload). D7 applies: full payloads keep working for blueprint and go-live.
5. The guided chat calls the core only (see 003). The chat never sets trading fields.

## Acceptance

- Core unit tests: no name yields a unique generated name; plan limit blocks creation; the agent is `stopped` with an empty prompt, no trading profile row, and no connections.
- `POST /agents` with `{ name }` or `{}` returns 201 and the same agent shape as before.
- Existing `POST /agents` tests with full payloads pass unchanged.
- No new `any` or unchecked casts.

## Out of scope

- Removing fields from `POST /agents`.
- The first-message draft (003 handles it in the web).
