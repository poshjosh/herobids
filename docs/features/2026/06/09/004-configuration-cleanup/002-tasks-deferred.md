# Config Hardening: Deferred Tasks

These items are lower-priority and do not block the main changeset in `001-tasks.md`. Pick them up as a follow-on batch or individually.

_The original D-01 (sandbox defaults) and D-02 (code tool defaults) have been promoted to Task 6 and Task 7 in `001-tasks.md`. Items below are renumbered accordingly._

---

## D-01 — Stripe webhook tolerance

**Current state:** `apps/api/src/billing/stripe-client.ts:99` — timestamp tolerance is hard-coded to `300` seconds (5 minutes). This is also the Stripe-documented recommended value.

**What to do:**
- Add `billing.stripe.webhookToleranceSecs: 300` to `AppConfigSchema` and `config/default.yaml`
- Wire into `StripeClient.verifyWebhookSignature`

**Why deferred:** Low operational risk. The 300-second window is a Stripe standard. Only change if an operator has a specific reason to tighten it.

---

## D-02 — Remove Creem test-URL magic switching

**Current state:** `apps/api/src/billing/creem-provider.ts:26` auto-switches to `https://test-api.creem.io/v1` when the API key starts with `creem_test_`. This is hidden behavior not visible to operators.

**What to do (preferred):** Remove the magic switching. Require operators to set `billing.creem.apiBaseUrl` explicitly to the test URL when using test keys. The schema already has `apiBaseUrl` — just enforce it rather than overriding it silently.

**Alternative:** Keep magic switching but document it explicitly in `default.yaml` as a comment on `billing.creem.apiBaseUrl`.

**Why deferred:** Requires coordination with anyone currently relying on the magic behavior. Low urgency if only one environment uses Creem test keys.

---

## D-03 — OAuth state cookie TTL

**Current state:** `apps/api/src/routes/auth.ts:194` — `Max-Age=600` (10 minutes) is hard-coded.

**What to do:**
- Add `auth.oauthStateTtlSecs: 600` to `AuthConfigSchema` in `packages/domain/src/config/schema.ts`
- Add to `config/default.yaml`
- Wire into the `Set-Cookie` header in `auth.ts`
- Do not conflate with `auth.exchangeCodeTtlSecs` (different semantics: state cookie TTL vs code exchange TTL)

**Why deferred:** Pure config hygiene, no functional impact.
