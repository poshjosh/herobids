# Plan: Agent Observability Rollout

## Goal

Turn agent activity into a first-class operator surface so a user can answer,
from the frontend, what the agent is doing, what happened recently, why it
failed, what tools it called, whether a tick was skipped, and what the agent
communicated outward.

This rollout should fix two existing structural gaps at the same time:

1. shared activity surfaces are still bot-centric rather than agent-centric
2. the current agent Protocol Activity panel is too thin to explain behavior

The plan is split into two delivery phases:

1. Phase 1 establishes a durable, useful agent observability baseline across
   the existing frontend surfaces
2. Phase 2 extends that baseline into a richer operator console and broader
   cross-agent observability experience

## Confirmed Baseline

1. the main agent-specific frontend surface is `apps/web/src/features/agents/AgentDetailPage.tsx`
2. the current Protocol Activity panel is backed by durable rows from `agent_messages`, but the UI only renders type and timestamp
3. the shared Activity page and Mission Control recent activity column are backed by `GET /dashboard/activity`, which currently normalizes bot journal events rather than agent activity
4. outbound user-facing agent messages already have a dedicated durable table and frontend panel
5. the frontend already has a real-time `/events` WebSocket path, but it is mostly used to invalidate queries rather than render a canonical event stream
6. backend support already exists for agent interactivity and memory inspection, but those are not yet central to the current plan

## Product Principles

1. the agent detail page should become the primary operator console for a single agent
2. Mission Control should remain summary-oriented rather than becoming a second full observability console
3. the shared Activity page should become actor-aware instead of remaining effectively bot-only
4. operator-facing activity should use one normalized agent activity contract instead of separate ad hoc formats per screen
5. the UI should expose structured summaries and compact details, not raw model reasoning or giant payload dumps
6. failure reasons, tool calls, and skipped ticks are core observability signals and belong in the first phase
7. the default timeline row should be pleasant to read by a human, with only time, severity, title, summary, and a clear More affordance visible at first glance
8. session IDs, correlation IDs, trace IDs, direction, and similar debugging metadata should live behind expansion rather than in the main reading line

## Timeline UX Agreement

The timeline should be narrative-first and diagnostic-second.

### Default row content

Each collapsed row should show only:

1. time
2. severity
3. title
4. one-line summary
5. an explicit More affordance

Example reading shape:

- `12:03:11` Session started
   Agent runtime launched and heartbeat monitoring is active.
- `12:03:42` Tick skipped
   No material market change since last evaluation.
- `12:03:44` Decision rejected
   Proposed entry was blocked by risk validation.

### Expanded row content

The expanded view should hold the operator-debugging details that are useful but
not pleasant as primary reading material, such as:

1. reason text
2. tool name and compact input or output summary
3. symbol, intent, requested action, or other event-specific fields
4. session ID when relevant
5. correlation ID or trace ID when relevant
6. raw status or direction when relevant

The title should remain short and human-readable, and the summary should remain
one plain-language sentence.

## Non-Goals

1. expose model chain-of-thought, hidden reasoning text, or provider-specific thinking traces
2. replace all existing bot journal and bot detail surfaces
3. build a standalone observability product before the current agent detail page is upgraded
4. solve deep historical analytics, cross-agent reporting, or trend dashboards in the first phase

## Canonical Agent Activity Model

The implementation should define one normalized backend contract for agent
activity and reuse it across the agent detail page, Mission Control, and the
shared Activity page.

Each activity entry should include at minimum:

- `id`
- `agentId`
- `timestamp`
- `category`
- `severity`
- `eventType`
- `title`
- `summary`
- `detail`

Each activity entry may also include hidden-by-default operator metadata for the
expanded view:

- `sessionId | null`
- `direction | null`
- `processingStatus | null`
- `correlationId | null`
- `traceId | null`

Recommended top-level categories:

1. `runtime`
2. `decision`
3. `tool`
4. `tick`
5. `message`
6. `artifact`
7. `risk`
8. `system`

Recommended first-phase event families:

1. runtime started
2. runtime unhealthy
3. runtime recovered
4. runtime failed
5. decision accepted
6. decision rejected
7. tool call started
8. tool call completed
9. tool call failed
10. tick skipped
11. outbound message authored
12. platform alert raised
13. artifact published

Each event family should have a stable operator-facing summary rather than a raw
message type name.

## Phase 1: Operator Visibility Baseline

### Outcome

An operator can open an agent and understand the agent's current health,
recent activity, failure reasons, tool usage, skipped ticks, decisions, and
user-facing outputs without leaving the existing product surfaces.

