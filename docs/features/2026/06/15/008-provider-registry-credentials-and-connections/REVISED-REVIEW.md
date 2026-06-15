# Review: Provider Registry For Credentials And Connections

## Verdict

Implemented cleanly in the current branch slice.

The branch adds shared catalog wire types in [packages/domain/src/provider-catalog.ts](../../../../packages/domain/src/provider-catalog.ts), a backend-owned registry and validator in [apps/api/src/providers/registry.ts](../../../../apps/api/src/providers/registry.ts) and [apps/api/src/providers/validator.ts](../../../../apps/api/src/providers/validator.ts), an authenticated catalog route in [apps/api/src/routes/providers.ts](../../../../apps/api/src/routes/providers.ts), and frontend form consumption in the credential, connection, and setup flows. I did not find a blocking correctness issue in this slice.

## Findings

No blocking findings in the branch-local implementation.

Residual risk is mainly contract drift: the registry, validator, and frontend renderers now share one contract, so future provider additions need tests that prove those three layers stay aligned.

## Suggested Change List

1. Low: add a contract test that every provider entry round-trips through the public catalog serializer and the validation layer without field drift.
   Files/functions: [apps/api/src/providers/registry.ts](../../../../apps/api/src/providers/registry.ts), [apps/api/src/providers/validator.ts](../../../../apps/api/src/providers/validator.ts), [apps/api/src/routes/providers.test.ts](../../../../apps/api/src/routes/providers.test.ts).
   Change: add.
   Dependencies: none.
   Risks/Open questions: new providers are now data-driven, so a catalog/validator mismatch would be easy to introduce without one shared regression test.
   Test expectation: unit or integration test only.

2. Low: add one cross-surface UI integration test that proves the same catalog entry drives both credential-field rendering and connection compatibility filtering.
   Files/functions: [apps/web/src/features/credentials/CredentialsPage.tsx](../../../../apps/web/src/features/credentials/CredentialsPage.tsx), [apps/web/src/features/connections/ConnectionsPage.tsx](../../../../apps/web/src/features/connections/ConnectionsPage.tsx), [apps/web/src/features/setup/ProviderSetupForm.tsx](../../../../apps/web/src/features/setup/ProviderSetupForm.tsx).
   Change: add.
   Dependencies: none.
   Risks/Open questions: this is mostly maintainability insurance as the provider list grows.
   Test expectation: integration or render test; no visual verification needed.