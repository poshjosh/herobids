- **Status:** OPEN
- **Severity:** Medium
- **Date:** 2026-07-01
- **Summary:** Backend-driven strategy preset cards do not render in agent create/edit form — only the "Custom" button is shown in StrategyPresetSelector.
- **Root Cause:** The `useQuery` in `AgentFormBody` for fetching presets from `/blueprints/presets` either does not fire or returns empty data when rendered in the Docker-built web container. The backend endpoint is functional (confirmed by API tests), and the component code correctly derives the tier from agent style and passes `enabled: technicalPreFilterEnabled`. The most likely cause is a stale Docker image layer that does not include the latest `useQuery` and `agentStyleToPresetTier` additions to `AgentFormBody.tsx`, or a React Query cache/configuration issue preventing the query from running in the production build.
- **Fix:** 
  1. Verify the web Docker image is rebuilt from the latest source (`docker compose build web --no-cache`).
  2. Confirm the presets query fires by checking browser network tab for a request to `/blueprints/presets?style=standard`.
  3. If the query still does not fire, add a `refetchOnMount: true` to the `useQuery` options and ensure `agentStyle` prop is always a non-null string (not undefined).
- **Files Changed:** Pending investigation.
- **Verification:** After fix, the Strategy tab in the create/edit agent form should show preset cards (Momentum, Range, Swing, Scalper, Contrarian) from the backend API, not only the "Custom" button.
