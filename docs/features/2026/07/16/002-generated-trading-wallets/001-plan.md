# Generated Trading Wallets Implementation Plan

- **Status:** Proposed
- **Date:** 2026-07-16
- **Scope:** Allow a user to create a platform-managed main wallet for Jupiter, 1inch, or Hyperliquid, then persist and optionally assign its trading connection to agents.

## Outcome

The guided trading-connection flow will offer two mutually exclusive paths for supported DEX providers:

1. **Use existing credentials** — retain the current manual-secret flow unchanged.
2. **Create a wallet** — the API generates the user wallet key material, encrypts it, atomically provisions its credential, connection, and venue account, then returns only the public funding address.

Version one supports direct/main-wallet signing:

| Provider | Generated credential material | Public wallet reference | Operator-owned material |
|---|---|---|---|
| `hyperliquid` | EVM private key mapped to `secret`; its address mapped to `apiKey` and `walletAddress` | EVM address on Hyperliquid | None |
| `jupiter` | Solana private key mapped to `privateKey` | Solana public key | Jupiter developer-platform API key, when the adapter migration is complete |
| `1inch` | EVM private key mapped to `privateKey` | EVM address on the configured chain | 1inch developer API key |

The API must never return, log, journal, or put private key material into `connections.meta`, `venue_accounts`, or browser state. The public address is durable in `venue_accounts.venueAccountRef` and may be returned in the setup result.

## Confirmed Decisions

| Question | Decision | Consequence |
|---|---|---|
| Where is the public API? | Extend `POST /setup/provider-link`; do not add a parallel provisioning endpoint. | Reuses the existing atomic credential -> connection -> venue-account boundary and plan-limit locking. |
| How does a caller choose the path? | Add `credentialMode: 'manual' | 'generated'`; preserve manual as the explicit/default request mode. | Existing web, script, and API callers retain their current payload semantics. |
| Where does key generation live? | `@herobids/venues`, behind an explicit provider wallet-generation API. | API route has no provider-specific cryptography and future venues extend one owned seam. |
| What is stored for a generated wallet? | The normal encrypted `user_credentials` secret blob and `venue_accounts.venueAccountRef`. | No migration is required for private-key storage. |
| Where do 1inch/Jupiter API keys belong? | Typed operator config, passed through resolved application dependencies; never copied to user credential blobs. | Rotation is one deploy/config operation, not a per-user credential rewrite. |
| How do existing manual 1inch/Jupiter credentials behave? | 1inch user credentials contain only the signing key; the worker always uses the configured operator API key. Existing encrypted 1inch blobs may retain their historical API-key field, but runtime ignores it. | New writes do not replicate the shared key, and operator key rotation is one configuration deploy. |
| Does v1 automate deposits or bridges? | No. It displays address- and network-specific funding guidance only. | Avoids custody, fiat, bridge, and transaction-sponsoring scope in this feature. |
| Does v1 implement Hyperliquid agent wallets? | No. It defines extensible generation metadata only. | A later `hyperliquid-agent` custody mode can generate a separate delegated key and add authorization/funding states without changing the direct-wallet contract. |

## Critical Preconditions and Risks

1. **Jupiter API contract:** Verify current Jupiter developer-platform authentication and the supported swap endpoint before enabling generated Jupiter wallets. The current adapter calls `https://api.jup.ag/swap/v1` without an auth header; this is an existing integration gap. Add the operator key and authenticated adapter request as part of this work, or explicitly gate Jupiter generation until that prerequisite is validated against Jupiter's current documentation.
2. **Direct-wallet custody:** Generated Hyperliquid and 1inch credentials allow direct transaction signing. Product copy must state that OpenAIdom holds the generated signing key encrypted on the user's behalf. There is no key-export/recovery workflow in this plan; that must be an explicit product decision before enabling the feature in production.
3. **Operator secrets:** Missing enabled-provider API keys are startup configuration failures, not deferred request-time surprises. API and worker should start from the same validated `AppConfig` contract and reject generated setup for a disabled/unconfigured provider clearly.
4. **Plan quotas and idempotency:** Key generation occurs only after the existing advisory-lock quota checks pass, immediately before the one database transaction. A failed transaction must discard the in-memory generated key and leave no partial records.
5. **Funding is asynchronous:** A generated connection is structurally usable before it contains funds. Do not mark it funded or trading-ready merely because creation succeeded.

## Implementation Tasks

