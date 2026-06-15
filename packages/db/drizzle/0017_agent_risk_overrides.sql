-- Agent risk overrides — persists runtime adjustments separately from creator-configured fields.
-- Starts as NULL for all existing agents (empty override set = no change in effective limits).
ALTER TABLE "agents" ADD COLUMN "risk_overrides" jsonb;
