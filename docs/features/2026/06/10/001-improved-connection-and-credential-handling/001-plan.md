# IMPROVED CONNECTION AND CREDENTIAL HANDLING

## Product Stance

1. The unified form lives only in two places:
- Mission Control
- Create Agent

2. The primitive setup pages remain in the product, but they become advanced or partial tools.
- Credentials remains a low-level secret-management page.
- Connections remains a low-level provider-link page.
- Venue Accounts remains an advanced trading page.

3. This is acceptable and intentional.
The product should treat the unified form as the guided setup path and the primitive pages as manual fallback or advanced operators' tools.

4. Do not add a separate unified-setup page to navigation.
The form should be surfaced only from Mission Control and inside Create Agent.

## Implementation Plan

1. Define one explicit setup concept.
The unified form should represent a setup flow, not a new primitive. Credentials, connections, bindings, and venue accounts remain separate resources. The new flow orchestrates creation of one, two, or three resources depending on user input.

2. Audit existing data before removing hidden behavior.
Before removing either hidden side effect, audit existing connections and bindings to identify any users who currently rely on read-time backfill or connection-time auto-provisioning.
This avoids shipping a change that makes existing connections disappear from trading setup without a repair path.

3. Remove the write-side hidden effect from connection creation.
In `apps/api/src/routes/connections.ts`, delete the branch that auto-creates:
- venue account
- trading binding

`POST /connections` should only:
- validate credential compatibility
- create the connection

4. Remove the read-side hidden effect from trading binding listing.
In `apps/api/src/routes/capabilities/trading.ts`, remove or replace `ensureTradingBindingsForUser` so that `GET /capabilities/trading/bindings` becomes read-only and returns only explicitly provisioned bindings.

This is required because otherwise hidden provisioning simply moves from connection creation to binding listing.

5. Add one transactional trading-setup endpoint.
Do not let the frontend chain `POST /credentials`, `POST /connections`, and binding creation itself.

Add one orchestration endpoint such as:
- `POST /setup/provider-link`
- or `POST /capabilities/trading/setup`

The endpoint should run in one transaction.

Request shape:
- provider
- label
- secrets as key/value
- optional capability

Response shape:
- created credential summary
- created connection summary
- optional created binding summary
- optional created venue account summary if trading setup still requires it internally

6. Keep the old primitive endpoints unchanged in purpose.
- `POST /credentials` continues to create only credentials.
- `POST /connections` continues to create only connections.

This preserves the low-level forms exactly as requested and keeps resource semantics clean.

7. Implement capability-specific provisioning only inside the setup endpoint.
For `capability = trading`, the setup endpoint should explicitly do the work that is currently hidden in other flows:
- create credential
- create connection
- create companion venue account
- create trading binding with a non-null `sourceVenueAccountId`

This is required because bot creation currently depends on `sourceVenueAccountId` being present on the trading binding.

8. Centralize trading provisioning logic in a shared backend service/helper.
Do not duplicate binding creation logic between routes.

Extract a helper that provisions a trading target from an existing connection, including:
- venue account creation
- trading binding creation
- default binding payload derivation

The new setup endpoint should call that helper.

9. Keep label derivation server-owned.
The unified form should collect one base label.
The backend should derive defaults for created resources, for example:
- credential label
- connection label
- trading binding label

This keeps naming consistent across Mission Control and Create Agent and avoids frontend drift.

10. Keep the API shape capability-aware but implementation-limited.
Allow the setup endpoint to accept an optional capability, but only implement trading initially.
That keeps the wire shape future-friendly without pretending multiple capability families are ready now.

11. Create one shared unified form component.
Create one reusable web component, for example under a dedicated setup feature folder, and use it in exactly two places:
- Mission Control
- Create Agent

The shared component should own:
- provider input
- base label input
- secrets editor
- optional capability selector
- submit lifecycle
- success payload handling contract

The host surface should own:
- where the form opens
- surrounding copy
- success navigation or selection behavior

12. Surface the unified form on Mission Control only, not as a replacement page.
Add a guided setup card or action block to `MissionControlPage.tsx`.

