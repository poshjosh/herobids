-- Add claimed_at column to alert_deliveries.
ALTER TABLE "alert_deliveries" ADD COLUMN "claimed_at" timestamp with time zone;

-- Add uniqueness constraint for idempotent delivery (one delivery per event+channel+destination).
CREATE UNIQUE INDEX "uq_alert_deliveries_event_channel_dest" ON "alert_deliveries" ("journal_event_id", "channel", "destination");
