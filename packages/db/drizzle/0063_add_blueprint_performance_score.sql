ALTER TABLE "blueprints" ADD COLUMN "performance_score" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_blueprints_performance" ON "blueprints" USING btree ("performance_score");

