# PLAN: Migrate Email from Resend to SES + Zoho Mail

**Status:** Draft
**Created:** 2026-07-09

---

## Goal

Replace all Resend-based email delivery with a ports-and-adapters design that uses:

- **Amazon SES** for application-originated outbound email
- **Zoho Mail** for hosted human mailboxes such as `support@openaidom.com` and `noreply@openaidom.com`

Backward compatibility is not required. The migration should remove all active Resend runtime code, config, tests, and operator-facing documentation.

---

## Decisions and Assumptions

1. **SES is the runtime delivery provider.**
   The worker sends email through an SES adapter behind the existing `EmailClient` port.

2. **Zoho Mail is mailbox hosting, not the worker delivery adapter.**
   Zoho Mail gives us real inboxes for humans. The application does not need to call Zoho Mail directly in this phase.

3. **No backward-compatibility layer.**
   We will not support old `RESEND_*` env vars, Resend config comments, or parallel dual-provider runtime wiring.

4. **Keep provider abstraction explicit.**
   The config should make the selected outbound provider obvious, and runtime wiring should instantiate the adapter through a small factory/composition boundary rather than referencing SES directly in `index.ts`.

5. **Historical docs are not product docs.**
   Old feature plans that mention Resend can remain as historical records unless they are still used operationally. Current operator-facing docs and examples should be updated.

---

## Target Architecture

### Port

Keep the existing outbound port:

- `apps/worker/src/alerting/email-client.ts`

The port remains provider-neutral and continues to return normalized `Result` values.

### Adapters

Introduce an SES adapter and remove the Resend adapter:

- Add `SesEmailClient`
- Delete `ResendEmailClient`

Recommended shape:

```ts
interface EmailClient {
  send(message: EmailMessage): Promise<Result<EmailSendResult, { code: string; message: string }>>;
}
```

```ts
function createEmailClient(config: AlertsEmailConfig): EmailClient | undefined
```

### Config Model

Refactor `alerts.email` away from Resend-shaped fields to a provider-aware outbound email config.

Recommended target:

```yaml
alerts:
  email:
    provider: ses
    fromEmail: "noreply@openaidom.com"
    replyToEmail: "support@openaidom.com"
    timeoutMs: 10000
    ses:
      region: us-east-1
      accessKeyId: ""
      secretAccessKey: ""
      configurationSetName: ""
```

Recommended env overrides:

- `EMAIL_PROVIDER`
- `EMAIL_FROM_EMAIL`
- `EMAIL_REPLY_TO_EMAIL`
- `EMAIL_TIMEOUT_MS`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `SES_CONFIGURATION_SET_NAME`

Notes:

- Reuse standard AWS credential env names instead of inventing custom SES secret names.
- Keep provider-specific nested config in YAML, but only add env overrides where there is real deployment value.
- If we want stricter typing, make `alerts.email` a discriminated union keyed by `provider`.

### Zoho Mail Boundary

Zoho Mail setup is an infrastructure/mail-admin concern, not a worker runtime dependency.

This migration should document and assume:

- Zoho Mail hosts inboxes like `support@openaidom.com`
- SES sends application email from the verified domain
- DNS is configured so both coexist correctly on `openaidom.com`
- `replyToEmail` can point to a Zoho-hosted mailbox when desired

---

## Implementation Workstreams

## 1. [DONE] Replace Resend runtime wiring with provider-based composition

### Changes

- Add an email client factory or composition helper in the alerting module
- Remove direct `ResendEmailClient` imports from `apps/worker/src/index.ts`
- Instantiate outbound email from config through the provider abstraction

### Files

- Modify `apps/worker/src/index.ts`
- Add `apps/worker/src/alerting/create-email-client.ts` or equivalent
- Modify `apps/worker/src/alerting/index.ts`
- Keep `apps/worker/src/alerting/email-client.ts`

### Acceptance

- `index.ts` no longer knows about a concrete provider class
- email provider selection lives at the adapter boundary

---

## 2. [PENDING] Add SES adapter and tests

### Changes

- Add `apps/worker/src/alerting/ses-email-client.ts`
- Add unit tests for success, provider error, network/auth failure, and timeout cases
- Normalize AWS/SES failures into stable app error codes such as:
  - `email.http_error`
  - `email.auth_error`
  - `email.timeout`
  - `email.network_error`
  - `email.misconfigured`

### Dependency choice

Use `@aws-sdk/client-sesv2` unless the repo already has an approved internal AWS transport abstraction.

Reason:

- direct SigV4 request signing is unnecessary custom risk
- the AWS SDK is the lowest-risk way to talk to SES correctly
- this is a justified dependency because SES is now the supported outbound provider

### Files

- Add `apps/worker/src/alerting/ses-email-client.ts`
- Add `apps/worker/src/alerting/ses-email-client.test.ts`
- Update `apps/worker/package.json`

### Acceptance

- outbound email sends through SES in unit tests
- adapter errors are normalized and do not leak provider-specific exception shapes

---

## 3. [PENDING] Remove Resend code completely

### Changes

- Delete the Resend adapter source and tests
- Remove Resend exports from alerting index files
- Remove Resend-specific config comments and env overrides
- Remove Resend-specific runtime tests and assertions

### Files

- Delete `apps/worker/src/alerting/resend-email-client.ts`
- Delete `apps/worker/src/alerting/resend-email-client.test.ts`
- Modify `apps/worker/src/alerting/index.ts`
- Modify `apps/worker/src/config.ts`
- Modify `apps/worker/src/config.test.ts`
- Modify `packages/domain/src/config/schema.ts`
- Modify `config/default.yaml`
- Modify `.env.example`

