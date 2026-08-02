# Agent Evaluation — Frontend Implementation Plan (Level 2)

**Status:** Done  
**Created:** 2026-06-29  
**Feature ID:** 001-agent-evaluation  
**Depends on:** Level 1 (operator-grade evaluation — complete)

## Context

Level 1 delivers operator-grade evaluation via API + worker. Level 2 productizes it with a user-facing UI in the web app, evaluation history, and trigger controls.

The web app (`apps/web/`) uses React + react-router v7 + @tanstack/react-query v5 + react-intl + custom UI kit (Radix primitives, Tailwind tokens). The agent detail page (`AgentDetailPage.tsx`) uses collapsible `<details>` sections inside `<Card>` components with no route-based tabs.

## Goals

1. Let users view evaluation history for an agent.
2. Let users trigger a new evaluation from the UI.
3. Let users view evaluation findings, scores, and the report inline.
4. Let users download evaluation artifacts (bundle, REPORT.md, evaluation.json).

## Non-Goals

- Scheduled/event-triggered evaluations (backend work, out of scope for this plan)
- Email summary notifications (backend work, out of scope)
- Plugin-based analyzer UI (Level 3)
- Cross-agent comparison or leaderboards

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Use Pattern A — collapsible `<details>` sections on the agent detail page | Follows existing AgentDetailPage convention; no new routes needed |
| 2 | Do NOT create a separate route (e.g. `/agents/:id/evaluations`) | Level 2 scope is modest; a separate route adds complexity without proportional value. Future Level 3 may warrant it. |
| 3 | Fetch evaluation list with `useQuery`, poll when a run is in progress | Matches existing pattern (e.g. agent status polling) |
| 4 | Render REPORT.md inline as formatted markdown | Reuse existing `react-markdown` + `remark-gfm` (already in `package.json`, used by `MarkdownPage.tsx`) |
| 5 | Download artifacts via direct API links | No separate download manager; browser handles the blob |
| 6 | Always show the Evaluations section — use internal empty state | No gating. The empty state message teaches the user: "Stop your agent to create a session, then evaluate." Avoids an extra API call to check session count. |
| 7 | Non-trading agents skip trading-specific findings in the UI | The API already marks sections `applicable: false` — UI filters on that |
| 8 | i18n keys follow the existing `agents.evaluations.*` namespace | Consistent with `agents.detail.*`, `agents.capabilities.*` |

## API Endpoints (already exist from Level 1)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/agents/:id/evaluations` | Trigger a new evaluation |
| `GET` | `/agents/:id/evaluations` | List evaluation runs (paginated) |
| `GET` | `/agents/:id/evaluations/:runId` | Get run detail with scorecard |
| `GET` | `/agents/:id/evaluations/:runId/artifacts` | List artifact manifest |
| `GET` | `/agents/:id/evaluations/:runId/artifacts/:name` | Download artifact |

## Proposed File Layout

```
apps/web/src/
  features/agents/
    AgentEvaluations.tsx           # NEW — main collapsible section component
    AgentEvaluations.test.tsx      # NEW — tests
    AgentDetailPage.tsx            # EDIT — add <AgentEvaluations /> section
  lib/
    api-client.ts                  # EDIT — add evaluations API methods
  app/
    i18n/locales/en.json           # EDIT — add agents.evaluations.* keys
```

## Phase 1: API Client + Types

### File: `apps/web/src/lib/api-client.ts` (edit)

Add evaluation API methods to the agents namespace:

