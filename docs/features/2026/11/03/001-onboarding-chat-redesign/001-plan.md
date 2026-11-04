# Onboarding chat redesign: plan

## Problem

New users go through a chat, then a login link, then a form. The form takes a long time to submit, and the user then waits 30–60 seconds for the agent to start with nothing happening on screen. We want the whole path to feel like one chat. While the agent is being created, the chat should keep the user engaged and explain the platform, including how to edit the agent.

## Where the 30–60 second wait comes from

Traced through the code (not yet measured in staging):

1. **`POST /agents` is not the wait.** It creates the row and returns `201` without starting the agent ([agents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.ts), ~line 1305). `startCreatedChild` only applies to child agents.
2. **`POST /agents/:id/start` is fast.** [agent-lifecycle-service.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/services/agent-lifecycle-service.ts) `startAgent` runs a transaction (`stopped → starting`, insert runtime session with `status: 'starting'`), then a blueprint sync. It returns without waiting for the worker. The frontend's [CreateAgentFlow.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/CreateAgentFlow.tsx) mutation awaits this call, and errors are only logged, so it adds well under a second.
3. **The wait is in the worker and the container.**
   - The worker picks up the `starting` session. A wake signal reacts in about 2s, and the health monitor sweeps every 10s ([agent-health-monitor.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-health-monitor.ts)).
   - It moves to `launching` and calls the runtime launcher (Docker, or Nomad via [nomad-runtime-adapter.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/nomad-runtime-adapter.ts)). Container start, and any image pull, happen here.
   - Inside the container, [agent.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agent.ts) sends a `starting` heartbeat, installs external skills (network calls, ~line 4385), sets up the workspace, and then sends `ready`.
   - The first `ready` heartbeat calls `markSessionRunning` in [agent-session-manager.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/worker/src/agents/agent-session-manager.ts) (~line 800). This is the moment the agent becomes `running`.
4. **Timeouts that bound it.** The legacy start timeout is 60s (`startTimeoutMs`). Capacity-aware startup (off by default, `capacityAwareStart.enabled: false` in [schema.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/packages/domain/src/config/schema.ts)) uses a 600s queue deadline and a 120s placed-start deadline. The observed 30–60s fits container launch plus in-container boot, which runs before the 60s start timeout.
5. **The UI learns about the change late.** [AgentDetailPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentDetailPage.tsx) updates on `agent.status` events from the event stream. It also refetches every 30s, so a missed event can add up to 30s of stale status.
6. **Progress phases are not available by default.** `startupProgress` (`waiting_for_capacity` / `booting`) is only computed when the capacity-aware gate is on. With the default config, the UI sees only `starting` → `running`.

**Conclusion:** the 30–60s is real and happens after the API call returns, in the worker and container. Live progress can be shown from `starting` → `running` status changes (event stream plus the 15s runtime poll). The `booting` phase needs the capacity-aware flag, which is off today. The exact split between launch, image pull, and skill install is unknown until measured.

### Timing decision (simple, tunable)

- Assume 60s total for startup. Measurement (Step 0) is skipped for now and the numbers will be revised when we have data.
- Status checks start after `STATUS_POLL_START_MS` (5s) and repeat every `STATUS_POLL_INTERVAL_MS` (3s) until the agent is `active`. The stuck-agent warning is shown 60s after submit if the agent is not active (`ONBOARDING_STUCK_AFTER_MS`), or at once on a failed start request or a `crashed` status.
- These three values are named constants in one module so they can be changed later without touching the flow.

## Decisions (from the user)

