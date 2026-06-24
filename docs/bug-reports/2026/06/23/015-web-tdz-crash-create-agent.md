# 015 — Web production build crashes: TDZ `Cannot access 'A' before initialization`

- **Status:** FIXED
- **Severity:** High (blocks all create-agent E2E journeys)
- **Date:** 2026-06-23
- **Summary:** The production web bundle crashes with `ReferenceError: Cannot access 'A' before initialization` when rendering the create-agent form on the `/agents` page. This blocks 5 of 19 E2E tests and the manual UATs for agent creation.
- **Root Cause:** Unknown — likely a circular import or module-level `const`/`let` accessed before its declaration executes in the production bundle. The `A` is a minified variable name. The error occurs deep in React's reconciliation.
- **Impact:** E2E tests 01, 04, 07, 08, 14 all timeout waiting for `input[type="text"]` (the Name field in the create-agent form) because the React error boundary shows "Unexpected Application Error!" instead of the form.
- **Reproduction:**
  1. Build the web Docker image: `docker compose -f docker-compose.yaml build web`
  2. Start the stack: `docker compose -f docker-compose.yaml up -d`
  3. Navigate to `/agents`
  4. Click "New AI Agent"
  5. Observe the React error boundary
- **Notes:** The dev server (`pnpm --filter @herobids/web run dev`) does NOT exhibit this crash — it only occurs in the production (minified) build. This suggests a bundler/minifier-specific initialization order issue. The previous similar bug (012-agent-tickcount-temporal-dead-zone-crash) was in the worker's `agent.ts` and was fixed by moving `let` declarations before their call sites.
- **Files suspected:**
  - `apps/web/src/features/agents/AgentsPage.tsx` (recently modified for simplified create-agent flow)
  - `apps/web/src/features/agents/AgentControlsSection.tsx`
  - `apps/web/src/features/agents/agent-cadence.ts` (new file)
  - `apps/web/src/features/agents/style-mapping.ts` (new file)
  - `apps/web/src/features/agents/agent-name.ts` (new file)
- **Investigation (2026-06-23):**
  - Circular dep `technical-config-helpers.ts` ↔ `technical-presets.ts` found and fixed (extracted shared types to `technical-types.ts`). No other circular deps detected via madge.
  - However, the fix did NOT resolve the TDZ crash — the circular dep was type-only (`import type`), so the JS output was identical.
  - `docker build --no-cache` confirmed the production bundle hash is unchanged by these edits.
  - The TDZ variable `A` maps to `_mergeNamespaces` (line 18 in unminified bundle) — suggesting the crash is in Rollup's module initialization helpers, not application code.
  - The dev server (`vite dev`) works correctly; only the production (Rollup-bundled) build crashes.
  - Next step: build with `vite build --minify false` and test in Docker to get an unminified stack trace; or use `preserveModules` to avoid TDZ from module ordering.
- **Follow-up (2026-06-23):** After the TDZ fix, a **new** issue surfaced: the `AdvancedSettingsSection` accordion (Phase 8, commit `e5a2e97`) collapses the Skills section, making skill checkboxes inaccessible to E2E tests. This blocks the same set of E2E tests (J1, J4, J7, J8, J14) but for a different reason. See bug **016** for the accordion fix.
