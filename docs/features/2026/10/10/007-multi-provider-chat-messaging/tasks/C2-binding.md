# C2: Proof-of-control binding

**Status:** deferred (DEC-45). Do not start. Kept for later.

**Depends on:** C1. **Approvals:** DEC-05, DEC-06, DEC-07, DEC-11, DEC-26, DEC-27, DEC-34. **Design:** [095 §0](../095-chat-address-migration-plan.md) and [060](../060-config-secrets-onboarding.md).

## Objective

A user can bind a chat address only by proving they control it. The provider delivers a one-time code, and the user enters it on the web. Inbound messages never bind (DEC-07).

## Scope

1. **Table** `chat_bind_challenges`: `id`, `user_id`, `agent_id` (nullable), `provider`, `address` (normalised), `code_hash`, `salt`, `attempts`, `expires_at`, `consumed_at`, `created_at`. Store a salted hash of the code, never the code. A 6-digit code has 10^6 values, so `attempts` is capped per challenge.
2. **Endpoints** (authenticated with the user's session, not public):
   - `POST /messaging/chat-addresses/challenges`: body `{ provider, address, scope }`. Normalise the address. Refuse with 409 `chat_address.already_bound` if another user holds an active row for `(provider, address)` (DEC-06). Create the challenge. Send the code through the provider's `ChatChannel` adapter. Return the challenge ID and expiry, never the code.
   - `POST /messaging/chat-addresses/challenges/:id/verify`: body `{ code }`. Refuse if expired, consumed, or over the attempt cap. On success, in one transaction, under `pg_advisory_xact_lock` on `(provider, address)`: re-check the 409 rule, write the active `chat_addresses` row with `verified_at` and `consent_source = 'bind_code'`, and delete the matching `chat_suppressions` row if one exists (DEC-05). Mark the challenge consumed.
3. **Limits** in operator config (`messaging.chat.bind.*`): code length, time-to-live, maximum attempts, and requests per user per hour. Add them to the Zod schema and `config/default.yaml`. No magic numbers (I7).
4. **Inbound.** Do not change inbound binding behaviour (DEC-07). The unbound reply text becomes "Open Settings to link your Telegram account." (DEC-11). Replace the stale `/start` wording at `agent-interactivity.ts` (search for `Please bind your Telegram account first`).
5. **Web.** A bind form in Settings: enter the address, request a code, enter the code. Update `SettingsPage.tsx` and the API client.
6. **Remove `POST /agents/verify-telegram` (DEC-34).** No web caller exists. Remove the route in `apps/api/src/routes/agent-interactivity.ts` (search for `/agents/verify-telegram`), its tests in `apps/api/src/routes/agent-interactivity.test.ts` (search for `describe('POST /agents/verify-telegram'`), and in `apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts` (search for `describe('POST /agents/verify-telegram'`). Confirm with grep that no reference remains.

## Out of scope

- Any change to how the Telegram webhook secret is verified (DEC-15 and DEC-28).
- The new public webhook route, which is already done (DEC-14).

## Tests (all required)

- A correct code binds the address and writes `consent_source = 'bind_code'`.
- A wrong code increments `attempts`. The cap blocks further tries.
- An expired code is refused. A consumed code cannot be reused.
- A second user claiming an address held by another user gets 409 `chat_address.already_bound`.
- The same user binding the same address on another scope succeeds.
- A successful bind lifts the suppression row for that address (DEC-05).
- An owner of a different address cannot lift another user's suppression.
- An inbound message that contains a code does not bind (DEC-07).
- The request limit per user is enforced.
- Telegram tests still pass (I1).

## Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` and the web type check.
- `pnpm exec vitest run telegram chat-inbound agent-interactivity` and the new tests.
- The DB integration tests for suppression and the advisory lock, against a disposable Postgres 17.
- `pnpm test`.

## Gate note

C2 is reviewed by an independent reviewer agent before U starts (DEC-33). The spec for that review is [C2-R](./C2-review.md). The author records its own self-check in PROGRESS.md, but the review gate is the reviewer's.
