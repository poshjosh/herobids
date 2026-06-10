# LLM SELECTION PLAN

## Scope

This plan covers:

1. Adding explicit user AI defaults for one `provider`, one `lightModel`, and one `heavyModel`.
2. Surfacing those defaults in Settings.
3. Surfacing per-agent model overrides in create and edit flows.
4. Making the worker runtime resolve models in this order:
   - agent override
   - user default
   - operator fallback

This plan intentionally excludes:

1. Deprecating `LLM_API_KEY_OPENROUTER`, `LLM_API_KEY_ANTHROPIC`, and `LLM_API_KEY_OPENAI`.
2. A broader redesign of all agent runtime fields beyond model selection and one small create-form parity item noted below.

## Current State

1. User AI preferences exist only in `apps/api/src/routes/ai.ts`.
   - `AiModelPatchSchema` currently stores `primary`, `fallback1`, and `fallback2`.
   - `resolveUserLlmConfig()` reads those fields and only accepts them when the chosen provider has a dedicated provider-specific key.
   - There is `PATCH /settings/ai-model`, but there is no matching read endpoint for the web app.

2. Settings UI does not expose AI model settings.
   - `apps/web/src/features/settings/SettingsPage.tsx` only handles locale and Telegram.
   - `apps/web/src/lib/api-client.ts` has no `ai` client helper and `MeResponse` does not include `aiModelConfig`.

3. Agent CRUD already has a partial model-policy surface.
   - `apps/api/src/routes/agents.ts` supports `modelPolicy` plus the legacy convenience field `scoutModel`.
   - `mergeModelPolicy()` and `decorateAgentResponse()` only normalize `scoutModel`, `costPreset`, `dailySpendBudgetUsd`, and `dexWatchlistSymbols`.
   - Create and update schemas do not expose a canonical `provider`, `lightModel`, `heavyModel` contract.

4. Agent UI does not expose model settings.
   - `apps/web/src/features/agents/AgentsPage.tsx` create flow collects goal, skills, execution mode, and trading setup only.
   - `apps/web/src/features/agents/EditAgentModal.tsx` exposes execution mode, Telegram, and risk/budget fields, but no model fields.

5. Worker runtime still assumes the heavy model is operator-owned and the light model is scout-specific.
   - `apps/worker/src/agent.ts` uses `LLM_PROVIDER` and `LLM_MODEL` as the effective main model.
   - `AgentConfig` in that file understands `scoutModel`, not `lightModel` and `heavyModel`.
   - `apps/worker/src/cost-profile.ts` takes `judgeModel` and `scoutModel`.
   - `apps/worker/src/agents/agent-session-manager.ts` only forwards `scoutModel` from `agent.modelPolicy` into `AGENT_CONFIG`.

6. Profile transport is split today.
   - `apps/api/src/routes/auth.ts` returns `preferredLocale` and `telegramChatId` from `GET /auth/me` and updates them in `PATCH /auth/me`.
   - AI settings are managed separately in `apps/api/src/routes/ai.ts`.

## Product Contract

1. The canonical persisted user model selection should become:
   - `provider`
   - `lightModel`
   - `heavyModel`

2. The canonical persisted agent override should become the same shape inside `modelPolicy`:
   - `provider`
   - `lightModel`
   - `heavyModel`

3. The UI should describe these as cost and capability tiers, not pipeline phases.
   - Use user-facing labels such as `Economy model` and `Premium model`.
   - Keep the stored contract as `lightModel` and `heavyModel`.

4. A single provider field should apply to both models.
   - The user selects one provider.
   - Both `lightModel` and `heavyModel` must come from that provider's catalog.
   - The API should reject mixed-provider payloads by construction rather than inference.

5. Runtime precedence should be explicit.
   - Agent-level override wins.
   - User settings are the fallback.
   - Operator config remains the final fallback.

## Implementation Plan

1. Replace the user preference chain with an explicit settings contract in `apps/api/src/routes/ai.ts`.
   - Replace `AiModelPatchSchema` so it accepts one object shape with `provider`, `lightModel`, and `heavyModel` instead of `primary`, `fallback1`, and `fallback2`.
   - Add a route-local schema for the persisted settings object and use it for both validation and normalization.
   - Update `resolveUserLlmConfig()` so it resolves explicit `provider`, `lightModel`, and `heavyModel` defaults rather than iterating `primary` then fallbacks.
   - Dependency: this is the foundation for every later API and UI step.
   - Risk: existing rows in `users.ai_model_config` may still hold the old shape and must not break reads.

