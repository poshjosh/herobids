# Staging Environment Setup

## Status

`implemented`

## Problem

OpenAIdom does not currently have a real staging environment.

The current deploy path uses a single Hetzner stack and a single production-oriented compose overlay, but that overlay still runs the API and worker with `NODE_ENV=staging`. As a result:

1. staging and production are not separate environments
2. production-only guards are not exercised under a true production runtime
3. domains and auth origins are hardcoded for `herobids.com`
4. deploy scripts only target one Terraform state and one server output
5. the TODOs marked `staging-setup` cannot be resolved cleanly without creating an actual environment split first

This plan defines how to create a proper staging environment and what to do immediately afterward so the repo has a clean two-environment deployment model.

## Goals

1. create a real staging environment that is separate from production in infrastructure, secrets, runtime mode, and external endpoints
2. make staging reusable for pre-production validation of deploys, config changes, OAuth flows, webhooks, and billing UI behavior
3. restore production to true `NODE_ENV=production` semantics
4. eliminate the current hardcoded-domain and single-target deployment assumptions that block reuse
5. resolve all currently known `TODO: staging-setup` items as part of the staging rollout

## Non-Goals

1. do not redesign the whole deployment system around Kubernetes, Nomad, or a new hosting provider in this feature
2. do not implement full CI/CD automation unless it is the minimum needed for reliable staging deploys
3. do not broaden this into a full production hardening or secrets-management program beyond what staging requires immediately
4. do not mix staging setup with unrelated billing-ledger, subscription, or UX fixes

## Current State Summary

The current codebase and deploy setup have these staging blockers:

1. `docker-compose.prod.yaml` sets `NODE_ENV: staging` for the API and worker.
2. The same file hardcodes `AUTH_PUBLIC_BASE_URL` and `AUTH_FRONTEND_ORIGIN` to `https://herobids.com`.
3. `Caddyfile` is hardcoded for `herobids.com`, `www.herobids.com`, and `app.herobids.com`.
4. Hetzner deploy scripts auto-discover a single server from one Terraform state.
5. `config/staging.yaml` and `config/production.yaml` still default billing to `mock`.
6. Production guards in `apps/api/src/config.ts` and `apps/worker/src/config.ts` only trigger when `NODE_ENV=production`, so the current pseudo-production path avoids the guard instead of satisfying it.

## Design Principles

1. staging must be isolated enough that mistakes in staging cannot mutate production state
2. production must stop depending on staging semantics to boot successfully
3. hostnames and public origins must be parameterized, not hardcoded into the production overlay
4. staging should use safe defaults: live trading disabled by default unless explicitly justified, and non-production billing/provider credentials where possible
5. deploy scripts must make the target environment explicit instead of inferring a single global server

## Proposed End State

After this feature lands:

1. OpenAIdom has separate staging and production deploy targets.
2. Staging has its own domain, server name, Terraform state, and env file.
3. Production runs with `NODE_ENV=production`.
4. Auth origins, webhook URLs, and public hostnames are environment-driven.
5. Staging can be used for smoke tests, OAuth checks, Telegram webhook checks, billing UI verification, and deploy rehearsals before production rollout.
6. The current `TODO: staging-setup` placeholders are removed or replaced with explicit environment behavior.

## Implementation Plan

### Phase 1 - Define the environment contract

#### Goal

Make staging and production explicit first-class environments in infra, config, and deployment scripts.

#### Files

- `infra/hetzner/variables.tf`
- `infra/hetzner/terraform.tfvars.example`
- `infra/hetzner/outputs.tf`
- `infra/hetzner/README.md`
- deployment scripts under `infra/hetzner/scripts/`

#### Tasks

1. Decide the environment identifiers to support now: at minimum `staging` and `production`.
2. Define a naming convention for per-environment values:
   - server name
   - app domain
   - env file name
   - Terraform state or workspace
3. Make the deploy target explicit in scripts instead of always using the single default Terraform output.
4. Document the contract clearly so operators know which files and commands map to which environment.

#### Expected Result

