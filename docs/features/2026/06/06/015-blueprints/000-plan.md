# 015 — Blueprints System

## Status
`done`

## Goal
Build the `blueprints` table and CRUD API that the domain model specifies. Migrate `bots.config` to reference blueprints. This is the largest structural gap.

## Context

The domain model (`docs/tech/domain-language.md`) defines a `Blueprint` as a first-class concept separate from a `Bot`. The current codebase embeds config directly in `bots.config` JSONB — a temporary shortcut. This feature builds what the model describes.

## Scope

### Schema changes

1. New `blueprints` table:
   - `id`, `userId`, `name`, `description`, `configData` (JSONB), `configVersion` (int, default 1), `visibility` (`private` | `public`), `strategyPreset` (nullable), `createdAt`, `updatedAt`
2. `bots` table:
   - Add `blueprintId` FK → `blueprints.id` (nullable during migration)
   - Add `configSnapshot` JSONB (snapshot of blueprint config at bot start time, for audit)
   - Keep `bots.config` during migration; deprecate after all bots migrated

### New API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/blueprints` | List user's blueprints |
| `POST` | `/blueprints` | Create blueprint. Body: `{ name, configData, description?, strategyPreset? }` |
| `GET` | `/blueprints/presets` | List available strategy presets |
| `GET` | `/blueprints/defaults` | Default strategy/execution values |
| `POST` | `/blueprints/from-preset` | Build blueprint from preset. Body: `{ preset, overrides? }` |
| `GET` | `/blueprints/:id` | Get blueprint |
| `PUT` | `/blueprints/:id` | Update blueprint (increments `configVersion`) |
| `DELETE` | `/blueprints/:id` | Delete blueprint (blocked if referenced by running bot) |
| `POST` | `/blueprints/:id/clone` | Clone blueprint |
| `POST` | `/blueprints/:id/publish` | Set visibility to `public` |
| `POST` | `/blueprints/:id/unpublish` | Set visibility to `private` |

### Bot creation change

`POST /bots` body changes from `{ config: {...} }` to accept either:
- `{ blueprintId: "..." }` — reference an existing blueprint
- `{ blueprintId: "...", configOverrides: {...} }` — reference + override (snapshot stored on bot)

The old `config` field is accepted during transition with a deprecation header.

### Available strategy presets

Mirror aitradingbot presets: `momentum`, `dca`, `range`, `swing`, `scalper`, `contrarian`.
Presets are static configuration templates — no DB table required for v1.

## Acceptance criteria

- [ ] Drizzle migration creates `blueprints` table and adds `blueprintId` + `configSnapshot` to `bots`
- [ ] All 11 blueprint endpoints return correct responses
- [ ] `POST /bots` accepts `blueprintId` reference
- [ ] Deleting a blueprint referenced by a running bot returns 409
- [ ] Blueprint `configVersion` increments on each `PUT`
- [ ] Ownership checks: user cannot read/edit another user's private blueprint
- [ ] Public blueprints are readable without auth (or by any authenticated user — decide at implementation time)
- [ ] Integration tests cover all endpoints and the bot-creation change
- [ ] `pnpm lint` passes

## Frontend scope (tracked in 020-frontend)

- Blueprints page with 3-tab creation wizard (From Existing / From Defaults / Custom)
- Blueprint edit page with JSON/YAML toggle and "Apply preset" dropdown
- Preset cards grid
- Bot creation wizard updated to use blueprint reference
