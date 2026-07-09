# Chat With AI

## Summary

HeroBids needs two distinct AI product surfaces:

- **AI Employees** for ongoing, autonomous work that runs continuously and costs money while active
- **Chat With AI** for interactive, user-driven conversations with saved history

This document defines the product and UX for `Chat With AI`.

The goal is to give users a low-friction way to talk to AI inside HeroBids without forcing them to create a continuously running AI Employee first. Chat must feel immediate, cheap, and conversational. AI Employees must remain the persistent, higher-commitment surface for work that continues after the user leaves.

## Terminology

HeroBids should use layered terminology:

- **AI Employee** is the preferred user-facing product term in navigation, onboarding, empty states, and marketing copy
- **agent** remains the internal and technical term in code, APIs, runtime docs, and data models

This means the product can become more approachable without changing the precise technical concept already established across the platform.

## Why This Exists

The product vision uses the term `agent`, but the user-facing product can present that concept more clearly as an AI Employee. That vision still implies two related but different needs:

1. users need a place to talk to AI directly
2. users need a place to run long-lived AI Employees that continue working independently

If we only offer AI Employees, we force users into the most expensive and operationally heavy surface even when they only want a quick answer, brainstorming help, or a short task.

If we only offer chat, we fail the core product promise that AI should do work continuously and independently.

HeroBids should therefore support both surfaces and make the difference explicit.

## Product Positioning

### AI Employees

AI Employees are for work that should continue without the user staying present.

Internally, each AI Employee is implemented as an agent runtime.

Characteristics:

- persistent identity
- explicit goal and constraints
- ongoing runtime
- higher cost
- can act repeatedly over time
- can remain in contact through messaging and alerts

### Chat With AI

Chat With AI is for interactive work that happens while the user is present.

Characteristics:

- session or thread based
- user-driven turn taking
- conversation history
- lower cost than continuous AI Employees
- no background autonomy by default
- best for asking, planning, drafting, researching, and deciding what should happen next

## Core Product Decision

`Chat With AI` is a separate product surface, not a thin wrapper around agent messaging.

That means:

- chat threads are not the same as agent conversation history
- chat is not billed as continuous agent runtime
- chat must work even when the user has no running AI Employees
- agent interactivity remains agent-specific and only applies to a running agent

## Goals

### Primary Goals

- give users an obvious place to talk to AI directly inside HeroBids
- preserve conversation history so users can return to prior threads
- make the difference between chat and continuous AI Employees clear
- reduce friction for new users who are not ready to create an AI Employee yet
- create a natural bridge from a successful chat into AI Employee creation

### Secondary Goals

- provide a cheaper AI entry point than a continuously running AI Employee
- support personal assistant and trading-adjacent conversations
- create a unified user expectation that HeroBids offers both real-time assistance and autonomous execution

## Non-Goals

- Chat With AI does not run continuously in the background in v1
- Chat With AI does not silently become an autonomous AI Employee
- Chat With AI does not share the same persistence model as agent runtime memory
- Chat With AI does not require trading capabilities in v1
- Chat With AI does not replace agent-to-user messaging channels such as Telegram or email

## Target Users

### New Users

Users who want to try HeroBids without learning the agent model first.

### Existing AI Employee Users

Users who want fast answers, planning help, or lightweight assistance without spinning up a new agent runtime.

### Prospective AI Employee Creators

Users who want to explore an idea in chat and later convert it into a more permanent AI Employee.

## Primary Use Cases

### General AI Conversation

- ask questions
- brainstorm ideas
- summarize or rewrite content
- plan a task

### Personal Assistance

- draft messages
- create plans or checklists
- research next steps
- turn a vague request into something actionable

### Trading-Adjacent Help

- explain concepts
- discuss strategies at a high level
- review market context
- prepare instructions that the user may later give to an AI Employee

### AI Employee Preparation

- refine a goal before creating an AI Employee
- clarify constraints and desired outcomes
- generate a draft AI Employee brief

## Information Architecture

The authenticated app navigation should include:

- `AI Employees`
- `Chat With AI`

`Chat With AI` should appear directly below `AI Employees` in the primary sidebar.

Rationale:

- both are core AI surfaces
- adjacency teaches the relationship between them
- ordering communicates that AI Employees are the more autonomous surface while chat is the more interactive surface

## Navigation And Entry Points

### Primary Entry

Add a sidebar item labeled `Chat With AI` below `AI Employees`.

### Secondary Entry Points

- CTA from empty states for users with no AI Employees: `Not ready to create an AI Employee? Chat with AI first.`
- CTA from chat threads: `Turn this into an AI Employee`
- CTA from AI Employee creation flow: `Need help defining your AI Employee? Start in chat`

## UX Principles

### 1. Make The Distinction Clear

The UI must clearly explain:

- chat responds while the user is present
- AI Employees continue working after the user leaves

This distinction should appear in empty states, onboarding copy, and upgrade or billing moments.

### 2. Keep Chat Fast

Chat should open immediately into a conversation interface. It should not require the user to name, configure, or provision anything before the first message.

### 3. Preserve Context

Users should be able to revisit earlier conversations through saved history.

### 4. Make Escalation Natural

If a chat conversation turns into an ongoing task, the UI should offer a clear path to create an AI Employee from that thread.

### 5. Do Not Blur Billing Boundaries

Chat and continuous AI Employees should have distinct billing language and distinct mental models.

## v1 Experience

## Page Structure

The `Chat With AI` page should contain:

1. a left rail or sidebar showing conversation history
2. a main thread view showing messages
3. a composer at the bottom for sending a new message
4. lightweight thread actions such as rename, delete, and create new chat