- **Route:** `/onboarding`, no name in the URL.
- **Name:** not generated or stored before login. When the user returns to the chat, the first question is the agent name.
- **Name editing:** shown in the create form ([CreateAgentFlow.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/CreateAgentFlow.tsx)) and in the edit form ([EditAgentModal.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/EditAgentModal.tsx), opened from the agent's page in [AgentDetailPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/AgentDetailPage.tsx)). The timed message points to both.
- **Stage 0 measurement:** skipped.
- **`capacityAwareStart`:** already enabled on staging (`config/staging.yaml`, commit `31a00ea3`), and off by default. Production stays off until owner approval, per the capacity plans. This feature does not change the flag.

## Target flow

1. **Landing "Try it" chat** ([TryPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/try/TryPage.tsx)): the existing pre-set messages and the email question. No name question. The login link is sent with `next=/onboarding`, as the current code does with `/agents/new`.
2. **Login link** is sent as today.
3. **Onboarding chat** (new route `/onboarding` in [router.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/app/router.tsx)). The page:
   - Asks for the agent name as the first message after login.
   - On the user's answer, creates the agent with that name and standard defaults (cost preset, no skills, no connections), then calls `start`.
   - Shows the timed pre-set messages (below). Once the agent is `active`, it shows "Redirecting to your AI agents page..." for about 2s, then opens `/agents`. There is no agent chat on this page.
4. **Returning users** (any user who already has an agent) skip onboarding and go to `/agents`.
5. **Failures** (create or start request fails, or the agent is still not `active` 60s after submit): the page shows the stuck-agent warning (spinner and "You may still check your agent") and a "Go to my agents" button. The warning replaces the retry button. The support email is deferred; see [001-plan.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/features/pending/000-support-ticket-email/001-plan.md).

### Timed message sequence

The name is asked first. Then:

| # | When | Message (draft, to refine) |
|---|------|----------------------------|
| 0 | User answers the name question | Create and start the agent with that name. |
| 1 | 2s | "{name} (your own personal AI agent) is being created, please wait." |
| 2 | 7s | "Use these icons [play] [pause] [edit] [stop] to play, pause, edit or stop your AI agent at any time." (icons match the row buttons on the AI Agents page) |
| 3 | 12s | Set up Telegram (optional, skippable). The timeline pauses here (see below). |
| 4 | 5s after resume | "{name} can help you search and apply for jobs, scholarships, grants, or even trade crypto. Once it is ready, chat with it to get it working for you." |
| 5 | 10s after resume | "You can start messages on Telegram and continue on the Web, and vice versa." |
| 6 | 15s after resume | "You can view all your agents at any time on the AI Agents page." |
| 7 | 20s after resume | "Your agent is almost ready. Your agents are listed on the AI Agents page." |
| 8 | 25s after resume | "Click AI Agents on the left side bar to view the AI Agents page. To view the side bar on mobile devices, click the menu icon." |
| - | Redirect | As soon as the agent is `active`. Never on a timer. Pending messages are dropped and the timers stop. A "Redirecting to your AI agents page..." line shows for 2s, then `/agents` opens. |

Pause after the setup step: after message 3, the timeline waits until the user clicks "Connect Telegram" or "Turn on notifications", clicks the ✕ to cancel, or clicks "Skip" in the pause hint. Then the 5s gaps resume for messages 4 to 8, counted from the resume point. Pause resume is one-shot. Redirect is not blocked by the pause. Without a pause, messages 4 to 8 keep the absolute times 17s to 37s.

Status checks run in parallel with the messages: start at 5s, every 3s, until `active`. Polling has no cap and keeps going on errors. The "Go to my agents" link is shown only in the warning state, and the warning is latched once shown. The timed messages stop when the warning is shown.

Cache sync: each status check writes the agent into the cached `['agents']` list. When the status is `active`, the list is invalidated, and the redirect follows 2s later. This makes `/agents` show the live status on open. Without it, the list cached at submit time (`stopped`) was shown for up to 30s (the `staleTime`).

Rules for the copy: no jargon, one idea per message, and each message stays on screen long enough to read (the 5s gap).


## Implementation steps

1. **TryPage** ([TryPage.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/try/TryPage.tsx)): change the login redirect from `/agents/new` to `/onboarding`. No name is sent. Keep the existing pre-set messages.
2. **Timing module** (new, e.g. `apps/web/src/features/onboarding/onboardingTiming.ts`): export `STATUS_POLL_START_MS = 5000`, `STATUS_POLL_INTERVAL_MS = 3000`, `STARTUP_TIMEOUT_MS = 60000`, and the message delays. This is the single place to change timing later.
3. **Onboarding page** (new feature folder `apps/web/src/features/onboarding/`):
   - `OnboardingPage.tsx` owns the flow state (`awaitingName`, `creating`, `info`, `ready`, `failed`).
   - Asks for the name first. Then calls `agents.create({ name })` with standard defaults and `agents.start` from [api-client.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/lib/api-client.ts). Does not reuse `CreateAgentFlow`. The create schema only requires `name`, so no other fields are sent.
   - A returning user (already has an agent) is redirected to `/agents` before the flow starts.
   - Message timing is a small phase machine driven by the timing constants.
4. **Status source**: poll `agents.get` (or the runtime endpoint) every `STATUS_POLL_INTERVAL_MS` from `STATUS_POLL_START_MS`, until `active`. Also listen to `agent.status` events where available. Do not rely on the 30s refetch in `AgentDetailPage`.
5. **Redirect**: when `active`, show "Redirecting to your AI agents page..." for `ONBOARDING_REDIRECT_DELAY_MS` (2s), then `navigate('/agents', { replace: true })`. No agent chat is rendered on this page.
6. **Telegram step**: reuse the existing Telegram setup component (`CreateAgentFlow.telegram.test.tsx` shows its shape). Make it skippable.
7. **Failure path**: the stuck-agent warning (spinner and "You may still check your agent") and a "Go to my agents" button. No ticket number yet. No retry button. See the pending support plan for the deferred email and server ticket.
8. **Routing** ([router.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/app/router.tsx)): add `/onboarding`. Keep `/agents/new` for direct use, but it is no longer the post-login target.
9. **Backend**: no API changes expected. `POST /agents` with `{ name }` is enough. Confirm in the worker test run that a no-skill agent reaches `running`.
10. **Docs**: update the onboarding section of the product docs, if one exists.

## Tests

- Update `TryPage.test.tsx`: the redirect is `/onboarding` and no name is sent (the test currently checks `sendLoginLink` in source text, ~lines 129–134).
- Update `LandingPagePlaceholder.test.tsx` if the landing copy changes.
- New `OnboardingPage.dom.test.tsx` with fake timers: name first, create called with `{ name }`, message timing at the constants, redirect to `/agents` once active, no warning before 60s while not active, immediate warning on a failed start or `crashed`, warning with ticket and always-visible "Go to my agents", stale agents cache invalidated after create, returning-user redirect to `/agents`.
- `NotificationsBlock.dom.test.tsx` and `PushOptIn.dom.test.tsx`: the pause resumes on setup action, cancel, or skip.
- Update `CreateAgentFlow.telegram.test.tsx` only if the shared Telegram component changes.
- No change to `AgentConversation`. It is not rendered on `/onboarding` any more.
- Run the web test suite for the touched folders, then lint and typecheck.

## Resolved questions

1. **Message copy and timing.** Draft copy accepted. Timing is a 60s assumed start, with status checks from 5s every 3s, as named constants. The redirect happens only when the agent is `active`. The stuck warning is shown at 60s if not active, or at once on a failed start request or `crashed`.
2. **`capacityAwareStart`.** Already on in staging. Off by default and in production. This feature does not change it. Production turn-on needs separate owner approval (see the capacity roadmap).
3. **Name editing.** Shown in the create form and in the edit form (opened from the agent's page). The timed message points to both.
4. **Name transport.** Not in the redirect. The name is asked on return to the chat.
5. **Route.** `/onboarding` is accepted.
6. **Feature folder.** `docs/features/2026/11/03/001-onboarding-chat-redesign/` is accepted.
