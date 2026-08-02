# Plan: Supporting Aspects — i18n, Form Injection & Rapid Prototyping

**Feature:** AI-First UX (005)
**Date:** 2026-08-01
**Status:** Draft

## Summary

Several cross-cutting concerns support the onboarding chat and platform-docs skill. This plan covers internationalization of the chat experience, the embedded form injection system in detail, a rapid prototyping strategy for testing the chat flow before full implementation, and other quality-of-life concerns.

## 1. Internationalization (i18n)

### 1.1 Chat Greeting Translation

The initial greeting message uses existing i18n display names for skill presets.

**Frontend approach:** The greeting is sent as the first assistant message when a new thread is created. The API determines the user's locale from `Accept-Language` header and generates the greeting in that language.

**i18n keys needed:**

```typescript
// New keys
'chat.onboarding.greeting': 'Hi! I can help you create an AI agent. What kind of agent are you looking for?',
'chat.onboarding.greeting.option': '{index}. {label}',
'chat.onboarding.switchToForm': 'Prefer a form instead?',
'chat.onboarding.stuck': 'Not sure? You can always use the guided form.',
'chat.postCreate.testMode': 'Your agent **{name}** is created and running in **test mode**. You can switch to live anytime from the agent settings.',
'chat.postCreate.fundWallet': "Don't forget to fund your wallet `{address}` with at least **${capital}** USDC.",
'chat.postCreate.viewAgent': 'You can view your agent on the [Agents page](/agents).',
```

### 1.2 LLM Response Language

For the LLM to respond in the user's language, pass the locale in the chat system prompt:

```
The user's preferred language is {locale}. Respond in that language.
```

The LLM can handle multilingual conversation naturally. No translation layer needed between LLM and user.

### 1.3 Static Content Translation

The docs index (`platform-docs` skill) is English-only in v1. Non-English users will still receive English docs when the LLM reads them, but the LLM can summarize/translate on the fly. Full multi-language docs indexing is deferred.

## 2. Embedded Form Injection System

### 2.1 Marker Protocol

The LLM emits structured markers that the frontend parses and renders as components.

**Format:**

```
[COMPONENT:type:key1=value1:key2=value2]
```

**Examples:**

| Marker | Behavior |
|--------|----------|
| `[FORM:connection:venue=hyperliquid]` | Render Hyperliquid connection form inline |
| `[FORM:connection:venue=jupiter]` | Render Jupiter wallet connect inline |
| `[FORM:connection:type=email]` | Render email OAuth connect inline |
| `[CONFIRM:agent:summary={json}]` | Render agent creation confirmation card |
| `[BUTTON:label=Choose for me:action=auto_select]` | Render a single action button |
| `[QUICK_REPLIES:options=preset:trading,preset:personal-assistant,preset:custom]` | Render quick-reply button row |

### 2.2 Frontend Parser

```typescript
// apps/web/src/features/chat/chat-renderer.ts

interface ChatAction {
  type: 'form' | 'confirm' | 'button' | 'quick_replies';
  props: Record<string, string>;
}

function parseActions(content: string): { cleanContent: string; actions: ChatAction[] } {
  const actions: ChatAction[] = [];
  const cleanContent = content.replace(/\[(\w+):(.+?)\]/g, (match, type, paramsStr) => {
    const props: Record<string, string> = {};
    for (const part of paramsStr.split(':')) {
      const [key, ...valueParts] = part.split('=');
      if (key && valueParts.length > 0) {
        props[key] = valueParts.join('=');
      }
    }
    actions.push({ type: type.toLowerCase() as ChatAction['type'], props });
    return ''; // Remove marker from displayed text
  });
  return { cleanContent: cleanContent.trim(), actions };
}
```

### 2.3 Form Result Flow

1. LLM emits `[FORM:connection:venue=hyperliquid]`
2. Frontend parses and renders `<ConnectionForm venue="hyperliquid" />`
3. User fills form and submits using the existing secure setup flow (LLM never sees secrets):
  - trading / wallet setup → `POST /setup/provider-link`
  - email OAuth setup → existing `/connections/oauth/*` flow
4. On success, frontend sends the result back to the chat:

```
POST /chat/threads/:id/actions/:actionId
Body: { type: "form_result", form: "connection", result: { connectionId: "abc123", venue: "hyperliquid" } }
```

5. The chat runtime records this as internal action state / summary metadata, not as a persisted chat message
6. LLM continues: "Great, your Hyperliquid connection is set up! Now, how much capital..."

### 2.4 Supported Forms

| Form | Component Location | API |
|------|-------------------|-----|
| Hyperliquid connection | Reuse existing trading setup form from agents UI | `POST /setup/provider-link` |
| Jupiter/Solana wallet | Reuse existing trading setup form from agents UI | `POST /setup/provider-link` |
| Email (Gmail) | Reuse existing OAuth flow | existing `/connections/oauth/*` endpoints |

The chat component wraps existing connection forms — no new form logic needed. The only new code is the marker parser and the inline rendering container.

### 2.5 OAuth Flow Handling in Chat

OAuth connections (e.g., Gmail) require the user to authorize with a third party. The chat must not lose context during this flow.

