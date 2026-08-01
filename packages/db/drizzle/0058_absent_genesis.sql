ALTER TABLE "blueprints" DROP CONSTRAINT "blueprints_source_blueprint_id_blueprints_id_fk";
--> statement-breakpoint
ALTER TABLE "blueprint_fork_requests" ADD CONSTRAINT "blueprint_fork_requests_fork_blueprint_id_blueprints_id_fk" FOREIGN KEY ("fork_blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_source_blueprint_id_blueprints_id_fk" FOREIGN KEY ("source_blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE restrict ON UPDATE no action;