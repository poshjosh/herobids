ALTER TABLE "agents" ADD COLUMN "max_open_positions" integer;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "max_position_size_pct" numeric(5, 2);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "stop_loss_pct" numeric(5, 2);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "stop_loss_cooldown_ms" integer;