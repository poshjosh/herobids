ALTER TABLE "market_assessment_requests" DROP CONSTRAINT "market_assessment_requests_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "market_assessment_requests" ADD CONSTRAINT "market_assessment_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
