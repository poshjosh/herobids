# Entitlement Matrix (v1)

This note records the normalized config-driven entitlement model introduced in this feature.

## Model

Each plan now resolves through one `entitlements` block:

- `skills`
- `agents`
- `limits`

### Skills

- `canCreatePrivateSkills`
- `canViewMarketplaceSkills`
- `canPublishToMarketplace`
- `autoPublishNonDraftSkills`
- `canPriceSkills`
- `canLikeMarketplaceSkills`

### Agents

- `canViewOwnPrompts`

### Limits

- `maxAgents`
- `maxBots`
- `maxConnections`
- `maxCredentials`
- `maxBindings`
- `maxVenueAccounts`
- `maxConcurrentBacktests`
- `liveEnabled`

## Default `free` plan

| Area | Setting |
|---|---|
| Skills | private skills disabled |
| Skills | marketplace visibility enabled |
| Skills | marketplace publish enabled |
| Skills | non-draft auto-publish enabled |
| Skills | paid pricing disabled |
| Skills | likes enabled |
| Agents | own-prompt visibility enabled |
| Limits | agents=5, bots=5, connections=5, credentials=5, bindings=5, venueAccounts=5, concurrentBacktests=3, liveEnabled=false |

## Enforcement summary

- API resolves plan entitlements via one shared resolver with default-plan fallback and admin bypass.
- Skills read/write paths enforce marketplace visibility and private/public policy.
- Prompt visibility is plan-gated (`GET /agents/:id/prompt`).
- Quota guards enforce limits for agents, bots, connections, credentials, bindings, venue accounts, and concurrent backtests.
