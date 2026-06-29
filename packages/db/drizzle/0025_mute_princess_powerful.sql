CREATE UNIQUE INDEX "uq_agent_evaluations_active_scope" ON "agent_evaluations" ("agent_id", "scope_key") WHERE "status" IN ('queued', 'running');