```ts
evaluations: {
  list: (agentId: string, opts?: { limit?: number; offset?: number }) =>
    request<EvaluationRunRecord[]>(`/agents/${agentId}/evaluations?limit=${opts?.limit ?? 50}&offset=${opts?.offset ?? 0}`),
  get: (agentId: string, runId: string) =>
    request<EvaluationRunRecord>(`/agents/${agentId}/evaluations/${runId}`),
  trigger: (agentId: string, scope?: EvaluationScope) =>
    request<{ runId: string }>(`/agents/${agentId}/evaluations`, {
      method: 'POST',
      body: JSON.stringify({ scope: scope ?? { type: 'latestSession' } }),
    }),
  listArtifacts: (agentId: string, runId: string) =>
    request<EvaluationArtifactRef[]>(`/agents/${agentId}/evaluations/${runId}/artifacts`),
  getArtifactUrl: (agentId: string, runId: string, artifactName: string) =>
    `${apiBaseUrl}/agents/${agentId}/evaluations/${runId}/artifacts/${artifactName}`,
},
```

Reuse the domain types already exported from `@herobids/domain` (the web app already imports domain types for agents). Key types needed:

- `EvaluationRunRecord` — run metadata with status, scorecard
- `EvaluationRunStatus` — `'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out'`
- `EvaluationScorecard` — overallScore + sections
- `EvaluationSectionScore` — section score + findings + applicable flag
- `EvaluationFinding` — severity, code, title, detail
- `EvaluationArtifactRef` — name, mimeType, sizeBytes

### Tasks

- [ ] Add `evaluations` sub-object to the `agents` API namespace in `api-client.ts`.
- [ ] Verify the domain types are importable from `@herobids/domain` in the web app (check `tsconfig.json` paths).
- [ ] Register the evaluation API base URL (`VITE_API_BASE_URL`) — this is already handled by the existing config.

### Validation

- [ ] TypeScript compiles clean.
- [ ] `pnpm lint` passes.

---

## Phase 2: i18n Keys

### File: `apps/web/src/app/i18n/locales/en.json` (edit)

Add keys under the `agents` namespace:

```json
{
  "agents.evaluations.title": "Evaluations",
  "agents.evaluations.runNow": "Run Evaluation",
  "agents.evaluations.running": "Running…",
  "agents.evaluations.noEvaluations": "No evaluations yet. Stop the agent to create a session, then come back.",
  "agents.evaluations.overallScore": "Overall Score",
  "agents.evaluations.findings": "{count} {count, plural, one {finding} other {findings}}",
  "agents.evaluations.critical": "{count} critical",
  "agents.evaluations.high": "{count} high",
  "agents.evaluations.status.queued": "Queued",
  "agents.evaluations.status.running": "Running",
  "agents.evaluations.status.succeeded": "Succeeded",
  "agents.evaluations.status.failed": "Failed",
  "agents.evaluations.status.timed_out": "Timed Out",
  "agents.evaluations.scope": "Scope",
  "agents.evaluations.trigger": "Trigger",
  "agents.evaluations.triggeredAt": "Requested",
  "agents.evaluations.completedAt": "Completed",
  "agents.evaluations.downloadArtifact": "Download {name}",
  "agents.evaluations.viewReport": "View Report",
  "agents.evaluations.sectionNotApplicable": "Not applicable for this agent",
  "agents.evaluations.triggerSuccess": "Evaluation started — refreshing…",
  "agents.evaluations.triggerError": "Could not start evaluation",
  "agents.evaluations.fetchError": "Could not load evaluations"
}
```

### Tasks

- [ ] Add all keys above to `en.json`.
- [ ] Run `pnpm --filter @herobids/web exec react-intl extract` if available, or verify keys manually.

### Validation

- [ ] No missing i18n keys at runtime.

---

## Phase 3: AgentEvaluations Component

### File: `apps/web/src/features/agents/AgentEvaluations.tsx` (new)

#### Component Structure