Operators can tell the system which environment to provision or deploy without editing scripts ad hoc.

#### Validation

1. Confirm the docs and scripts support selecting both staging and production.
2. Confirm there is no remaining script path that silently assumes only one server exists.

### Phase 2 - Split infra targets for staging and production

#### Goal

Create real infrastructure separation so staging is not just a different runtime flag on the same host.

#### Files

- `infra/hetzner/main.tf`
- `infra/hetzner/cloud-init.yaml`
- `infra/hetzner/variables.tf`
- `infra/hetzner/outputs.tf`
- new per-environment tfvars or wrapper docs/scripts

#### Tasks

1. Choose the isolation model:
   - preferred: separate Hetzner server for staging
   - acceptable only if temporary: separate Terraform target with clearly isolated host resources
2. Create a staging server name and staging domain.
3. Ensure staging and production use separate volumes, databases, Redis instances, and Docker networks.
4. Preserve `prevent_destroy` or an equivalent safety mechanism for production while keeping staging manageable.
5. Ensure cloud-init and bootstrap logic remain environment-agnostic except for injected variables.

#### Expected Result

Staging becomes a real deployable stack with independent persistence and runtime state.

#### Validation

1. `terraform plan` for staging shows new resources rather than mutating production in place.
2. Terraform outputs expose a staging frontend URL and API URL.

### Phase 3 - Split the compose overlays and parameterize public origins

#### Goal

Stop treating the production overlay as a staging stand-in.

#### Files

- `docker-compose.prod.yaml`
- new `docker-compose.staging.yaml`
- `Caddyfile` or environment-specific Caddy config files
- `apps/web/Dockerfile`
- `apps/web/src/lib/config.ts`

#### Tasks

1. Create a dedicated staging compose overlay.
2. Change the production overlay so API and worker run with `NODE_ENV=production`.
3. Parameterize these values rather than hardcoding `herobids.com`:
   - `AUTH_PUBLIC_BASE_URL`
   - `AUTH_FRONTEND_ORIGIN`
   - `VITE_API_ORIGIN`
   - Telegram webhook base URL where needed
4. Decide whether Caddy will use:
   - one parameterized config template, or
   - separate staging and production Caddyfiles
5. Ensure the web build gets the correct API and OAuth origin for each environment.
6. Remove the current `TODO: staging-setup` comments from the compose overlay once the split is complete.

#### Expected Result

Each environment has its own deploy overlay and public-origin wiring, and production no longer depends on staging runtime flags.

#### Validation

1. A staging deploy serves staging domains and auth origins only.
2. A production deploy serves production domains and auth origins only.
3. Web login initiation points at the correct API origin in both environments.

### Phase 4 - Separate environment config and secret handling

#### Goal

Make staging and production use distinct env files and external credentials.

#### Files

- `config/staging.yaml`
- `config/production.yaml`
- env-file conventions under `infra/hetzner/`
- `apps/api/src/config.ts`
- `apps/worker/src/config.ts`
- deploy scripts that upload env files

#### Tasks

1. Create an explicit staging env file convention, for example `.env.staging` or `.env.stage`.
2. Keep separate secrets for staging and production, including:
   - JWT secret
   - OAuth client IDs and secrets
   - Telegram bot token and webhook secret
   - billing provider credentials
   - LLM provider keys
   - market data keys where separate quotas are desired
3. Decide the safe default behavior for staging:
   - billing provider: mock or provider test mode
   - live trading rollout: disabled by default
   - alerting/webhooks: enabled only if intentionally configured
4. Update setup and deploy scripts so the operator explicitly chooses which env file to upload.
5. Ensure staging never reuses production callback URLs or webhook URLs.

#### Expected Result

Staging and production are isolated at the secret and third-party integration level, not just in source-controlled YAML.

#### Validation

1. A staging env upload does not overwrite or reuse the production env file.
2. Production startup still enforces the non-mock billing guard when `NODE_ENV=production` and live rollout is enabled.
3. Staging startup succeeds with its intended safe billing/runtime combination.