### Empty State

When the user has no conversations:

- show a simple intro explaining what chat is for
- present a prominent message box
- optionally show starter prompts

Suggested empty-state copy direction:

> Talk to AI directly. Use chat for quick help, planning, drafting, and research. Use AI Employees when you want work to continue on its own.

### Conversation List

Each thread in history should show:

- thread title
- last updated time
- a short preview of the latest visible message

### Main Thread

Each conversation thread should show:

- user messages
- assistant messages
- loading state while generating
- clear failure and retry states

### Composer

The composer should support:

- multiline text input
- send action
- disabled state while a message is being sent

v1 may remain text-only.

## Conversation History

Conversation history is a core requirement.

### History Requirements

- every chat belongs to a user
- a user can have multiple chat threads
- each thread persists until deleted
- messages in a thread are ordered and replayable
- only visible assistant text is stored in history

The final rule matters because the platform already has strong constraints around not storing hidden model reasoning in persisted conversation history.

### Thread Lifecycle

- create a new thread implicitly on first message or explicitly with `New chat`
- auto-title a thread from the first meaningful user message
- allow manual rename
- allow delete with confirmation

### History Scope

Chat history should stay inside the `Chat With AI` surface.

It should not automatically merge with:

- agent memory
- agent runtime conversation history
- external messaging threads such as Telegram

## Relationship To AI Agents

User-facing copy should present this section as the relationship between chat and AI Employees. Internally, the platform still uses the term `agent` for the runtime and related APIs.

This is the most important product boundary.

### What Chat Is Not

Chat is not a running AI Employee.

Sending a message in chat must not:

- start a background loop
- consume continuous runtime billing
- create an AI Employee without explicit user action
- imply that the system will continue acting later

### Conversion To AI Employee

The product should support a future action:

- `Turn this into an AI Employee`

That flow should:

- carry over the user’s objective and relevant constraints
- let the user review and confirm AI Employee settings
- create a new AI Employee explicitly

Internally, that conversion still creates a new agent record and agent runtime.

The conversion must be opt-in and reviewable.

### Agent Messaging Stays Separate

Current and future agent-specific messaging features remain separate from general chat.

Examples:

- messaging a running agent
- Telegram reply threading with an agent
- viewing agent memory or compiled prompt

Those are agent-operational capabilities, not the generic chat product.

## Cost And Billing UX

Chat exists partly to offer a lower-friction, lower-cost surface than continuous AI Employees.

### Billing Expectations

- chat usage may still incur AI costs
- chat should not be described as free unless that is actually true by plan
- chat should not be framed as continuous runtime billing

### UX Copy Direction

When needed, explain the difference plainly:

- `Chat responds on demand.`
- `AI Employees keep working in the background while running.`

### Limits

If plans impose chat limits, the UI should expose them as chat limits, not as agent runtime limits.

Examples:

- monthly chat messages
- token or usage caps
- model availability by plan

## Functional Requirements

### Navigation

- add `Chat With AI` to the primary sidebar below `AI Employees`
- route opens the chat product surface

### Threads

- create thread
- list threads
- open thread
- rename thread
- delete thread

### Messages

- send user message
- receive assistant response
- persist visible messages in order
- retry failed assistant response

### History

- history persists across sessions
- threads sort by most recent activity
- latest thread preview visible in history list

### States

- empty state when no chats exist
- loading state while thread list loads
- loading state while message is generating
- error state when send fails
- empty thread state for a newly created chat

## UX Copy Recommendations

### Sidebar Label

- `Chat With AI`

### Page Title

- `Chat With AI`

### Supporting Explanation

- `Talk to AI directly for quick help, planning, and research.`
- `Use AI Employees when you want work to continue in the background.`

### CTA Copy

- `New chat`
- `Turn this into an AI Employee`

## Permissions And Availability

### Baseline Availability

Chat should be available to authenticated users even if they have no AI Employee configured.

### Plan Gating

If chat access is plan-gated, the UI must say so explicitly and distinguish:

- chat availability
- chat model tier
- AI Employee runtime availability

## Risks

### 1. Product Confusion

If the product does not explain the difference between chat and AI Employees, users will assume chat keeps working after they leave.

### 2. Billing Confusion

If the UI does not separate on-demand chat from continuous runtime, users will not understand what costs what.

### 3. Data Model Confusion

If chat threads and agent conversation history are merged, future features will inherit unclear behavior around cost, retention, and execution semantics.

## Success Metrics

### Adoption

- share of authenticated users who start at least one chat
- percentage of new users who use chat before creating an AI Employee

### Conversion

- percentage of chat users who later create an AI Employee
- percentage of AI Employee creations that originate from chat-driven flows

### Retention

- percentage of users who return to an existing thread
- number of active threads per active chat user

### Clarity

- reduction in support questions about the difference between chat and AI Employees
- reduction in abandoned AI Employee creation attempts when users only wanted a quick answer

## Open Questions

1. Should chat be available on all plans or only selected tiers?
2. Should v1 support a single general assistant or multiple chat personas?
3. Should chat be able to call product tools in v1, or remain a simpler assistant surface?
4. Should conversation history retention differ by plan?
5. What exact billing unit should chat use if usage-based pricing is exposed?

## Recommendation

Ship `Chat With AI` as a separate authenticated product surface with conversation history and a clear nav entry directly below `AI Employees`.

Do not implement it as generic agent messaging.

The right product model is:

- chat for direct, on-demand interaction
- AI Employees for continuous, autonomous work

The bridge between them should be explicit conversion, not hidden coupling.