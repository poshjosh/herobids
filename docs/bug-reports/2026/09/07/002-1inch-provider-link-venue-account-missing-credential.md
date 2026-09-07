# Bug Report: 1inch trading agent crashes on start — provider-link venue account has NULL `credential_id`

- **Status:** OPEN (investigation only — no fix applied; root cause narrowed but not fully confirmed)
- **Severity:** High (a 1inch trading agent/bot cannot start in non-paper mode: the runtime throws `CredentialResolutionError` and the agent lands in `crashed`). Contained today because it surfaces in the `platform-preset-assessment` e2e test, but the same code path is what real 1inch trading agents use.
- **Date:** 2026-09-07
- **Discovered By:** Investigating a `platform-preset-assessment-test` failure (`scripts/shell/tests/run-extra-tests.sh`, Tier 5). Reproduced live twice on a freshly-built worker image (venue `1inch`, `EXECUTION_MODE=shadow`, LLM provider `ollama`).
- **Not caused by:** the `docs/features/2026/09/07/001-relocate-trading-types-out-of-agent-protocol.md` type-relocation refactor. That was verified unrelated (all moved symbols resolve at runtime through the compiled domain barrel; the worker image builds from source; nothing references the old module path; the crash originates in `venue-adapter-factory.ts`, which the refactor never touched).

## Summary

When a 1inch trading connection is created through `POST /setup/provider-link` (the "guided setup" path used by Mission Control, Create-AI-Agent, and the e2e test harnesses), the companion **venue account row is persisted with `credential_id = NULL`**, even though the **connection** row in the same flow is correctly linked to the freshly-created credential.

At agent/bot start, the worker resolves venue credentials from `venue_accounts.credential_id` (not from the connection). Because that column is NULL, `buildSwapAdapter` for 1inch throws:

```
CredentialResolutionError: Venue account <id> has no linked credential — cannot resolve 1inch secrets
```

(`apps/worker/src/venue-adapter-factory.ts:243`). The agent then transitions to `crashed`.

## Impact

- **Direct:** A 1inch trading agent (or bot) cannot start in any non-paper mode. The 1inch branch in `venue-adapter-factory.ts` has **no paper-mode exemption** (unlike the generic orderbook branch), so it hard-requires a linked credential and crashes when it is absent.
- **Observed cascade in the e2e suite:** the crashed agent could not be deleted via the API (`DELETE /agents/:id` → `409 agent_not_stopped`), leaked, and exhausted the plan's 1-agent limit, causing a later scenario's `createAgent` to fail with `403 plan.limit_exceeded`. (That *cascade* has been separately mitigated in the test harness — see "Related" — but the underlying crash documented here is unaddressed.)

## Evidence (reproduced live, DB inspected)

Two provider-links were created by the assess-test during reproduction (freshly-built worker image, same session). Joining `connections` to their resolved `venue_accounts`:

```
        conn         | provider |   conn_cred (connections.credential_id)   |         va          | va_cred (venue_accounts.credential_id) | match
---------------------+----------+-------------------------------------------+---------------------+----------------------------------------+-------
 6d7ab79b-… (assess) | 1inch    | 25bb456c-…                                | 229c0fdc-…          | (NULL)                                 |
 2b7928d8-… (assess) | 1inch    | 00eccea1-…                                | 7cb841f5-…          | (NULL)                                 |   ← crashed agent's VA
 9a51ee8f-… (assess) | 1inch    | ef045027-…                                | 4b4065e4-…          | (NULL)                                 |
 e4cc3c8c-… (bot-tt) | 1inch    | f4b0bfec-…                                | 6aa19a21-…          | f4b0bfec-…                             |   t
 92473085-… (bot-tt) | hyperlq  | aa4381dd-…                                | 54ba30f6-…          | aa4381dd-…                             |   t
```

Key observations:
- For **every** assess-test 1inch provider-link, the **connection has the credential** but the **venue account's `credential_id` is NULL**.
- For the `bot-trade-test`-origin rows (1inch and hyperliquid), `venue_accounts.credential_id` **is** populated and matches the connection.
- The runtime resolves from the VA, so the NULL causes the crash.

Worker log at the crash (agent `fdeb3bba-…`, VA `7cb841f5-…`):

