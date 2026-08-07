-- Drop the FK constraint that requires billing_usage_events.session_id to
-- reference agent_runtime_sessions. Chat LLM usage events use session_id to
-- reference chat_threads instead, so this FK is too restrictive.
-- The index on session_id is preserved for query performance.
ALTER TABLE "billing_usage_events" DROP CONSTRAINT IF EXISTS "billing_usage_events_session_id_agent_runtime_sessions_id_fk";
