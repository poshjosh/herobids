-- 004: Stamp capabilityMode and hybridMode on existing unified_config JSONB blobs.
-- Hybrid agents (those with technical config) → capabilityMode='hybrid', hybridMode='mixed'.
-- Intelligence agents (no technical config) → capabilityMode='intelligence'.
-- Idempotent: only updates rows where capabilityMode is not already present.

UPDATE agents
SET unified_config = unified_config || '{"capabilityMode": "hybrid", "hybridMode": "mixed"}'::jsonb
WHERE unified_config IS NOT NULL
  AND unified_config ? 'technical'
  AND NOT (unified_config ? 'capabilityMode');--> statement-breakpoint

UPDATE agents
SET unified_config = (unified_config - 'hybridMode') || '{"capabilityMode": "intelligence"}'::jsonb
WHERE unified_config IS NOT NULL
  AND NOT (unified_config ? 'technical')
  AND NOT (unified_config ? 'capabilityMode');