2. Add a read endpoint for model settings in `apps/api/src/routes/ai.ts`.
   - Add `GET /settings/ai-model` so the web app can load the current saved selection without depending on `PATCH` response state.
   - Keep `PATCH /settings/ai-model` as the write endpoint.
   - Return the normalized stored shape, not the raw DB blob.
   - Dependency: step 1.
   - Risk: if the route returns raw legacy data, the Settings page will need conditional parsing in the browser.

3. Keep `GET /auth/me` focused on profile fields in `apps/api/src/routes/auth.ts`.
   - Do not fold `aiModelConfig` into `GET /auth/me` for this feature.
   - Continue using `GET /auth/me` and `PATCH /auth/me` for locale and Telegram only.
   - Rationale: this preserves the current separation between profile settings and AI settings and avoids coupling unrelated caches.
   - Dependency: none.
   - Open question: if the team wants one combined settings payload later, that should be a separate cleanup task.

4. Normalize agent model policy in `apps/api/src/routes/agents.ts`.
   - Extend `CreateAgentSchema` and `UpdateAgentSchema` to accept `provider`, `lightModel`, and `heavyModel` as first-class fields alongside `modelPolicy`.
   - Update `mergeModelPolicy()` so it writes those fields into `modelPolicy` and can remove them when `null` is supplied on update.
   - Update `decorateAgentResponse()` so the flattened API response includes `provider`, `lightModel`, and `heavyModel` in the same way it currently exposes `scoutModel`.
   - Treat `scoutModel` as a legacy input/output compatibility field only for a transition period.
   - Dependency: step 1 so the naming is settled before the agent API mirrors it.
   - Risk: if the route exposes both `scoutModel` and `lightModel` indefinitely, the frontend contract will stay ambiguous.

5. Add compatibility handling for legacy stored data in `apps/api/src/routes/ai.ts` and `apps/api/src/routes/agents.ts`.
   - Read old `users.ai_model_config.primary` and map it into the new explicit shape when possible.
   - Read old `agent.modelPolicy.scoutModel` and map it to `lightModel` when `lightModel` is absent.
   - Do not silently invent a `heavyModel`; fall back to operator config until the user or agent is updated.
   - Dependency: steps 1 and 4.
   - Risk: lossy migration logic can create false certainty about what the user intended.

6. Add dedicated web API helpers in `apps/web/src/lib/api-client.ts`.
   - Add response types for available models and model settings.
   - Add a new `ai` client namespace with helpers for:
     - `GET /ai/available-models`
     - `GET /settings/ai-model`
     - `PATCH /settings/ai-model`
   - Extend the `Agent` type and `agents.create()` / `agents.update()` payload types to include `provider`, `lightModel`, and `heavyModel`.
   - Keep `auth.me()` and `auth.updateMe()` focused on locale and Telegram.
   - Dependency: steps 2 and 4.

7. Add a reusable model selection form section in the web app.
   - Create a shared component under the agent or settings feature surface, for example a new component alongside the existing settings and agent form code.
   - The shared section should own:
     - provider select
     - light model select
     - heavy model select
     - descriptive helper copy for economy/premium positioning
     - loading and invalid selection reset when the provider changes
   - The host page should own only submit behavior and inheritance copy.
   - Dependency: step 6.
   - Risk: duplicating provider/model selection logic separately in Settings and agent forms will drift quickly.

8. Extend `apps/web/src/features/settings/SettingsPage.tsx` with an AI models card.
   - Fetch current saved model settings using the new AI settings read endpoint.
   - Fetch provider/model options from `/ai/available-models`.
   - Add a third settings card beside the existing locale and Telegram cards.
   - Use copy that explains `lightModel` as the economy/default lower-cost slot and `heavyModel` as the premium/higher-capability slot.
   - Save through `PATCH /settings/ai-model`.
   - Keep the existing locale and Telegram mutations separate so one settings edit does not overwrite another.
   - Dependency: steps 2, 6, and 7.
   - Risk: if available models load after saved settings, the page needs a normalized pending state rather than flashing empty selects.

