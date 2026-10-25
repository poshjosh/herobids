# Bug Report 001 — Telegram webhook secret compared with `===`, not in constant time

- **Status:** FIXED (`d553c64e`, 2026-10-24). Verified 2026-10-25.
- **Severity:** Medium. A timing side channel on the webhook secret. Exploitation needs many precise requests, so the practical risk is low, but the check is a security boundary.
- **Date:** 2026-10-25
- **Area:** `apps/api/src/routes/telegram-channel.ts`, `TelegramInboundChannel.verify`
- **Origin:** `919f9ec7` (2026-10-13, "Add Wave 1 agent-onboarding foundations"). Not introduced in the 2026-10-24 to 2026-10-25 work.

---

## 1. Summary

`verify` compared the `x-telegram-bot-api-secret-token` header with `token === this.webhookSecret`. A string `===` returns early at the first mismatched character, so response timing can leak how much of the secret matched.

## 2. Evidence

- Original code (`919f9ec7`): `return token && token === this.webhookSecret ? ok(undefined) : err(...)`.
- Fix (`d553c64e`): `secretMatches` compares `Buffer`s with `crypto.timingSafeEqual`, after a length check (because `timingSafeEqual` throws on unequal lengths). An empty configured secret always rejects.
- Current code: `apps/api/src/routes/telegram-channel.ts` lines 27 to 39.
- Regression tests: `apps/api/src/routes/telegram-channel.test.ts`. Run on 2026-10-25: 15 of 15 passed.

## 3. Root cause

A plain equality operator on a secret. Not a wire or schema problem.

## 4. Fix

Constant-time comparison with `timingSafeEqual`, plus the length check and the empty-secret and non-string guards. Shipped in `d553c64e`.

## 5. Acceptance criteria

- [x] A correct secret is accepted.
- [x] A wrong secret of equal length is rejected.
- [x] A wrong secret of different length is rejected without throwing.
- [x] An empty configured secret rejects every request.
- [x] An empty or missing header is rejected.
- [x] A repeated header sent as an array is rejected.

## 6. Tests

- `apps/api/src/routes/telegram-channel.test.ts`: 15 tests, all passing.

## 7. Notes

- The 2026-10-24 Phase 3 gate record still listed this as open. That entry is corrected in the 900 plan.
- Other secret and signature checks in `apps/api` and `apps/worker` were reviewed on 2026-10-25 with a search for `===` and `!==` on secrets, signatures and tokens. None found beyond the Telegram check, which is now fixed.
  - Stripe (`apps/api/src/billing/stripe-client.ts`) and Creem (`apps/api/src/billing/creem-provider.ts`) use a length-checked `crypto.timingSafeEqual`. No change needed.
  - Not reviewed: the HMAC check on the traderton boundary. It is in the traderton repository, which is outside this report.