### Acceptance

- no active source file imports or references `ResendEmailClient`
- no active source config path or env sample uses `RESEND_*`

---

## 4. [PENDING] Update config schema and operator-facing documentation

### Changes

- Rewrite the `alerts.email` schema comments so they describe SES and generic outbound email, not Resend
- Update current operational docs that still instruct operators to provide Resend credentials
- Update sample env files and any cluster connectivity docs that list Resend credentials

### Files

- Modify `packages/domain/src/config/schema.ts`
- Modify `config/default.yaml`
- Modify `.env.example`
- Modify `docs/features/2026/07/08/004-orchestration/003-cluster-safe-connectivity.md`

### Acceptance

- current setup docs no longer mention Resend as a live dependency
- operator config comments remain self-documenting and fail-fast aligned

---

## 5. [PENDING] Document the Zoho Mail operational setup

### Scope

This is documentation/runbook work, not application runtime code.

### Content to capture

- Zoho Mail is the system of record for human inboxes
- Create mailboxes or aliases such as `support@openaidom.com`
- Set MX records to Zoho Mail
- Keep SPF, DKIM, and DMARC valid for the domain
- Verify the sending domain in SES
- Ensure SES sending identity and Zoho-hosted inboxes can coexist cleanly

### Suggested output

- Update an existing operational doc or add a short runbook under `docs/runbooks/`

### Acceptance

- an operator can set up mailbox hosting and outbound delivery without guessing which provider owns which responsibility

---

## 6. [PENDING] Validate the migration end to end

### Tests

- `apps/worker/src/config.test.ts` covers new env overrides and required fields
- SES adapter unit tests pass
- agent broker tests still pass with the provider-neutral `EmailClient` mock
- targeted worker tests pass
- `pnpm lint` passes

### Suggested validation sequence

1. Run unit tests for the SES adapter and config loader
2. Run the agent broker email tests
3. Run worker build/typecheck
4. Run `pnpm lint`

### Acceptance

- email fanout still works through the `EmailClient` port
- no Resend code remains in active runtime paths
- operator docs match the implemented config surface

---

## File Inventory

### Add

- `apps/worker/src/alerting/ses-email-client.ts`
- `apps/worker/src/alerting/ses-email-client.test.ts`
- `apps/worker/src/alerting/create-email-client.ts` or equivalent
- optional runbook doc for Zoho Mail + SES setup

### Modify

- `apps/worker/src/index.ts`
- `apps/worker/src/alerting/index.ts`
- `apps/worker/src/config.ts`
- `apps/worker/src/config.test.ts`
- `packages/domain/src/config/schema.ts`
- `config/default.yaml`
- `.env.example`
- `apps/worker/package.json`
- current operator-facing docs that mention Resend

### Delete

- `apps/worker/src/alerting/resend-email-client.ts`
- `apps/worker/src/alerting/resend-email-client.test.ts`

---

## Outstanding Issues

### [Workstream 1] Provider-based composition

- **M1 (MEDIUM):** Factory returns `undefined` silently when Resend is unconfigured — no startup diagnostic. Add structured logging at factory-creation time when config is insufficient (e.g., `logger.warn`) so operators get immediate feedback.
- **M2 (MEDIUM):** `EmailClientConfig.resend.apiKey` is optional-inside-optional (`resend?: { apiKey?: string }`), allowing `resend: {}` to type-check. Tighten to require `apiKey` when `resend` block is present.
- **L1 (LOW):** Config schema comments in `packages/domain/src/config/schema.ts` still reference "Resend" and `RESEND_API_KEY`. Deferred to Workstream 4 per plan.

### [Workstream 2] SES adapter and tests

- **L1 (LOW):** `send()` method uses per-request `AbortController` instead of SDK-native `requestTimeout`. Consider passing `requestHandler: { requestTimeout }` to `SESv2Client` constructor for simplicity.
- **L2 (LOW):** Broad `message.includes('not verified')` fallback in misconfigured classification could theoretically match non-SES errors. Monitor in production; fine for now.
- **L3 (LOW):** Consider adding an integration/smoke test that sends a real email through SES using real credentials. Deferred to Workstream 6 validation.

### Regenerate

- built artifacts under `dist/` via normal build commands rather than manual edits

---

## Non-Goals

- adding inbound email processing inside the worker
- building a Zoho Mail adapter the app does not need
- preserving `RESEND_*` compatibility
- rewriting old historical feature-plan documents solely to erase history

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Treating Zoho Mail as an app delivery dependency | needless complexity | Keep Zoho at the mailbox/DNS layer and SES at the runtime adapter layer |
| SES credential/config sprawl | operator confusion | Use standard AWS env names and document the exact ownership of each field |
| Provider-specific errors leaking upward | unstable behavior and tests | normalize SES failures behind the `EmailClient` port |
| Incomplete Resend cleanup | stale docs and broken setup | include explicit grep-based cleanup and targeted config/doc tests |

---

## Acceptance Criteria

- The worker sends outbound email through SES behind the `EmailClient` port
- Zoho Mail is documented as the hosted inbox provider for human addresses
- All active Resend runtime code is deleted
- All active operator-facing Resend env/config references are removed
- `pnpm lint` passes
- Targeted worker tests for config and email delivery pass