9. Add model override controls to the create flow in `apps/web/src/features/agents/AgentsPage.tsx`.
   - Extend `IntentState` to carry `provider`, `lightModel`, and `heavyModel`.
   - Load user defaults when the create modal opens and prefill the model fields from saved settings.
   - Show the model section in the intent step, not only in the review step, so users understand what will govern runtime behavior before submitting.
   - Include the selected provider and model summary in the review screen.
   - Submit the new fields via `agentsApi.create()`.
   - Dependency: steps 6 through 8.
   - Risk: if create form defaults are fetched asynchronously after the user starts typing, they must not overwrite manual edits.

10. Add model override controls to the edit flow in `apps/web/src/features/agents/EditAgentModal.tsx`.
   - Extend `FormState` to include `provider`, `lightModel`, and `heavyModel`.
   - Prepopulate from the existing agent when explicit overrides exist.
   - If the agent has no explicit override, show inherited user defaults clearly rather than pretending the agent owns those values.
   - Allow clearing the override so the agent falls back to user defaults again.
   - Submit the fields through `agentsApi.update()`.
   - Dependency: steps 4, 6, 7, and 8.
   - Risk: the form needs a clear distinction between `explicitly unset` and `inherit`, otherwise PATCH semantics will be wrong.

11. Add one small create/edit parity improvement while the forms are already being touched.
   - In `apps/web/src/features/agents/AgentsPage.tsx`, add a Telegram notification field to the create flow and prefill it from `GET /auth/me` when available.
   - Extend `agentsApi.create()` in `apps/web/src/lib/api-client.ts` to pass `telegramChatId`, which is already accepted by `CreateAgentSchema` in `apps/api/src/routes/agents.ts`.
   - Keep the broader audit of additional agent fields as a separate feature after model selection lands.
   - Dependency: step 6.
   - Rationale: this is already part of the discussed form parity gap and uses existing backend support.

12. Change worker launch payload construction in `apps/worker/src/agents/agent-session-manager.ts`.
   - Stop forwarding only `scoutModel` from `agent.modelPolicy`.
   - Forward explicit `provider`, `lightModel`, and `heavyModel` fields into `agentConfig`.
   - Preserve existing `costPreset`, `dailySpendBudgetUsd`, and `dexWatchlistSymbols` forwarding.
   - Dependency: step 4.
   - Risk: if the worker receives a partially migrated payload, the launch path must still normalize it before use.

13. Update runtime config parsing and resolution in `apps/worker/src/agent.ts`.
   - Replace `AgentConfig.scoutModel` with `lightModel` and `heavyModel` support.
   - Introduce one local resolver that computes the effective provider, light model, and heavy model from:
     - agent config
     - user defaults forwarded in config or resolved before launch
     - operator `LLM_PROVIDER` and `LLM_MODEL`
   - Keep `LLM_PROVIDER` and `LLM_MODEL` as fallback defaults for this feature.
   - Use the resolved heavy model where the runtime currently uses `LLM_MODEL` as the main model.
   - Use the resolved light model where the runtime currently uses `agentConfig.scoutModel` or `resolveDefaultScoutModel()`.
   - Dependency: step 12.
   - Risk: scattered direct reads of `LLM_MODEL` or `agentConfig.scoutModel` will create split-brain behavior if they are not centralized.

14. Rename cost-profile inputs to match the new contract in `apps/worker/src/cost-profile.ts`.
   - Replace `judgeModel` and `scoutModel` inputs with `heavyModel` and `lightModel`.
   - Keep current cost-preset behavior, but base it on the new names.
   - Where minimal or custom presets intentionally collapse to the lighter model, do that through `lightModel`, not scout-specific naming.
   - Dependency: step 13.
   - Risk: semantic renaming without updating all call sites will silently flip the intended cost profile.

15. Update scout/default helpers only as compatibility plumbing in `apps/worker/src/scout-dispatch.ts` and call sites.
   - Keep `resolveDefaultScoutModel()` only until the runtime has fully moved to `lightModel` naming.
   - Either rename it to a neutral helper or wrap it behind a compatibility layer in `apps/worker/src/agent.ts`.
   - Do not expose `scout` terminology in the new UI or API.
   - Dependency: steps 13 and 14.
   - Open question: whether to rename the helper immediately or keep a transitional internal name for a smaller diff.

