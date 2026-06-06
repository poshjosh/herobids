- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-06
- **Summary:** After registration, navigating to Mission Control threw `TypeError: Cannot read properties of undefined (reading 'length')` and crashed the page.

## Root Cause

`MissionControlPage.tsx` read `overview.instances` (and `overview.summary.runningInstances` / `overview.summary.totalInstances`), but the `/dashboard/overview` API response uses `bots` and `summary.runningBots` / `summary.totalBots`. Because `overview.instances` was `undefined`, calling `.length` on it threw immediately.

The same mismatch cascaded into several other frontend components that imported a non-existent `InstanceSummary` type and used fields that don't exist on `BotSummary` or `ActivityEvent`:

| Component | Wrong field | Correct field |
|---|---|---|
| `MissionControlPage` | `overview.instances` | `overview.bots` |
| `MissionControlPage` | `summary.runningInstances` | `summary.runningBots` |
| `MissionControlPage` | `summary.totalInstances` | `summary.totalBots` |
| `AgentOverviewCard` / `HealthStrip` | `InstanceSummary` (type) | `BotSummary` |
| `AgentOverviewCard` | `instance.strategyId` | removed (not in `BotSummary`) |
| `ActivityItem` | `event.instanceLabel` | removed (not in `ActivityEvent`) |
| `InstanceDetailPage` | `journal.query({ tradingInstanceId })` | `journal.query({ actorId })` |
| `InstanceDetailPage` | `ev.tradingInstanceId` in mapping | `ev.actorId` |
| `OutcomeBoardPage` | `instance.venueLabel` | `instance.venue` |
| `router.tsx` | `InstancesPage` import (unused) | removed |

## Fix

Updated all components to use the actual field names from `DashboardOverview`, `BotSummary`, `ActivityEvent`, and `JournalEvent` as defined in `apps/web/src/lib/api-client.ts`.

## Files Changed

- `apps/web/src/features/mission-control/MissionControlPage.tsx`
- `apps/web/src/features/mission-control/AgentOverviewCard.tsx`
- `apps/web/src/features/health/HealthStrip.tsx`
- `apps/web/src/features/activity/ActivityItem.tsx`
- `apps/web/src/features/instances/detail/InstanceDetailPage.tsx`
- `apps/web/src/features/outcomes/OutcomeBoardPage.tsx`
- `apps/web/src/app/router.tsx`

## Verification

`npx tsc --noEmit` in `apps/web` returns zero errors after the fix.
