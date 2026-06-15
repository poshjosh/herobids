-- Add durable live order submission state columns (Phase 3 T1)
-- reference_price: decision-time mark for execution-quality checks
-- submission_state: live submit lifecycle phase for crash-safe recovery
-- submit_attempted_at: timestamp when venue submit was initiated
-- acknowledged_at: timestamp when venue acknowledgement was persisted
ALTER TABLE "orders" ADD COLUMN "reference_price" numeric;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "submission_state" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "submit_attempted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "acknowledged_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "idx_orders_client_order_id" ON "orders" ("client_order_id");
