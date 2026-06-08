-- 022: Seed system skills (bot-management, risk-monitoring)
-- System skills have author_id = NULL (platform-owned, not user-created).
INSERT INTO "skills" (
  "id", "author_id", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "suggested_tick_interval_ms", "visibility", "tags",
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
    900000,
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
    ARRAY['send_message', 'artifact_publish'],
    ARRAY['positions', 'fills', 'analytics'],
    ARRAY['token-budget', 'daily-loss'],
    300000,
    'public',
    ARRAY[]::text[],
    now(),
    now()
  )
ON CONFLICT ("id") DO NOTHING;