**Primary approach for v1: Redirect and resume the existing create-agent flow**

For providers that require OAuth (for example Gmail):
1. LLM emits `[FORM:connection:type=email]`
2. Frontend renders the existing connect button and preserves the current Guided Setup draft/thread state
3. Click starts the existing OAuth redirect flow
4. The return URL carries thread/action correlation so the frontend can reopen the correct thread and restore in-progress state
5. After authorization, the frontend resumes the thread and submits the action result via `POST /chat/threads/:id/actions/:actionId`
6. Chat continues without losing the collected onboarding state

**Optional later enhancement: Popup OAuth**

Popup OAuth may be added later for providers where it is explicitly verified to work with the same thread/action resume semantics.

## 3. Rapid Prototyping Strategy

Before building the full chat infrastructure, validate the concept with a lightweight prototype.

### 3.1 Phase 0: CLI Prototype (1-2 days)

Create a CLI script that simulates the chat conversation:

```bash
pnpm --filter @herobids/worker run chat-prototype
```

This script:
1. Loads the platform-docs index
2. Runs a local LLM loop with the onboarding system prompt
3. Accepts user input from stdin
4. Prints assistant responses with markers rendered as text hints
5. Can call `create_agent` against a local API

**Goal:** Validate that the LLM can successfully guide a user through agent creation using only the docs tools + `create_agent` tool. Tune the system prompt until the conversation feels natural.

### 3.2 Phase 1: Stateless API Endpoint (2-3 days)

Add a single endpoint `POST /chat/preview` that:
- Takes a `{ message, history?, locale }` payload
- Returns `{ message, actions }`
- Does NOT persist to DB
- Uses the same narrow onboarding runtime as the final implementation

**Goal:** Frontend can start building the chat component against a real (but stateless) backend.

### 3.3 Phase 2: Full Implementation

Build the complete system per Plan 002 with thread persistence, history, and form injection.

**v1 note:** Phase 2 is scoped to Guided Setup (create-agent only). The full Chat With AI surface (general chat, sidebar, thread management UI) is a separate future phase. The DB schema and API infrastructure built here supports that expansion without migration.

## 4. Error Handling & Escape Hatches

### 4.1 LLM Errors

| Scenario | Handling |
|----------|----------|
| LLM hallucinates invalid field | `create_agent` returns Zod validation error → LLM sees error + schema and retries |
| LLM gets stuck in a loop | Max turns per thread (20). After turn 15, frontend shows "Taking too long? Use the form." |
| LLM returns nonsense | Frontend shows "I'm having trouble understanding. Let me connect you to the guided form." with a button |
| Rate limit / timeout | Frontend shows error state with retry button + "use the form" fallback |

### 4.2 User Escape Hatches

- **"Use the form" button** — always visible in the chat header. Navigates to existing Create Agent flow.
- **"Skip" keyword** — user can type "skip" to skip the current question. LLM is prompted to respect this.
- **"Start over"** — resets the thread to the greeting state.

### 4.3 Sensitive Data Protection

- The chat system prompt explicitly forbids asking for private keys, API secrets, passwords
- If the user accidentally pastes a key, the chat message is stored (encrypted at rest per existing DB policy) but the LLM is prompted to respond: "I see you shared sensitive information. Please never share private keys in chat. Use the secure connection form instead."
- A server-side regex scan for common secret patterns (ETH private key format, AWS key format) triggers a warning before the message reaches the LLM

## 5. Cost & Billing

### 5.1 Model Selection

Use a cheap model for onboarding chat:
- **Primary:** DeepSeek V4 Flash (~$0.20/M input, $0.80/M output)
- Reasoning/planning is minimal in a guided conversation
- Fallback to V4 Pro only if Flash quality is insufficient

### 5.2 Cost Tracking

- Chat messages store `usage` (input/output tokens) per message
- Aggregate cost per thread in thread metadata
- Display: "This conversation used ~$0.02 of AI credits" (if we bill for it)
- Per product-ux-spec: chat is cheaper than continuous AI Employees

### 5.3 Rate Limiting

- Per-user: max 50 chat messages per hour (generous, prevents abuse)
- Per-thread: max 100 messages (auto-archive with "start new chat" prompt)

## 6. Analytics & Improvement

Track these events for future optimization:

- `chat.thread.created` — with `preset` (which preset the user selected, if any)
- `chat.agent.created` — agent created via chat (vs form)
- `chat.form.displayed` — which forms were shown
- `chat.form.completed` — which forms were completed
- `chat.fallback_to_form` — user clicked "use the form instead"
- `chat.thread.abandoned` — thread with no agent created after 24h
- `chat.turns.count` — how many turns before agent creation

## Risks

| Risk | Mitigation |
|------|-----------|
| i18n keys not covering all languages | Start with en, ar, hi (existing locale files); add others on demand |
| FORM markers break if LLM hallucinates format | Parser is lenient; unknown markers are silently stripped; validate with regex test suite |
| Prototype creates expectation of full chat | Clearly label phases; Phase 1 endpoint marked as `/preview` |
| Users share secrets in chat despite warnings | Server-side regex scan + automatic warning response + never echo secrets back |