```tsx
export function AgentEvaluations({ agentId }: { agentId: string }) {
  // ── State ────────────────────────────────────────────────────────
  // selectedRunId — which run's detail is expanded (null = list view)
  // isTriggering — mutation loading state
  // polling — whether to poll the list (enabled when any run is queued/running)

  // ── Queries ──────────────────────────────────────────────────────
  // useQuery → GET /agents/:id/evaluations (list, polls when running)
  // useMutation → POST /agents/:id/evaluations (trigger)
  // useQuery → GET /agents/:id/evaluations/:runId (detail, fetch on selection)

  // ── Render ───────────────────────────────────────────────────────
  return (
    <Card>
      <details>
        <summary>Evaluations</summary>
        <div>
          <Button onClick={trigger} loading={isTriggering}>
            Run Evaluation

          {runs.length === 0 ? (
            <EmptyState message={noEvaluations} />
          ) : (
            <>
              {/* Run list — each row shows status badge, score, trigger, timestamp */}
              <RunList runs={runs} onSelect={setSelectedRunId} selectedId={selectedRunId} />

              {/* Selected run detail — expands inline below the list */}
              {selectedRun && (
                <RunDetail
                  run={selectedRun}
                  onDownload={downloadArtifact}
                  onViewReport={viewReport}
                />
              )}
            </>
          )}
        </div>
      </details>
    </Card>
  );
}
```

#### Sub-components (co-located in same file or a sibling file)

**`RunList`** — Table or card list of evaluation runs:
- Compact row per run showing: status badge (with spinner for running), overall score (or `—` if pending), scope type, trigger type, requested date, completed date.
- Clicking a row with status `succeeded` expands the run detail below.
- Clicking a row with status `queued`/`running` shows a loading skeleton.
- Uses `RelativeTime` from `ui.tsx` for timestamps.
- Paginated — loads 50 at a time, "Load more" button at bottom if more exist.

**`RunDetail`** — Expanded view of a single run:
- **Scorecard section**: overall score as a large number (color-coded: green ≥80, yellow ≥50, red <50), section-by-section scores with findings.
- **Findings table**: severity icon + code + title, expandable detail rows.
- **Artifacts section**: download links for each artifact (evaluation.json, REPORT.md, fills.json, etc.).
- **Report viewer**: button to toggle inline markdown render of REPORT.md. Uses a lightweight markdown renderer (see Phase 4).

**`ScoreGauge`** — Simple circular or bar score display:
- Renders a number 0–100 with color coding.
- Can be a simple styled `<div>` — no need for a charting library.

**`FindingRow`** — Single finding in the findings list:
- Severity icon (🔴🟠🟡🔵⚪) + code + title.
- Click to expand detail text.

#### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No completed sessions | Show explanation text; "Run Evaluation" button still visible (API returns 404 with a clear message if no sessions exist) |
| Run is queued/running | Show spinner on status badge; poll list every 5s until terminal |
| Run failed | Show error code + message; offer to retry (re-trigger) |
| Run timed out | Show timeout message; offer to retry |
| Agent has trading + non-trading sections | Filter non-applicable sections via `applicable: false` |
| Artifact download fails | Show toast error via existing toast system |
| Multiple evaluations for same agent | List all, newest first; pagination at 50 |
| User triggers evaluation while one is running | API returns 409 — show a toast: "An evaluation is already running for this agent" |
| Zero findings | Show "No issues found — all checks passed" |

### Tasks

- [ ] Implement `AgentEvaluations` main component.
- [ ] Implement `RunList` sub-component.
- [ ] Implement `RunDetail` sub-component.
- [ ] Implement `ScoreGauge` helper.
- [ ] Implement `FindingRow` helper.
- [ ] Handle all edge cases listed above.
- [ ] Add polling logic for in-progress runs.
- [ ] Handle 409 conflict on trigger.

### Validation

- [ ] Component renders without errors with mock data.
- [ ] Clicking "Run Evaluation" triggers a POST and polls until complete.
- [ ] Expanding a completed run shows scorecard and findings.
- [ ] Download links work.
- [ ] Non-trading sections are hidden/marked as not applicable.

---

## Phase 4: Markdown Report Viewer

### Decision

Reuse the existing `react-markdown` ^9.1.0 + `remark-gfm` ^4.0.1 already in `apps/web/package.json` and used by `MarkdownPage.tsx` for public content pages. Zero new dependencies.