Recommended behavior:
- headline like "Quick trading setup" or "Add provider setup"
- launches the shared unified form in a modal or drawer
- on success, show the created resources and a CTA to create or configure an agent

This satisfies the "Dashboard only" requirement without adding new navigation.

13. Add the unified form to Create Agent as an inline escape hatch.
Inside the existing trading setup section in `AgentsPage.tsx`, keep the current binding selector, but add a secondary action like "Add new trading setup".

That action should open the same shared unified form, prefilled with `capability = trading`.

On success:
- invalidate trading bindings query
- refetch bindings
- automatically select the newly created binding in the current agent intent state

14. Keep the primitive pages, but reposition them in copy as advanced or partial tools.
Because the unified form only lives in Mission Control and Create Agent, the primitive pages need explicit framing.

Update the copy on those pages to make clear that:
- credentials is secret management
- connections is a low-level provider-link page
- full trading setup is completed from Mission Control or during agent creation

15. Update copy everywhere from "create a connection" to "complete trading setup" where that wording is now wrong.
Once connection creation no longer provisions bindings, any wording that equates connection creation with complete trading readiness becomes false.

Update the relevant copy in at least:
- `AgentCapabilityPage.tsx`
- `AgentsPage.tsx`
- Mission Control action copy if needed
- primitive setup pages where users may otherwise assume they are completing the full guided flow

16. Update capability-page guidance so it points to the allowed setup surfaces.
Because the unified form lives only on Mission Control and Create Agent, the trading capability page should not point users back to connections as if that completes setup.

Its empty-state and next-step guidance should point users to:
- Mission Control for guided setup
- Create Agent for inline setup while creating an agent

17. Add focused tests for the behavior change.
Backend:
- update `connections.test.ts` to assert that `POST /connections` no longer creates bindings
- add tests for the new setup endpoint covering:
  - credential + connection only
  - credential + connection + trading binding
  - transaction rollback on partial failure
  - provider or credential validation
- add tests ensuring `GET /capabilities/trading/bindings` no longer backfills
- add tests for any one-time repair or migration path introduced for existing data

Frontend:
- component tests for the shared unified form
- Mission Control integration test
- Create Agent flow integration test that creates setup and auto-selects the new binding
- copy assertions for updated guidance where the wording changes materially

18. Add a rollout-safe repair step for existing users.
If any existing connections currently depend on implicit binding creation, introduce either:
- a one-time migration that provisions the missing bindings and companion venue accounts before shipping the removal of hidden effects
- or an explicit repair script run during rollout

Do not rely on the old read-side backfill once the new model is in place.

19. Update documentation and UAT language.
Because this is a user-facing setup model change, update:
- setup copy in the web app
- capability setup docs and UAT notes that currently assume "connection first"
- any docs that state or rely on automatic binding creation from connection creation
- any tests or bug notes that encode the old auto-creation contract

20. Remove or revise obsolete assumptions that `POST /connections` creates trading bindings.
There are tests, notes, and bug reports that currently document the auto-creation contract. Those references must be updated so the codebase no longer teaches the old behavior.

## Additional Items That Were Easy To Miss

1. Remove both hidden side effects, not just the write-side one.
The read-side backfill in trading bindings listing must also go.

2. Existing data needs a repair strategy.
If hidden backfill is removed without a migration or repair pass, some existing connections may no longer appear as usable trading setup.

3. The unified form living only on Mission Control and Create Agent changes the role of the primitive pages.
Those pages now need explicit copy telling users they are advanced or partial tools.

4. Bot creation still depends on `sourceVenueAccountId`.
The new explicit trading setup flow must continue to provision a venue account and attach it to the binding.

5. Capability-page guidance must change, not just form placement.
Pages that currently say "create a trading connection first" need to point users to the actual guided setup surfaces.

6. The setup endpoint must stay transactional.
If credential creation succeeds and connection or binding creation fails, the whole operation should roll back.

7. Label derivation should remain server-owned.
If the frontend derives resource-specific labels independently in two hosts, naming will drift.

8. Tests and docs currently encode the old auto-creation contract.
They must be updated as part of the rollout, not left behind as stale expectations.