### Scope

1. replace the thin Protocol Activity panel with a real agent timeline on the agent detail page
2. add explicit support for failure reasons, tool-call activity, and skipped-tick reasons
3. make Mission Control recent activity agent-aware instead of bot-only
4. make the shared Activity page agent-aware instead of relying solely on bot journal events
5. keep outbound user messages and artifacts visible, but align them with the new timeline model
6. keep real-time behavior simple by using the existing event stream to refresh canonical activity queries quickly

### Detailed Plan

1. Define the normalized agent activity DTO and event taxonomy.
   Files: new agent-activity mapper types near the API route layer, plus matching web client types.
   Change: convert low-level protocol rows and related agent events into a stable operator-facing shape with category, severity, title, summary, detail, and hidden-by-default operator metadata for expanded inspection.
   Dependency: none.

2. Introduce a dedicated backend agent activity endpoint.
   Files: `apps/api/src/routes/agents.ts` or a new route module.
   Change: add a canonical `GET /agents/:id/activity-feed` style endpoint that merges or normalizes agent protocol rows, runtime session transitions, decision outcomes, outbound message records, platform alerts, artifacts, and first-phase tick/tool events.
   Dependency: step 1.

3. Enrich activity generation for failures, tool calls, and skipped ticks.
   Files: worker runtime/event publishing paths such as `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`, broker or runtime instrumentation files, and any durable persistence layer needed.
   Change: persist or emit structured events that answer three operator questions directly: why the agent failed, what tool it called and how it ended, and why a tick was skipped.
   Dependency: steps 1 and 2.

4. Replace the current Protocol Activity panel on the agent detail page with a typed timeline.
   Files: `apps/web/src/features/agents/AgentDetailPage.tsx` and new presentational components for activity rows and row details.
   Change: render category-aware timeline entries with only time, severity, title, summary, and a More affordance visible by default, then place session, correlation, reason, status, and short tool or failure metadata inside the expanded detail area.
   Dependency: steps 1 through 3.

5. Keep runtime health visible and add session context around the new timeline.
   Files: `apps/web/src/features/agents/AgentDetailPage.tsx`.
   Change: preserve the current runtime health strip, but connect it to the canonical activity model and show enough recent session context to understand start, unhealthy, recovery, and stop boundaries.
   Dependency: step 4.

6. Align outbound user messages and artifacts with the new activity experience.
   Files: `apps/web/src/features/agents/AgentDetailPage.tsx`, relevant API client types.
   Change: keep the dedicated message and artifact sections, but ensure they reflect the same operator story and can cross-link mentally to the timeline's corresponding events.
   Dependency: step 4.

7. Make Mission Control recent activity agent-aware.
   Files: `apps/web/src/features/mission-control/MissionControlPage.tsx`, API route(s), and web client types.
   Change: replace or augment the current bot-centric recent activity data source with a condensed agent activity feed that emphasizes attention-worthy runtime, decision, risk, and failure signals.
   Dependency: steps 1 through 3.

8. Make the shared Activity page actor-aware.
   Files: `apps/api/src/routes/dashboard.ts`, `apps/web/src/features/activity/ActivityFeedPage.tsx`, `apps/web/src/features/activity/ActivityItem.tsx`, and related client types.
   Change: add an agent-aware mode, tab, or unified feed so the page no longer represents only bot journal activity while claiming to be the platform activity surface.
   Dependency: steps 1 through 3.

9. Reuse the existing real-time event stream only as a lightweight freshness path.
   Files: `apps/web/src/lib/useEventStream.ts`, agent and Mission Control query invalidation logic, and any small backend event additions required.
   Change: keep WebSocket usage pragmatic by invalidating the canonical activity queries on relevant agent events rather than building a second, richer client-only event model in this phase.
   Dependency: steps 4 through 8.

10. Add focused tests for the contract and key UI states.
    Files: API route tests, mapper tests, activity component tests, and any agent detail tests.
    Change: cover runtime failure rendering, tool call summaries, skipped tick reasons, Mission Control recent activity, and shared Activity page agent-mode behavior.
    Dependency: steps 1 through 9.

### Phase 1 Exit Criteria

1. the agent detail page shows a useful, typed agent timeline rather than raw message types only
2. the timeline answers whether the agent failed, why it failed, what tools it called, and whether a tick was skipped and why
3. the default timeline rows are narrative and easy to read, with operator-debugging details hidden behind expansion
4. Mission Control recent activity is no longer strictly bot-centric
5. the shared Activity page can surface agent activity rather than only bot journal events
6. outbound user messages and artifacts remain visible and understandable alongside the new timeline
7. real-time updates keep the experience fresh without inventing a second event contract