### File: `apps/web/src/features/agents/AgentEvaluationReport.tsx` (new, or co-located)

```tsx
function AgentEvaluationReport({ content }: { content: string }) {
  return (
    <div style={{ 
      padding: '16px', 
      background: 'var(--color-surface-2)', 
      borderRadius: '8px',
      maxHeight: '60vh',
      overflow: 'auto',
    }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

### Tasks

- [ ] Implement `AgentEvaluationReport` component wrapping `ReactMarkdown`.
- [ ] Lazy-load the report content (fetch on expand, not on page load).
- [ ] Handle loading/error states for report fetch.

### Validation

- [ ] REPORT.md renders correctly with headings, lists, code blocks.
- [ ] Large reports scroll within a constrained height.

---

## Phase 5: Integration into AgentDetailPage

### File: `apps/web/src/features/agents/AgentDetailPage.tsx` (edit)

Add the `<AgentEvaluations>` section after the existing "Activity Timeline" section. No gating — the section always renders. The component handles its own empty state internally.

```tsx
{/* Evaluations */}
<AgentEvaluations agentId={id} />
```

### Tasks

- [ ] Add `AgentEvaluations` import to `AgentDetailPage.tsx`.
- [ ] Add the section to the page layout (after Activity Timeline).
- [ ] Ensure the section order makes sense.

### Validation

- [ ] Section always appears on the agent detail page.
- [ ] Empty state renders correctly for agents with no sessions.
- [ ] Existing sections are unaffected.

---

## Phase 6: Tests

### File: `apps/web/src/features/agents/AgentEvaluations.test.tsx` (new)

Test patterns follow the existing `AgentDetailPage.test.tsx` style:

```tsx
// Mock API client
vi.mock('../../lib/api-client.js', () => ({
  agents: {
    evaluations: {
      list: vi.fn(),
      trigger: vi.fn(),
      get: vi.fn(),
      listArtifacts: vi.fn(),
      getArtifactUrl: vi.fn(),
    },
    get: vi.fn(),
  },
}));
```

### Test Cases

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Renders empty state when no evaluations exist | Empty state message is shown |
| 2 | Renders run list when evaluations exist | Each run shows status, score, timestamp |
| 3 | Shows spinner for running/queued statuses | StatusBadge has pulse animation |
| 4 | Expands run detail on click | Scorecard, findings table, artifact links are visible |
| 5 | Triggers evaluation on button click | POST is called, list refreshes |
| 6 | Shows 409 toast when evaluation already running | Toast appears with conflict message |
| 7 | Polls list while a run is queued/running | query is refetched on interval |
| 8 | Filters non-applicable sections | Trading sections hidden for non-trading agents |
| 9 | Handles download by opening artifact URL | Correct URL is constructed |
| 10 | Shows error state when list fetch fails | ErrorState component renders with retry |

### Tasks

- [ ] Write test file with all cases above.
- [ ] Mock `useIntl` via existing test wrapper pattern.
- [ ] Mock `api-client.ts` evaluation methods.

### Validation

- [ ] All tests pass with `pnpm --filter @herobids/web test`.

---

## Build Order

1. **Phase 1** — API client + types (unblocks UI work)
2. **Phase 2** — i18n keys (needed before component strings)
3. **Phase 3** — AgentEvaluations component (core deliverable)
4. **Phase 4** — Markdown report viewer (enables inline report viewing)
5. **Phase 5** — Integration into AgentDetailPage (wires it up)
6. **Phase 6** — Tests (validate after integration)

## Dependencies

| Dependency | Status |
|------------|--------|
| Level 1 API endpoints | ✅ Complete |
| Domain types in `@herobids/domain` | ✅ Already exported |
| `react-markdown` + `remark-gfm` | ✅ Already in `apps/web/package.json`, used by `MarkdownPage.tsx` |
| i18n extraction tooling | ✅ Already configured |

## Estimated Effort

2–3 engineering days.