16. Keep provider availability explicit in `apps/api/src/routes/ai.ts`.
   - `GET /ai/available-models` should continue to advertise only providers/models that the backend can actually serve.
   - The response should remain grouped by provider so the UI can drive a single provider select and then dependent model selects.
   - Do not infer provider from model name anywhere in the web or worker layers.
   - Dependency: steps 1 and 8.
   - Risk: violating the repo config rule against inferred provider selection will recreate the same ambiguity the redesign is trying to remove.

17. Add i18n keys for the new Settings and agent-form copy in `apps/web/src/app/i18n/locales/en.ts`, `ar.ts`, and `hi.ts`.
   - Add labels, helper text, inheritance text, loading text, and validation messages for provider, economy model, and premium model.
   - Extend `apps/web/src/app/i18n/i18n-regressions.test.ts` with assertions for the new keys.
   - Dependency: steps 7 through 10.
   - Risk: shipping English-only model-selection copy will regress the work already done on settings and agent i18n coverage.

18. Add backend tests for the new settings and agent contract.
   - Update `apps/api/src/routes/ai.test.ts` for:
     - `GET /settings/ai-model`
     - `PATCH /settings/ai-model` with `provider`, `lightModel`, `heavyModel`
     - compatibility reads from legacy `primary`/`fallback*`
     - rejection of incomplete or invalid payloads
   - Update `apps/api/src/routes/agents.test.ts` for:
     - create/update with `provider`, `lightModel`, `heavyModel`
     - clearing agent overrides back to inheritance
     - decoration of flattened response fields
   - Dependency: steps 1 through 5.

19. Add focused web tests for Settings and agent forms.
   - Add Settings tests to cover:
     - loading current model settings
     - switching provider resets invalid model selections
     - saving and success state
   - Add create-flow tests in `apps/web/src/features/agents` to cover:
     - defaults loading from user settings
     - editing provider/light/heavy before submit
     - Telegram prefill behavior
     - review-step summary
   - Add edit-modal tests to cover:
     - explicit override rendering
     - inheritance rendering
     - clearing overrides
   - Dependency: steps 7 through 11.

20. Add runtime tests for effective model resolution.
   - Add or update worker tests around `apps/worker/src/agent.ts`, `apps/worker/src/cost-profile.ts`, and `apps/worker/src/agents/agent-session-manager.ts` to prove:
     - agent override wins over user defaults and operator fallback
     - user defaults win over operator fallback
     - legacy `scoutModel` still maps to `lightModel` during transition
     - premium-heavy work uses the resolved `heavyModel`
     - economy-light work uses the resolved `lightModel`
   - Dependency: steps 12 through 15.

21. Document the inheritance model and rollout in product-facing docs.
   - Update the relevant feature or operator docs after implementation to explain:
     - one provider, two model slots
     - settings defaults versus agent overrides
     - operator fallback behavior when no explicit selection exists
   - Dependency: implementation completion.

## Test Strategy

1. Unit tests
   - `apps/api/src/routes/ai.test.ts`
   - `apps/api/src/routes/agents.test.ts`
   - worker tests covering new effective model resolution and cost-profile behavior
   - web component tests for the shared model selection section

2. Integration tests
   - Settings page integration around fetching available models plus saved settings and persisting updates
   - create-agent integration covering inheritance from user defaults and request payload shape
   - edit-agent integration covering explicit override and clear-to-inherit behavior

3. End-to-end or functional checks
   - one browser journey that sets model defaults in Settings, creates an agent, verifies inherited defaults in review/edit, then overrides them
   - one API-functional check that starts with legacy stored config and verifies normalized read behavior

4. Validation command sequence after implementation
   - targeted vitest suites for API routes, worker resolution, and touched web components
   - `pnpm lint`

## Risks And Open Questions

1. Read shape versus write shape
   - The API should not return raw legacy blobs once the new contract exists.

2. Inheritance UX
   - The edit flow needs a clear `inherit from settings` state. Without it, users will not know whether an agent owns its current values.

3. Transition timing for `scoutModel`
   - The codebase can keep a compatibility bridge briefly, but the new plan should not add any new user-facing `scout` naming.

4. Broader agent form audit
   - The discussed generic versus capability-specific runtime fields should be planned separately once model selection is stable.

5. Runtime default behavior
   - If `heavyModel` is unset on both agent and user settings, the worker should fall back to operator `LLM_MODEL` instead of guessing from the light model.