```
ERROR (agent-session-manager): Agent trading actor failed to initialize
  type: CredentialResolutionError
  CredentialResolutionError: Venue account 7cb841f5-… has no linked credential — cannot resolve 1inch secrets
WARN  (docker-agent-manager): Agent container died — runtime_crash  crashType: runtime_crash
```

## Where the crash is thrown

`apps/worker/src/venue-adapter-factory.ts`, 1inch swap branch:

```ts
const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
if (account?.credentialId) {
  // …decrypt and use…
} else {
  throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential — cannot resolve 1inch secrets`); // :243
}
```

Note the asymmetry vs. the generic orderbook branch (~`:135`), which only requires a credential when `executionMode !== 'paper'`:

```ts
} else if (executionMode !== 'paper') {
  throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential`);
} else {
  logger.warn(… 'Paper mode: venue account has no linked credential — proceeding without credentials');
}
```

The 1inch branch has no such paper-mode path — it throws unconditionally when `credentialId` is absent.

## Root cause — narrowed, but one contradiction remains open

The write path that *should* populate `venue_accounts.credential_id` looks correct on inspection:

- `apps/api/src/routes/setup.ts` → `createProviderLink`: inside one DB transaction it inserts `user_credentials` (id = `credentialId`), inserts `connections` with that `credentialId`, and — when `capability === 'trading'` — calls `provisionTradingTarget(tx, { …, credentialId, … })` (~`setup.ts:194`).
- `apps/api/src/trading-provisioner.ts` → `provisionTradingTarget`: inserts the venue account with `credentialId: opts.credentialId` and sets `connections.resolvedVenueAccountId` (~`trading-provisioner.ts:30`). This propagation has existed since commit `077afcab` (2026-06-10).

**The contradiction:** the assess-test and `bot-trade-test` send effectively identical `POST /setup/provider-link` payloads — same `capability: 'trading'`, same secret shape, only the `label` differs — yet only `bot-trade-test`'s venue account ends up with a non-NULL `credential_id`. Per the code above, both should populate it. This was **not** resolved by static inspection or DB inspection alone. The DB timestamps confirm the two NULL-credential rows (`7cb841f5`, `229c0fdc`) were created **this session by the freshly-built image**, which argues against "stale leftovers from an older build" and for a genuine defect in the 1inch provider-link → venue-account credential propagation.

**Corroborating signal:** the *other* venue-account creation path, `POST /venue-accounts` (`apps/api/src/routes/accounts.ts:113`), explicitly rejects a 1inch account without a credential (`account.validation_error.missing_credential_id`, covered by a unit test). So a NULL-credential 1inch VA is already recognized elsewhere as invalid — the provider-link path is producing a state the primitive path forbids.

### Hypotheses to test next (each requires runtime instrumentation → a code change, deliberately not done here)

1. **`credentialId` passed as null/undefined into `provisionTradingTarget` for 1inch.** Log the exact `credentialId` argument at the `provisionTradingTarget` call site for a 1inch trading provider-link, and confirm the `capability === 'trading'` branch is actually entered.
2. **1inch secret canonicalization/validation diverts the flow.** Confirm `canonicalizeVenueSecrets('1inch', …)` + `validateVenueSecrets('1inch', …)` pass for the assess-test's `venueSecrets()` payload (`{ apiKey, privateKey }`), so the transaction reaches the VA insert rather than returning `validation` early. (Note: `credentials.ts` tests show 1inch discards a user-supplied `apiKey` before encryption — verify that canonicalization does not drop a field the VA-provisioning branch depends on.)
3. **A second write overwrites/creates the VA without the credential.** Confirm no post-transaction path (or agent-start binding) re-creates or updates the venue account with a NULL `credential_id` after `provisionTradingTarget` set it.

Hypothesis 1 is the cheapest first probe and most likely to localize the defect.

## Steps to Reproduce

1. Configure `.env.ops.dev` with `VENUE=1inch`, `EXECUTION_MODE=shadow`, valid `ONEINCH_API_KEY` + `ONEINCH_PRIVATE_KEY`, LLM provider reachable.
2. Bring up the stack and run: `DOCKER_COMPOSE_UP=1 bash scripts/shell/tests/platform-preset-assessment-test.sh --scenario S3`.
3. Observe the S3 agent transition to `crashed`.
4. Inspect the DB:
   ```sql
   SELECT c.id AS conn, c.credential_id AS conn_cred,
          va.id AS va, va.credential_id AS va_cred
   FROM connections c
   JOIN venue_accounts va ON va.id = c.resolved_venue_account_id
   WHERE c.provider = '1inch'
   ORDER BY c.created_at DESC LIMIT 5;
   ```
   **Observed:** `conn_cred` is set, `va_cred` is NULL.
   **Expected:** `va_cred` equals `conn_cred`.
5. Worker logs show `CredentialResolutionError: Venue account … has no linked credential — cannot resolve 1inch secrets`.

## Proposed direction (NOT applied — decision pending)

1. **Fix the write path (primary).** Ensure `POST /setup/provider-link` for a 1inch trading connection persists `venue_accounts.credential_id` = the created credential, matching the hyperliquid/`bot-trade-test` behavior and the `provisionTradingTarget` contract. Confirm with hypothesis 1/2 first so the fix targets the actual divergence rather than the symptom.
2. **Defense-in-depth (server-side guard).** Mirror the `POST /venue-accounts` guard (`accounts.ts:113`) inside `createProviderLink`: a 1inch trading provider-link must not commit a venue account with a NULL `credential_id` — fail the transaction with a clear error instead of persisting an unusable account that only surfaces as a runtime crash later.
3. **Product decision (separate).** Decide whether `EXECUTION_MODE=shadow` should require live venue credentials for 1inch at all. The generic orderbook branch exempts `paper`; the 1inch branch (`venue-adapter-factory.ts:243`) hard-requires a credential in every mode. If shadow is meant to simulate without real secrets, this asymmetry should be reconciled.

## Verification (for whoever fixes this)

| Check | How |
|-------|-----|
| Provider-link links VA credential | Create a 1inch trading provider-link → `venue_accounts.credential_id` = the created credential (matches `connections.credential_id`) |
| 1inch agent starts | S3 of `platform-preset-assessment-test` reaches `active` (not `crashed`) with a real 1inch connection |
| No unusable VA persisted | If credential linkage cannot be established, the provider-link transaction fails cleanly rather than committing a NULL-credential VA |
| Hyperliquid unaffected | Hyperliquid provider-link still links VA credential as before |
| Shadow-mode decision honored | Behavior in `shadow` mode matches the product decision from item 3 |
| `pnpm lint` passes | tsc `--noEmit` clean |

## References

- `apps/worker/src/venue-adapter-factory.ts` — 1inch credential resolution + throw (~`:198`–`:245`, throw at `:243`); generic orderbook paper-mode exemption (~`:135`)
- `apps/api/src/routes/setup.ts` — `createProviderLink` (credential + connection + `provisionTradingTarget`), trading branch (~`:180`–`:200`)
- `apps/api/src/trading-provisioner.ts` — `provisionTradingTarget` inserts VA with `credentialId: opts.credentialId` (~`:30`); sets `connections.resolvedVenueAccountId`
- `apps/api/src/routes/accounts.ts` — `POST /venue-accounts` rejects 1inch without a credential (`:113`); VA insert allows `credentialId ?? null` (`:145`)
- `apps/worker/src/startup-context.ts` — resolves VA from `connections.resolvedVenueAccountId` at start (~`:83`–`:150`)
- `apps/worker/src/index.ts` — start-time `buildSwapAdapter({ venueAccountId: resolvedVenueAccountId, … })` (~`:1934`)
- `scripts/ts/platform-preset-assessment-test.ts` — S3 create/start; `venueSecrets()` 1inch payload (`{ apiKey, privateKey }`)
- `scripts/ts/bot-trade-test.ts` — provider-link that DOES link the VA credential (~`:270`)

## Related

- `scripts/ts/platform-preset-assessment-test.ts` cleanup was made resilient to `crashed` agents (commit `f03e7306`) so this crash no longer cascades into a `plan.limit_exceeded` failure in a later scenario. That is a test-harness mitigation only; it does not address the credential-linkage defect described here.
