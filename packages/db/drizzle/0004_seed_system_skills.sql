-- Seed the non-trading system skills (author_id = NULL = platform-owned).
-- ON CONFLICT DO UPDATE keeps instructions and tool lists current on re-deploy.
-- Phase 4 (D21/D26): the three trading skills (trading, bot-management,
-- risk-monitoring) are no longer platform skills — they are the external
-- skills.sh skills traderton/skills/crypto-* installed at agent start — so they
-- are NOT seeded here. The runtime truth is sync-system-skills at API start.

INSERT INTO "skills" (
  "id", "author_id", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "capability_families", "suggested_tick_interval_ms", "visibility", "tags",
  "created_at", "updated_at"
) VALUES
  (
    'programming', NULL,
    'Programming',
    'Run sandboxed code for analysis, calculations, and implementation support.',
    $$You have access to programming tools.

- Use `execute_code` to run sandboxed JavaScript for analysis, calculations, and implementation support.
- Use `send_message` to report findings or ask for clarification when needed.
- Use `publish_artifact` when a structured output is more useful than plain text.$$,
    ARRAY['execute_code', 'send_message', 'publish_artifact'],
    ARRAY['costs', 'session_elapsed'],
    ARRAY['token-budget'],
    ARRAY[]::text[], 900000, 'public', ARRAY[]::text[], now(), now()
  ),
  (
    'web-access', NULL,
    'Web Access',
    'Search the internet, read web pages, and fetch documents for research and information gathering.',
    $$You have access to internet research tools.

- Use `search_web(query)` to search the internet. Returns a list of results with titles, URLs, and text extracts.
- Use `browse_url(url)` to fetch and read the contents of a specific web page. Only `https://` URLs are allowed.
- Use `read_document(url)` to fetch and extract text from a document URL (e.g. PDF). Only `https://` URLs are allowed.
- Use `send_message` to share findings with the user.
- Use `publish_artifact` when findings are substantial enough to warrant a structured output.$$,
    ARRAY['search_web', 'browse_url', 'read_document', 'send_message', 'publish_artifact'],
    ARRAY['costs', 'session_elapsed'],
    ARRAY['token-budget'],
    ARRAY[]::text[], 900000, 'public', ARRAY[]::text[], now(), now()
  ),
  (
    'task-management', NULL,
    'Task Management',
    'Create, track, and complete durable tasks; schedule one-shot reminders.',
    $$You have access to task management tools.

- Use `create_task` to create a durable task with a title, optional notes, and optional due datetime.
- Use `list_tasks` to list your current tasks and their status.
- Use `complete_task` to mark a task as completed by its ID.
- Use `schedule_reminder` to schedule a one-shot reminder at a specific datetime. The reminder will wake you at the scheduled time with structured context.$$,
    ARRAY['create_task', 'list_tasks', 'complete_task', 'schedule_reminder'],
    ARRAY['costs', 'session_elapsed'],
    ARRAY['token-budget'],
    ARRAY[]::text[], 900000, 'public', ARRAY[]::text[], now(), now()
  )
ON CONFLICT ("id") DO UPDATE SET
  "name"                     = EXCLUDED."name",
  "description"              = EXCLUDED."description",
  "instructions"             = EXCLUDED."instructions",
  "required_tools"           = EXCLUDED."required_tools",
  "context_requirements"     = EXCLUDED."context_requirements",
  "required_guardrails"      = EXCLUDED."required_guardrails",
  "capability_families"      = EXCLUDED."capability_families",
  "suggested_tick_interval_ms" = EXCLUDED."suggested_tick_interval_ms",
  "visibility"               = EXCLUDED."visibility",
  "updated_at"               = now()
WHERE "skills"."author_id" IS NULL;
