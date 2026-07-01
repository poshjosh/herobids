-- ============================================================================
-- Migrate existing blueprint and bot configs from USD-denominated fields to
-- percentage-of-equity sizing.
--
-- This migration is idempotent — safe to run multiple times.
--
-- Phase 0's resolvePositionSize() still handles 'fixed' mode for any
-- un-migrated configs, so there is no runtime breakage during migration.
--
-- Naming note: legacy risk fields used "Percent" (e.g. stopLossPercent),
-- while the canonical strategy.params fields use "Pct" (e.g. stopLossPct).
-- Both refer to the same concept; the migration unifies on "Pct".
-- ============================================================================

BEGIN;

-- ============================================================================
-- Blueprints (blueprints.config_data)
-- ============================================================================

-- Step 1: Strip dead risk.* fields that duplicate strategy.params fields
--   - risk.stopLossPercent  → redundant (strategy.params.stopLossPct is canonical)
--   - risk.takeProfitPercent → redundant (strategy.params.takeProfitPct is canonical)
--   - risk.maxPositionSize   → USD value, replaced by risk.maxPositionSizePct
--   - risk.maxTotalPosition  → removed (not part of the new percent-based model)
UPDATE blueprints
SET config_data = config_data
  #- '{risk,stopLossPercent}'
  #- '{risk,takeProfitPercent}'
  #- '{risk,maxPositionSize}'
  #- '{risk,maxTotalPosition}'
WHERE config_data->'risk'->>'stopLossPercent' IS NOT NULL
   OR config_data->'risk'->>'takeProfitPercent' IS NOT NULL
   OR config_data->'risk'->>'maxPositionSize' IS NOT NULL
   OR config_data->'risk'->>'maxTotalPosition' IS NOT NULL;

-- Step 2: Convert positionSizeMode from 'fixed' to 'percent_equity' and
-- set safe default positionSize to '5' (5% of equity) atomically.
-- Only targets rows with mode='fixed' so pre-existing percent_equity
-- configs are never overwritten.
UPDATE blueprints
SET config_data = jsonb_set(
  jsonb_set(
    config_data,
    '{strategy,params,positionSizeMode}',
    '"percent_equity"',
    true
  ),
  '{strategy,params,positionSize}',
  '"5"',
  true
)
WHERE config_data->'strategy'->'params'->>'positionSizeMode' = 'fixed';

-- Step 3: Add maxPositionSizePct default (20% — standard tier) where the
-- risk block exists but has no maxPositionSizePct. This is a safe ceiling
-- that prevents any single position from exceeding 20% of account equity.
UPDATE blueprints
SET config_data = jsonb_set(
  config_data,
  '{risk,maxPositionSizePct}',
  '20'::jsonb,
  true
)
WHERE config_data->'risk'->>'maxPositionSizePct' IS NULL
  AND config_data->'risk' IS NOT NULL;

-- ============================================================================
-- Bots (bots.config and bots.config_snapshot)
-- ============================================================================

-- Step 4: Strip dead risk.* fields from bots.config
UPDATE bots
SET config = config
  #- '{risk,stopLossPercent}'
  #- '{risk,takeProfitPercent}'
  #- '{risk,maxPositionSize}'
  #- '{risk,maxTotalPosition}'
WHERE config->'risk'->>'stopLossPercent' IS NOT NULL
   OR config->'risk'->>'takeProfitPercent' IS NOT NULL
   OR config->'risk'->>'maxPositionSize' IS NOT NULL
   OR config->'risk'->>'maxTotalPosition' IS NOT NULL;

-- Step 5: Convert bot configs from fixed to percent_equity
UPDATE bots
SET config = jsonb_set(
  jsonb_set(
    config,
    '{strategy,params,positionSizeMode}',
    '"percent_equity"',
    true
  ),
  '{strategy,params,positionSize}',
  '"5"',
  true
)
WHERE config->'strategy'->'params'->>'positionSizeMode' = 'fixed';

-- Step 6: Add maxPositionSizePct to bot configs where missing
UPDATE bots
SET config = jsonb_set(
  config,
  '{risk,maxPositionSizePct}',
  '20'::jsonb,
  true
)
WHERE config->'risk'->>'maxPositionSizePct' IS NULL
  AND config->'risk' IS NOT NULL;

-- Step 7: Same operations on bots.config_snapshot
UPDATE bots
SET config_snapshot = config_snapshot
  #- '{risk,stopLossPercent}'
  #- '{risk,takeProfitPercent}'
  #- '{risk,maxPositionSize}'
  #- '{risk,maxTotalPosition}'
WHERE config_snapshot->'risk'->>'stopLossPercent' IS NOT NULL
   OR config_snapshot->'risk'->>'takeProfitPercent' IS NOT NULL
   OR config_snapshot->'risk'->>'maxPositionSize' IS NOT NULL
   OR config_snapshot->'risk'->>'maxTotalPosition' IS NOT NULL;

UPDATE bots
SET config_snapshot = jsonb_set(
  jsonb_set(
    config_snapshot,
    '{strategy,params,positionSizeMode}',
    '"percent_equity"',
    true
  ),
  '{strategy,params,positionSize}',
  '"5"',
  true
)
WHERE config_snapshot->'strategy'->'params'->>'positionSizeMode' = 'fixed';

UPDATE bots
SET config_snapshot = jsonb_set(
  config_snapshot,
  '{risk,maxPositionSizePct}',
  '20'::jsonb,
  true
)
WHERE config_snapshot->'risk'->>'maxPositionSizePct' IS NULL
  AND config_snapshot->'risk' IS NOT NULL;

COMMIT;
