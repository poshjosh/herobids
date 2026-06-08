-- 024: Upsert all system skills (bot-management, trading, risk-monitoring)
-- Replaces 0008 partial seed. Idempotent — safe to run on any existing database.
-- author_id = NULL means platform-owned. base skill is NOT stored in DB.
INSERT INTO "skills" (
  "id", "author_id", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "capability_families", "suggested_tick_interval_ms", "visibility", "tags",
  "created_at", "updated_at"
) VALUES
  (
    'bot-management',
    NULL,
    'Bot Management',
    'Create, start, stop, and monitor trading bots.',
    'You can create trading bots on behalf of the user.
When the user wants to trade, use create_bot to set up a bot with appropriate strategy and risk parameters.
Always start bots in paper mode first unless the user has explicitly requested live trading.
Never expose technical venue details (symbols like BTC-PERP) to the user — use plain language.',
    ARRAY['create_bot', 'stop_bot', 'start_bot', 'adjust_bot_config', 'list_bots', 'get_bot_status', 'get_analytics', 'list_positions', 'send_message'],
    ARRAY['bot_statuses', 'positions', 'costs'],
    ARRAY['token-budget', 'daily-loss', 'bot-limit'],
    ARRAY['trading']::text[],
    900000,
    'public',
    ARRAY[]::text[],
    now(),
    now()
  ),
  (
    'trading',
    NULL,
    'Trading',
    'Submit direct trade decisions and inspect trading state.',
    'You can submit direct trade decisions when a venue binding is ready.
Use submit_decision for specific instruments and use list_positions or get_analytics to inspect the current trading state before making new decisions.
Keep decisions aligned with the user goal and the current market context.',
    ARRAY['submit_decision', 'list_positions', 'get_analytics'],
    ARRAY['positions', 'fills', 'analytics', 'costs'],
    ARRAY['token-budget', 'daily-loss'],
    ARRAY['trading']::text[],
    300000,
    'public',
    ARRAY[]::text[],
    now(),
    now()
  ),
  (
    'risk-monitoring',
    NULL,
    'Risk Monitoring',
    'Watch open positions and alert the user when risk thresholds are approaching.',
    'Monitor open positions and P&L continuously.
Alert the user via send_message when:
- Unrealized loss exceeds 5% of allocated capital
- A position has been open longer than the user''s stated time horizon
- Market volatility spikes significantly',
    ARRAY['send_message', 'artifact_publish', 'list_positions', 'get_analytics'],
    ARRAY['positions', 'fills', 'analytics'],
    ARRAY['token-budget', 'daily-loss'],
    ARRAY['trading']::text[],
    300000,
    'public',
    ARRAY[]::text[],
    now(),
    now()
  )
ON CONFLICT ("id") DO UPDATE SET
  "name"                       = EXCLUDED."name",
  "description"                = EXCLUDED."description",
  "instructions"               = EXCLUDED."instructions",
  "required_tools"             = EXCLUDED."required_tools",
  "context_requirements"       = EXCLUDED."context_requirements",
  "required_guardrails"        = EXCLUDED."required_guardrails",
  "capability_families"        = EXCLUDED."capability_families",
  "suggested_tick_interval_ms" = EXCLUDED."suggested_tick_interval_ms",
  "visibility"                 = EXCLUDED."visibility",
  "updated_at"                 = now()
WHERE "skills"."author_id" IS NULL;