1. **Define the domain configuration and public capability contract.**
   - Modify `packages/domain/src/config/schema.ts` and `config/default.yaml` to model provider-owned API credentials and wallet-generation enablement under the operator `venues` configuration. Use defaults that leave generation disabled unless the relevant provider configuration is complete.
   - Add narrowly justified environment overrides in both `apps/api/src/config.ts` and `apps/worker/src/config.ts` for deploy-time provider secrets, following the existing typed-config pattern. Do not read these environment variables at route or adapter call sites.
   - Extend the provider-catalog types in `packages/domain` with a public, secret-free `walletGeneration` capability: availability, supported credential modes, public wallet network/chain label, and a funding-instruction identifier. Do not expose whether an operator secret is absent versus invalid.
   - Update `apps/api/src/providers/registry.ts` and its tests so only Hyperliquid, Jupiter, and 1inch advertise generated-wallet support when enabled by the resolved configuration. Bybit must remain manual-only.
   - **Depends on:** none.
   - **Risk:** config must be injected into `setupRoutes` and provider catalog construction rather than read from `process.env`.

2. **Add a provider-owned wallet-generation abstraction.**
   - Add `packages/venues/src/wallet-generation.ts` and export it from `packages/venues/src/index.ts`.
   - Define discriminated provider input/output types. The result must include provider, custody mode (`direct`), address, network/chain identifier, and an internal `secrets` object. Keep secret-containing result types out of API response types.
   - Generate EVM keys with existing `viem` primitives and derive addresses with `privateKeyToAccount`; generate Solana keys using the existing Solana dependency and encode the signer key in the exact format accepted by `SolanaSigner`.
   - Implement exact provider mappings: Hyperliquid direct wallet -> `{ apiKey: address, secret: privateKey, walletAddress: address }`; Jupiter -> `{ privateKey }`; 1inch -> `{ privateKey }`.
   - Reject unsupported providers and unavailable generation capability with typed errors. Add exhaustive unit tests for address formats, no secret leakage in public result data, deterministic schema mapping, and unsupported-provider failure.
   - **Depends on:** task 1 for capability and configuration types.
   - **Risk:** prove the Solana encoded private key round-trips through `SolanaSigner` and derives the returned public address.

3. **Extend atomic guided setup for generated credentials.**
   - Modify `apps/api/src/schemas.ts`, `apps/api/src/routes/setup.ts`, `apps/api/src/trading-provisioner.ts`, and `apps/api/src/index.ts`.
   - Extend `SetupProviderLinkSchema` with `credentialMode`; make manual requests require `secrets`, and generated requests prohibit client-supplied secrets and require a supported trading provider/capability.
   - Pass resolved operator configuration and the wallet generator into `setupRoutes` through explicit dependencies.
   - In generated mode: validate provider availability and plan quotas under the existing per-user advisory lock; generate only after those checks; validate generated secrets with the existing provider validator; encrypt and persist exactly as the manual path does; provision the connection and venue account in the same transaction.
   - Change `provisionTradingTarget` to receive and persist the public `venueAccountRef` for both generated wallets and manual providers that can supply an address. Preserve existing `null` behavior when no public reference is known.
   - Return an additive `wallet` object only for generated mode: `{ address, network, fundingInstructionId, custodyMode: 'direct' }`. Do not return a private key or operator-secret metadata.
   - Ensure all failure payloads are typed and clear: unsupported provider, generation disabled, operator configuration incomplete, validation failure, and plan limit exceeded. No partial creation or success audit event may occur after a failed transaction.
   - **Depends on:** tasks 1 and 2.
   - **Risk:** retain both current custom/non-trading setup and manual trading setup without accidentally making generated mode available to arbitrary custom providers.

4. **Make runtime adapter construction consume operator provider keys.**
   - Modify `apps/worker/src/venue-adapter-factory.ts`, its factory dependency type, and worker bootstrap wiring to receive the resolved venue configuration with provider API keys.
   - For 1inch, decrypt only the user signing private key for every credential and obtain the API key exclusively from typed operator configuration. Ignore any legacy credential `apiKey` already stored in existing encrypted rows; no destructive migration is required.
   - For Jupiter, add the verified developer-platform API key/header to `JupiterSwapAdapter` configuration and ensure the worker supplies the operator key. Update the adapter's current endpoint/configuration if Jupiter's validated API contract requires it.
   - Confirm Hyperliquid direct mode retains the invariant `apiKey === walletAddress` for generated credentials and that reconciliation queries the main address.
   - Return the actual derived EVM wallet address for 1inch in `SwapAdapterResult` rather than the current empty string, and use the durable `venueAccountRef` as the authoritative display/reference value where available.
   - Fail loudly when a live generated connection needs an operator API key that is unavailable; paper/shadow behavior must follow the existing venue execution semantics and must not silently use an empty key.
   - **Depends on:** tasks 1 through 3.
   - **Risk:** an API process and worker process must load the same config fields; add config-loader coverage in both applications.