## Phase 2: Ideal-State Agent Console

### Outcome

The product evolves from a useful baseline into a richer operator console with
deeper drill-down, better interactivity, and broader cross-agent visibility.

### Scope

1. richer session history and session drill-in
2. stronger cross-linking between decisions, tool calls, messages, artifacts, and runtime state transitions
3. operator interactivity such as message-to-agent and memory inspection where appropriate
4. better cross-agent views in Mission Control and the shared Activity page
5. optional dedicated observability surface if the upgraded agent detail page proves insufficient

### Detailed Plan

1. Add a proper session history panel and per-session drill-in.
   Files: agent detail frontend, agents API routes, and possibly a dedicated session endpoint.
   Change: make sessions directly inspectable, including lifecycle boundaries, health transitions, and per-session counts or summaries.
   Dependency: Phase 1 complete.

2. Add event linking and richer detail views.
   Files: timeline components and backend detail fields.
   Change: connect decisions to related tool calls, messages, artifacts, and failure events using correlation and session context so operators can follow one chain of action.
   Dependency: step 1.

3. Surface operator-to-agent messaging in the frontend.
   Files: web client API layer, agent detail UI, and supporting route tests.
   Change: expose the existing backend path for sending a message to a running agent as a controlled operator action in the agent console.
   Dependency: step 1.

4. Surface agent memory inspection where it materially helps debugging.
   Files: web client API layer, optional agent detail subpanel, and supporting tests.
   Change: expose the existing backend memory inspection route in a read-oriented operator tool rather than making it a default first-view surface.
   Dependency: step 1.

5. Improve shared cross-agent visibility.
   Files: Mission Control, shared Activity page, and supporting API routes.
   Change: add better filtering, actor scoping, and summary cards for unhealthy agents, repeated decision rejections, or tool-failure concentration.
   Dependency: steps 1 through 4.

6. Evaluate whether a dedicated agent observability route is warranted.
   Files: new route and page only if Phase 1 and Phase 2 enhancements still leave a gap.
   Change: create a separate observability page only after the canonical activity model and upgraded agent detail page have proven insufficient.
   Dependency: steps 1 through 5.

### Phase 2 Exit Criteria

1. operators can inspect a given run in session terms rather than only as a flat feed
2. activity entries can be followed across decisions, tools, messages, and artifacts
3. operator interactivity is available from the agent console where useful
4. cross-agent summaries help identify which agents need attention without losing the single-agent console as the source of truth

## Implementation Notes

1. keep the canonical agent activity mapper at the API boundary so the frontend consumes stable operator-facing data rather than raw tables
2. prefer summary-plus-detail UI over raw JSON and avoid exposing model reasoning text
3. do not let Mission Control and the shared Activity page invent their own agent event models; both should reuse the same normalized contract
4. treat correlation IDs, session IDs, and processing status as operator-debugging metadata for the expanded view, not as primary row titles
5. keep first-phase scope disciplined by upgrading existing screens before creating new routes

## Test Strategy

1. API-level tests for normalized agent activity mapping and filters
2. worker or integration tests for failure, tool-call, and skipped-tick event production
3. frontend tests for timeline rendering across severity, category, and expansion states
4. Mission Control tests proving recent activity is agent-aware
5. shared Activity page tests proving agent activity is visible and not only bot activity
6. validation command: `pnpm lint`

## Ordered Delivery Sequence

1. define the normalized agent activity contract
2. build the backend canonical agent activity endpoint
3. instrument failure, tool-call, and skipped-tick events
4. replace the agent detail Protocol Activity panel with a real timeline
5. connect runtime health and session context to that timeline
6. update Mission Control recent activity to use the same agent-aware model
7. update the shared Activity page to expose agent activity
8. add focused tests and rollout checks
9. expand into session drill-in, operator interactivity, and richer cross-agent views in Phase 2

## Open Decisions

1. whether the shared Activity page should ship as a unified mixed feed or as explicit bot and agent tabs in the first phase
2. whether tool-call rows should show duration in the initial contract or only after instrumentation is complete
3. how much of outbound message activity should appear in the unified timeline versus remaining only in the dedicated messages panel
4. whether runtime recovery should be its own explicit event type or represented through session status transitions only
5. whether a dedicated agent observability route will still be needed after the upgraded agent detail page lands