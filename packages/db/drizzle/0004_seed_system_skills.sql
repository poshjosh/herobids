-- Seed all 6 system skills (author_id = NULL = platform-owned).
-- ON CONFLICT DO UPDATE keeps instructions and tool lists current on re-deploy.
-- Safe on fresh DBs and existing DBs that only have the original 3 skills.

INSERT INTO "skills" (
  "id", "author_id", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "capability_families", "suggested_tick_interval_ms", "visibility", "tags",
  "created_at", "updated_at"
) VALUES
  (
    'bot-management', NULL,
    'Bot Management',
    'Create, start, stop, and monitor trading bots.',
    $$You have access to bot-management tools.

- Use `create_bot` to create a trading bot.
- Use `list_bots` to inspect existing bots.
- Use `get_bot_status` to inspect a bot's current state.
- Use `start_bot` to start a bot.
- Use `stop_bot` to stop a bot.
- Use `adjust_bot_config` to update a bot's configuration.
- Use `get_analytics` to inspect bot performance.
- Use `list_positions` to inspect open positions tied to managed bots.
- Use `send_message` to report actions, status, or issues to the user.$$,
    ARRAY['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'send_message'],
    ARRAY['bot_statuses', 'positions', 'costs'],
    ARRAY['token-budget', 'daily-loss', 'bot-limit'],
    ARRAY['trading'], 900000, 'public', ARRAY[]::text[], now(), now()
  ),
  (
    'trading', NULL,
    'Trading',
    'Submit trade decisions and inspect trading state.',
    $$You have access to trading tools.

- Use `submit_decision` to submit a trade intent for a specific instrument.
- Use `list_positions` to inspect current open positions.
- Use `get_analytics` to inspect recent trading outcomes and exposure.
- Use `check_regime` to assess current market conditions.
- Use `search_tokens` to find a token by name or symbol.
- Use `discover_tokens` to explore available trading candidates.
- Use `get_funding_rates` to inspect perpetual funding conditions.
- Use `get_market_overview` to inspect broad market state.
- Use `get_price` for focused price checks.
- Use `watch_token`, `list_watches`, `remove_watch`, and `check_watches` to maintain and inspect watch-based monitoring.$$,
    ARRAY['submit_decision', 'list_positions', 'get_analytics', 'check_regime', 'search_tokens', 'discover_tokens', 'get_funding_rates', 'get_market_overview', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
    ARRAY['positions', 'fills', 'analytics', 'costs'],
    ARRAY['token-budget', 'daily-loss'],
    ARRAY['trading'], 300000, 'public', ARRAY[]::text[], now(), now()
  ),
  (
    'risk-monitoring', NULL,
    'Risk Monitoring',
    'Watch open positions and alert the user when risk thresholds are approaching.',
    $$You have access to risk-monitoring and alerting tools.

- Use `list_positions` to inspect current open positions and exposure.
- Use `get_analytics` to inspect realized and unrealized performance context.
- Use `get_price` for focused price checks.
- Use `watch_token`, `list_watches`, `remove_watch`, and `check_watches` to maintain and inspect watch-based monitoring.
- Use `send_message` to alert the user.
- Use `publish_artifact` to publish structured monitoring outputs.$$,
    ARRAY['send_message', 'publish_artifact', 'list_positions', 'get_analytics', 'get_price', 'watch_token', 'list_watches', 'remove_watch', 'check_watches'],
    ARRAY['positions', 'fills', 'analytics'],
    ARRAY['token-budget', 'daily-loss'],
    ARRAY['trading'], 300000, 'public', ARRAY[]::text[], now(), now()
  ),
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
