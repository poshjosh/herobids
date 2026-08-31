-- Add permission_level column to agents. Controls tool visibility and sandbox config.
-- Default is 'standard' — all existing agents are migrated to 'standard'.
ALTER TABLE "agents" ADD COLUMN "permission_level" varchar(16) DEFAULT 'standard' NOT NULL;
