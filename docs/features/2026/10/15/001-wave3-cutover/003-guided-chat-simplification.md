# 003 Guided chat simplification (S4): deferred

**Depends on:** the shared core (001, deferred). **Blocks:** none in Wave 3.

**Status:** deferred 2026-10-15 (owner). Not in Wave 3. Kept as the record for when guided chat resumes.

## Current state

- `apps/api/src/routes/chat.ts`:
  - system prompt with trading sections; `buildCustomPrompt(userMsgTag, tradingEnabled)` around L384;
  - tools around L522 to L620: `list_compatible_connections`, `request_connection_form`, `create_connection`, `list_available_skills`, and `create_agent` with trading parameters;
  - `resolveSkillPresetSkillIds` (L674) and `generateAgentName(preset)` (L692);
  - the create handler from about L1201.
- The `guidedSetupTradingEnabled` parameter defaults to `false`, so trading is unreachable. This slice deletes the dead branches and the parameter.

## Build

1. Rewrite the system prompt for one purpose: get an optional name, confirm the channel (in-app for now), then create. It does not ask what the user wants the agent to do (owner decision, 2026-10-10).
2. Tools: keep `create_agent` with `{ name? }` only. Remove the four connection and skill tools from guided chat. Their replacements are the agent's own tools from WP-A.
3. The `create_agent` handler calls the core from 001. Trading profile creation is gone from this path by construction, because the core creates no trading profile.
4. Delete `generateAgentName(preset)`, and `resolveSkillPresetSkillIds` if nothing else calls it.
5. Remove the trading parameters: `tradingEnabled` in `buildCustomPrompt`, and `guidedSetupTradingEnabled` threaded through `chat.ts`. No config key exists. Update `chat.test.ts`, where the `true` arguments are around L510 and L1108.
6. **First message (D-4, needs owner OK).** The guided chat's first user message is returned with the created agent id. The web places it in the agent conversation composer as a draft after Start. The user sends it or edits it. The backend does not hold or store it.

## Acceptance

- A guided conversation ends in `create_agent` with a name only.
- The tool list contains only `create_agent` from the creation set.
- The prompt contains no trading text. The test asserts on the prompt and the tool list.
- `chat.test.ts` is updated for the removed flag and tools.
- The API route tests pass.