5. **Adapt the provider registry and manual credential UX.**
   - Modify `apps/api/src/providers/registry.ts` so the 1inch credential schema contains only `privateKey`; the operator developer key must never appear in the provider catalog or browser form.
   - Keep the advanced manual credential route operational for externally held wallets. Canonicalization must discard a legacy user-supplied 1inch `apiKey` so new encrypted blobs do not retain it.
   - Update provider-catalog and credential validator tests to cover private-key-only manual credentials, legacy API-key discard, generated schema acceptance, and generated request rejection when the provider capability is disabled.
   - **Depends on:** tasks 1 and 3.
   - **Risk:** do not remove manual credentials merely because generated wallets exist; users may connect externally held wallets.

6. **Build the generated-wallet setup experience.**
   - Modify `apps/web/src/lib/api-client.ts`, `apps/web/src/features/setup/ProviderSetupForm.tsx`, `apps/web/src/features/connections/ConnectionsPage.tsx`, and `apps/web/src/features/setup/SetupProviderLinkPage.tsx` to consume the additive catalog and setup-result contracts.
   - In trading setup, present a segmented choice between **Use existing wallet** and **Create wallet**. Use the provider catalog to disable or hide creation for unsupported/unavailable providers, including Bybit and unconfigured 1inch/Jupiter.
   - In create mode, collect only provider and label; do not render secret inputs and do not construct a `secrets` payload. Submit `credentialMode: 'generated'` with `capability: 'trading'`.
   - Add a `WalletCreatedStep` component that precedes existing `AgentAssignmentStep`. It displays the address in a fixed-width copyable field, network-specific funding guidance, and clear state that trading begins only after the user funds the wallet. It must not claim deposits are automatically bridged or confirmed.
   - After the user acknowledges funding information, retain the existing optional agent assignment flow. On completion, invalidate connections, capability readiness, and agent queries as the current flow does.
   - Surface the public address and generated/direct-wallet status in connection details/cards without treating it as a secret. Keep labels and messages product-oriented; do not call the entry route a "setup link."
   - **Depends on:** tasks 1 and 3.
   - **Risk:** never cache or persist private key values in React state, browser storage, telemetry, error displays, or query data.

7. **Test and document the complete contract.**
   - Extend `packages/venues` unit tests for each generator and signer round trip.
   - Extend `apps/api/src/routes/setup.test.ts`, provider registry tests, config-loader tests, and worker `venue-adapter-factory.test.ts` to cover successful generated setup for all three providers, invalid/disabled providers, quota rejection before persistence, transaction rollback, address persistence, legacy-manual compatibility, and operator API-key resolution.
   - Extend `apps/web/src/features/setup/provider-setup-form.test.tsx` and `ConnectionsPage.test.tsx` for mode selection, no secret fields in generated mode, disabled provider behavior, wallet-address/funding display, and handoff to agent assignment.
   - Add a runbook section or feature documentation covering operator configuration, funding network per venue, secret rotation, generated-wallet deletion/revocation semantics, and the known no-export/recovery product boundary.
   - Run targeted unit suites for each modified package/app, then `pnpm lint` and the relevant build/test commands from the root.
   - **Depends on:** tasks 1 through 6.

## Test Strategy

| Level | Coverage |
|---|---|
| Unit | EVM and Solana key generation, provider secret mapping, address derivation, public-result redaction, registry capability projection, and config validation. |
| API route | Manual compatibility; successful generated setup; encrypted secret write; persisted `venueAccountRef`; atomic rollback; quotas; disabled provider; no private-key response; operator-secret prerequisite. |
| Worker integration/unit | Generated and manual 1inch/Jupiter connections use operator developer keys and user signer keys; legacy 1inch API-key fields are ignored; Hyperliquid direct credentials query/sign as the same main address. |
| Frontend component | Mode toggle, provider availability, generated request shape, address/funding handoff, and agent assignment continuation. |
| Manual integration | On testnet/sandbox where available, create each wallet, fund it with the documented network asset, verify balance/reconciliation, and execute only the smallest approved live trade. Jupiter validation is blocked until the authenticated current API contract is verified. |

## Deferred Work

- Hyperliquid delegated/agent-wallet (Option B) authorization transaction, approval state, revocation, and separate main/agent wallet lifecycle.
- Wallet export, recovery phrase handling, external-wallet import redesign, or third-party custodial/HSM integration.
- Automated bridging, gas sponsorship, card/fiat purchases, deposits, and funding-status polling.
- Multi-chain 1inch wallet routing beyond the already configured chain.

## Completion Criteria

1. A user can create a Jupiter, 1inch, or Hyperliquid direct wallet only when the provider is configured and enabled.
2. Creation atomically yields an encrypted credential, active connection, and linked venue account with a durable public wallet reference.
3. The user sees only the address and accurate funding guidance, then can assign the connection to agents through the existing workflow.
4. Existing manual connections continue to function, and every 1inch runtime path resolves its platform API key from validated operator configuration rather than user records.
5. Private keys do not appear in API responses, logs, journal events, browser state, tests' failure output, or non-encrypted database columns.
6. Targeted tests and `pnpm lint` pass.