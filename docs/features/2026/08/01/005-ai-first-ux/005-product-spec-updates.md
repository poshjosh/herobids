# Product UX Spec Update: AI-First Onboarding

**Target:** `docs/product/chat-with-ai/product-ux-spec.md`
**Feature:** AI-First UX (005)
**Date:** 2026-08-01
**Status:** Proposed Change

## Summary of Changes

The Chat With AI product spec needs updates to incorporate agent onboarding as a primary use case and to document the embedded actions system.

**v1 scope note:** For v1, the chat is scoped to **Guided Setup** (create-agent only) — not the full general-purpose Chat With AI surface. The spec updates below describe the eventual product direction. v1 delivers the first step: chat as an alternate (preferred) route for agent creation, embedded on the agent creation page, labeled "Guided Setup" in the UI. Sidebar items, `/chat` routes, and general chat are deferred.

---

## Change 1: Add "Agent Onboarding" to Primary Use Cases

**Location:** After "AI Employee Preparation" section (~line 85)

**Add:**

```markdown
### Agent Onboarding (Guided Setup)

Guided Setup is an alternate (preferred) route for agent creation, available alongside
the existing form. Users describe what they want in natural language, and the chat agent
guides them through agent creation conversationally.

Characteristics:
- the chat agent asks follow-up questions based on the selected preset (trading, personal assistant, custom)
- connection forms appear inline for wallet and exchange setup — secrets never reach the LLM
- the agent is created directly from chat when enough information is gathered
- post-creation follow-up messages remind the user of next steps (fund wallet, test mode status)
- the existing form-based Create Agent flow remains fully available as a fallback
- v1 scope: create-agent workflow only. General chat (brainstorming, research, Q&A) is a future phase.

This is an alternate route alongside the existing form — chat does not replace the form.
```

---

## Change 2: Add "Embedded Actions" to UX Principles or New Section

**Location:** After "UX Principles" section (~line 160)

**Add:**

```markdown
### 6. Support Embedded Actions

Chat messages may contain structured actions that render UI components inline within the
conversation. This allows the chat to guide users through multi-step processes (connection
setup, agent confirmation) without leaving the chat surface.

Supported action types in v1:
- **Quick-reply buttons** — for preset selection and guided choices (e.g., "AI crypto trader",
  "AI personal assistant", "Custom AI")
- **Connection forms** — secure inline forms for wallet and exchange connections; the LLM
  requests the form type, the frontend renders it, and secrets are handled entirely by the
  frontend
- **Agent confirmation cards** — a summary card shown before the agent is created,
  with an explicit "Create Agent" confirmation button

The LLM emits structured markers that the frontend parses. The LLM determines *when* and
*which type* of action to show; the frontend owns rendering and data handling.
```

---

## Change 3: Update "Conversion To AI Employee" Section

**Location:** Replace the "Conversion To AI Employee" subsection (~line 290)

**Replace with:**

```markdown
### Conversion To AI Employee

Two conversion paths exist:

1. **Chat → Agent (onboarding):** The primary path for new users. The chat agent
   collects requirements conversationally and creates the agent when ready.
   This is the default first-time experience — the user never sees the form unless
   they choose to.

2. **Chat → Agent (existing thread):** For existing chat threads, a "Turn this into
   an AI Employee" action carries over the conversation context and opens the agent
   creation flow pre-filled with discussed requirements.

Both paths:
- carry over the user's objective and relevant constraints
- let the user review and confirm AI Employee settings
- create a new AI Employee explicitly with a visible confirmation

The conversion must be opt-in and reviewable. Chat never silently creates an AI Employee.
```

---

## Change 4: Update "Composer" in v1 Experience

**Location:** In "v1 Experience → Composer" (~line 230)

**Add to the bullet list:**

```markdown
- quick-reply buttons rendered above the composer for guided choices (preset selection,
  confirmation actions)
```

---

## Change 5: Add "Onboarding Chat Agent" to Functional Requirements

**Location:** After "Messages" in Functional Requirements (~line 335)

**Add:**

```markdown
### Onboarding Agent

- the onboarding chat agent has access to platform documentation tools
- it can create agents directly from chat when sufficient information is gathered
- it requests connection forms via structured markers when secrets are needed
- it provides post-creation follow-up: wallet funding reminder, test mode notice
- the onboarding experience is the default for users with no agents
```

---

## Change 6: Add i18n Note

**Location:** After "UX Copy Recommendations" (~line 368)

**Add:**

```markdown
### Internationalization

- the greeting message uses existing i18n keys for preset display names
- the chat LLM responds in the user's locale (determined from Accept-Language header)
- static documentation referenced by the chat agent is English-only in v1;
  the LLM can summarize and translate on the fly
```

---

## What Stays The Same

No changes needed to:
- The core distinction between Chat and AI Employees
- The billing boundary (chat is per-message, AI Employees are continuous)
- The navigation structure
- Thread lifecycle (create, rename, delete)
- History persistence model
- Non-goals (chat does not run in background, does not silently become an AI Employee)