### Phase 5 - Define environment-specific runtime policy

#### Goal

Make staging behavior explicit instead of accidental.

#### Files

- `config/staging.yaml`
- `config/production.yaml`
- `config/default.yaml`
- any docs that describe environment expectations

#### Tasks

1. Define what staging is allowed to do:
   - paper only, or selective live testing
   - mock/test billing only, or production billing test mode
   - real notifications or sandbox notification channels only
2. Encode staging-specific operator overrides in `config/staging.yaml` only where they differ from defaults.
3. Keep production overrides minimal and intentional.
4. Verify that no production-only guard is bypassed by using a non-production runtime in the production stack.

#### Expected Result

The differences between staging and production are deliberate, documented, and enforced by config.

#### Validation

1. `NODE_ENV=staging` loads `config/staging.yaml` and the intended env overrides.
2. `NODE_ENV=production` loads `config/production.yaml` and fails loudly when required production settings are unsafe.

### Phase 6 - Update deployment workflow and operator documentation

#### Goal

Make the new staging environment operable by someone other than the original implementer.

#### Files

- `infra/hetzner/README.md`
- `README.md` if needed
- deploy scripts under `infra/hetzner/`
- optional runbooks under `docs/`

#### Tasks

1. Document how to provision staging from scratch.
2. Document how to deploy staging and production separately.
3. Document how to upload or rotate env files for each environment.
4. Document the expected DNS entries and TLS behavior.
5. Document the smoke-test checklist operators must run after each staging deploy.

#### Expected Result

The environment split is operationally usable and not trapped in tribal knowledge.

#### Validation

1. A fresh operator can follow the docs to provision and deploy staging.
2. The docs no longer claim that hardcoded production values must be edited directly for custom domains.

### Phase 7 - Validate staging end to end

#### Goal

Prove staging works before changing production to true production mode.

#### Areas to verify

1. web app loads correctly
2. API health endpoint works
3. OAuth redirect flow works against staging origins
4. Telegram webhook registration and inbound handling work if configured
5. billing page behavior matches the configured staging billing mode
6. worker boots, loads config, and stays healthy
7. migrations run correctly on staging

#### Tasks

1. Deploy staging using the new workflow.
2. Run smoke tests against the staging URLs.
3. Capture any staging-only config gaps and close them before touching production.
4. Add or update focused automated checks if repeated staging mistakes are likely.

#### Expected Result

Staging becomes the proving ground for deploy and config changes instead of production.

#### Validation

1. Manual smoke test checklist passes.
2. Relevant repo validation commands pass.
3. No staging deploy step requires manual code edits on the server.

### Phase 8 - Promote production to true production mode

#### Goal

Finish the environment split by making production actually run as production.

#### Files

- `docker-compose.prod.yaml`
- `config/production.yaml`
- production env file conventions
- deploy docs as needed

#### Tasks

1. Set production API and worker to `NODE_ENV=production`.
2. Ensure production billing is no longer `mock` when live rollout is enabled.
3. Re-run the production deploy using the explicit production path.
4. Remove any remaining staging-era comments, workarounds, or TODO markers tied to the old pseudo-production setup.

#### Expected Result

Production behavior is aligned with the code’s real production safety model.

#### Validation

1. Production starts successfully under `NODE_ENV=production`.
2. Health checks pass.
3. Login, core app navigation, worker boot, and billing configuration behave as expected.

## TODOs Resolved By This Feature

All known staging-setup follow-ups are resolved:

1. ✅ `docker-compose.prod.yaml`: replaced temporary `NODE_ENV: staging` with `NODE_ENV: production` (Phase 3).
2. ✅ `docker-compose.prod.yaml`: auth origins are parameterized per-environment via separate overlays (Phase 3).
3. ✅ `infra/hetzner/.env.prod`: production enforces non-mock billing via startup guard in `config.ts` (Phase 4).
4. ✅ `SCATCHPAD.md`: file never existed — no scratchpad was created during the original workaround period. No action needed.

## Validation Plan

Run validation in this order:

1. Static review of generated config and deploy docs.
2. `terraform plan` for staging.
3. Focused config validation and type-check commands:
   - `pnpm lint`
4. Local compose-level sanity checks where practical.
5. Real staging deploy and smoke test.
6. Only after staging is proven, production deploy with `NODE_ENV=production`.

Suggested smoke-test checklist:

1. `GET /health` returns 200 on staging.
2. Web app loads and can reach the staging API.
3. Google OAuth starts with the staging origin.
4. Billing page renders expected staging provider behavior.
5. Worker logs show correct environment selection and no startup guard failures.
6. Telegram webhook URL, if configured, points to staging and can receive a test event.

## Rollout Order

1. land the config and deployment-path refactor without changing live production behavior yet
2. provision and deploy staging
3. run staging smoke tests and fix gaps
4. switch production to true production runtime mode
5. document the final operator workflow

## Post-Implementation Tasks

After the code and docs land, the operator still needs to perform these manual or operational follow-through steps:

### Required manual setup

1. create the staging DNS records
2. provision the staging server or equivalent isolated target
3. create and upload the staging env file
4. provision staging-specific OAuth credentials if the provider requires separate callback origins
5. provision staging-specific Telegram webhook credentials if inbound messaging is needed
6. choose and configure the staging billing mode, including provider test credentials if not using mock

### Required verification after first staging deploy

1. verify TLS certificate issuance for staging
2. verify staging login and callback flow in the browser
3. verify worker health and background startup logs
4. verify staging uses the intended DB and Redis targets, not production services
5. verify webhook endpoints and outbound alerts route to staging-specific channels only

### Required verification after production promotion

1. verify production boots with `NODE_ENV=production`
2. verify the production billing provider is not `mock` when live rollout is enabled
3. verify auth origins, webhook URLs, and public URLs still point to production domains only
4. verify no deploy script still defaults to the staging target when production is intended

### Documentation and maintenance follow-through

1. update any setup docs that still describe the current single-environment flow
2. add a short staging smoke-test runbook if the README becomes too dense
3. record the final environment matrix somewhere stable:
   - domain
   - server name
   - env file
   - billing mode
   - live trading policy
   - webhook policy
4. remove any obsolete comments or temporary notes that were only there because staging did not exist

## Risks And Mitigations

1. Risk: staging accidentally points at production DB, Redis, or webhook targets.
   Mitigation: require explicit per-environment values and verify them during smoke tests.

2. Risk: the production deploy breaks once `NODE_ENV=production` is restored.
   Mitigation: validate staging first, then satisfy the production billing and origin requirements before promotion.

3. Risk: hardcoded domains remain in one layer and cause mixed-origin or OAuth failures.
   Mitigation: grep the repo for production domains and move public-origin values behind environment-specific configuration.

4. Risk: operators keep using the old single-target deploy flow out of habit.
   Mitigation: make environment selection explicit in script interfaces and update the runbooks immediately.

## Open Questions

1. What is the staging public domain name?
2. Will staging run on a separate Hetzner server, or is there a temporary constraint that requires a shared host?
3. Should staging be strictly paper-only, or does it need limited live-trading capability?
4. Should staging billing stay on `mock`, or should it use Stripe or Creem test mode to exercise checkout and webhook behavior?
5. Does staging need real Google OAuth, or is password/email auth sufficient for the first cut?
6. Does staging need a separate Telegram bot, or can webhook-based alert testing be deferred?
7. Should deploy scripts use separate Terraform directories, workspaces, or tfvars files for environment selection?

## Recommended Answers To The Open Questions

Unless product or operations require otherwise, the safest initial answers are:

1. use a dedicated staging subdomain
2. use a separate Hetzner server
3. keep staging paper-only by default
4. use billing mock first, then move to provider test mode if checkout/webhook validation is needed
5. use real staging OAuth credentials if login-flow validation matters now
6. use a separate staging Telegram bot if inbound messaging is part of the smoke-test scope
7. use separate tfvars files or equivalent explicit environment inputs rather than hidden defaults