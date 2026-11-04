# Support ticket email for stuck agent starts

Status: pending. Not scheduled.

## Problem

On `/onboarding`, when an agent does not become `active` within 60 seconds, or its start request fails, the user sees this warning:

> Your agent is taking longer than expected to start. We have reported the problem, ticket no: {ticket}. You may still check your agent.

The warning shipped without the ticket line and the report sentence, because nothing is reported yet. The shipped copy is "[spinner] Your agent is taking longer than expected to start. You may still check your agent", with a "Go to my agents" button. The browser-side `generateTicketNumber()` was removed, so no number is shown. The `TODO(support-ticket)` marker in [OnboardingPage.tsx](../../../../apps/web/src/features/onboarding/OnboardingPage.tsx) points here. Restore the ticket line and the report sentence only when the server ticket exists.

## Goal

When the warning is shown, send a support email to the operator with the ticket number, the agent id, the user, and the observed status. Store the ticket so the number is traceable.

## Proposed design

1. **Ticket endpoint.** Add `POST /support/tickets` in `apps/api`. Input: `agentId`, `observedStatus`, `startFailed`, `clientTicketNumber`. The server verifies the session user owns the agent, creates a ticket row, and returns `ticketNumber`. The server generates the number, and the client uses the returned value. Only the ticket number is shown to the user.
2. **Storage.** A `support_tickets` table in `packages/db` with `id`, `ticket_number` (unique), `user_id`, `agent_id`, `observed_status`, `start_failed`, `created_at`, and `emailed_at`.
3. **Recipient config.** Add `OPERATOR_SUPPORT_EMAIL` to `packages/domain/src/config/schema.ts`, with the matching env override in `apps/worker/src/config.ts` if the worker needs it. The recipient address is not decided yet.
4. **Email.** Send through SES, reusing `createAuthMailer` in [auth-mailer.ts](../../../../apps/api/src/auth-mailer.ts). Set `emailed_at` after a successful send. A send failure must not fail the endpoint. Log it and retry later or leave it for an operator.
5. **Rate limiting.** Limit tickets per user per hour to avoid spam from the polling warning. Decide the limit when implementing.
6. **Web.** Replace the client-side `generateTicketNumber()` (already removed) with the server-returned number. Restore the ticket line and "We have reported the problem" in the warning copy. Remove the `TODO(support-ticket)` marker.

## Open questions

- Recipient address for support email.
- Whether rate limiting is needed for the first release.
- Whether the warning copy should change if the email send fails (today it says "reported" once the endpoint returns a ticket).
- Whether to also report `crashed` and failed start requests the same way.

## Acceptance

- A warning shown on `/onboarding` creates one `support_tickets` row and one email.
- The ticket number shown to the user matches the stored row and the email subject.
- No email is sent when the agent becomes `active`.
- Endpoint and email failures do not block the user from opening `/agents`.
