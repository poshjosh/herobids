Tool args that lack discoverable schemas/values (excluded: args available in the agent prompt or obtainable via other tool calls).

**Problematic Required Args**
- **submit_decision.targetSize**: required; depends on account capital / sizing info but no tool or prompt in the audit exposes account balance or a sizing helper, so the agent cannot reliably produce this value.

**Problematic Optional Args**
- **update_own_config.technical**: expects a `TechnicalConfigSchema` but no schema or discovery tool is exposed; agent can't know valid scanner fields/values.  
- **create_bot.config.strategy.params**: strategy-specific param bag (e.g., momentum/dca/etc.) has no published schema; agent can't construct valid keys/values.  
- **adjust_bot_config.config.strategy.params**: partial-strategy updates lack schema / allowed keys.  
- **create_bot.config.execution.slippageBps**: slippage bps has no venue/default guidance or discovery endpoint; agent must guess a safe value.  
- **adjust_bot_config.config.execution.slippageBps**: same for partial updates.  
- **create_bot.config.risk**: arbitrary risk record shape is unspecified; `get_risk_limits` returns limits but not the full config schema/field names.  
- **adjust_bot_config.config.risk**: partial risk updates lack explicit schema/allowed fields.  
- **update_own_config.execution.fixedPositionSize**: format (string) and normalization rules are not exposed; agent needs capital/account context and formatting rules.  
- **publish_artifact.location**: passthrough object with no documented schema (storage/destination fields unclear).  
- **publish_artifact.metadata**: arbitrary metadata object with no schema.  
- **execute_code.dependencies**: dependency spec format (names/versions/registry rules) not documented to agent; risk of invalid requests.

Notes: excluded items include optional fields that the audit marks as known to the agent (e.g., `intelligence`, `execution.mode`) or values discoverable via tools (`botId` via `list_bots`, risk ceilings via `get_risk_limits`, file listings via `list_files`, watch/task IDs via `list_*`, token symbols via `search_tokens/discover_tokens`, etc.).