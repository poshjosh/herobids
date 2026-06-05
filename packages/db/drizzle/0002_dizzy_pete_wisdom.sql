ALTER TABLE "agent_artifacts" DROP CONSTRAINT "agent_artifacts_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" DROP CONSTRAINT "agent_outbound_messages_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions" DROP CONSTRAINT "agent_runtime_sessions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_outbound_messages" ADD CONSTRAINT "agent_outbound_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_sessions" ADD CONSTRAINT "agent_runtime_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;