# Solution Guide/Plan

**Plan**
- 1: Add JSON Schema endpoints for ambiguous/optional args.  
- 2: Add agent-facing discovery/resolution tools that return IDs, schemas, and account context.  
- 3: Provide safe defaults/fallbacks and example payloads.  
- 4: Enforce server-side validation + dry-run/error guidance.

**High Priority**
- **Schema Endpoint**: Add `GET /api/v1/tool-schemas` and `GET /api/v1/tool-schemas?name=update_own_config` returning JSON Schema (with `$id`, `examples`, `version`) for `update_own_config.technical`, `create_bot.config.strategy.params`, `adjust_bot_config.config.strategy.params`, `update_own_config.execution.fixedPositionSize`, etc. Server must include examples and minimal valid payloads.
- **Agent Schema Tool**: Add a tool `get_schema(name:string)` that agents can call to fetch/validate a schema before constructing payloads.
- **Account / Balance Tool**: Add `get_account_summary()` returning usable capital, currencies, leverage/margin info, and settled balance — required so agents can compute `submit_decision.targetSize` and `update_own_config.execution.fixedPositionSize`.
- **Instrument Resolver**: Add `find_instrument({query, network?})` → `{instrumentId, symbol, chain, decimals, venue}` so agents do not have to guess `instrumentId`.
- **Name→ID Resolvers**: Add `resolve_bot({name})`, `resolve_watch({note|symbol})`, `resolve_task({title})` that return `botId`, `watchId`, `taskId` (used before stop/start/complete calls).
- **File Stat Tool**: Add `stat_file(path)` (exists, isDir, size, contentType) to avoid blind `read_file`/`delete_file`.
- **Server-side Validation & Helpful Errors**: All tool endpoints validate input against returned schemas and, on error, return: `schemaUri`, `missingFields`, `invalidFields`, and a minimal `exampleValidPayload`. Add `?dryRun=true` option to costly ops like `submit_decision` and `create_bot`.

**Medium Priority**
- **Strategy Param Schemas & Presets**: Publish per-strategy param schemas via `GET /api/v1/strategy-schemas?type=momentum` plus small "presets" (safe defaults) to populate `create_bot.config.strategy.params`.
- **Venue / Operator Defaults**: Expose `GET /api/v1/venue-defaults?venue=...` for `slippageBps`, fee estimates, and recommended order type. Use these to default `config.execution.slippageBps`.
- **execute_code Dependency Spec**: Publish a schema for `execute_code.dependencies` (format: `["pkg@version", ...]`) and an allowlist/policy; provide `get_schema('execute_code')`.
- **publish_artifact Schema**: Standardize `location` and `metadata` shapes (types: `s3`, `workspace`, `url`) and document required fields and access control options.

**Low Priority**
- **URL/Document Validators**: `validate_url(url)` or `head_url` to check before `browse_url`/`read_document`.
- **Artifact Storage Connectors**: helper tools `put_artifact` with typed `location` union (S3/GCS/workspace).
- **UX/Docs**: Update skill docs (e.g., `SELF_CONFIG_SKILL`) to instruct agents to call `get_schema(...)` and `get_account_summary()` before acting.

**Sensible Defaults / Fallback Rules**
- **`submit_decision.targetSize`**: if omitted, engine computes using `get_account_summary()` + `get_risk_limits()` and operator default `defaultPositionSizePct` (fallback: 1% equity, capped by `maxPositionSizePct`).
- **`config.execution.slippageBps`**: default from `venue-defaults.slippageBps`; fallback 50 bps (configurable by operator).
- **`get_price.chain` / `watch_token.chain`**: allow `"any"` but prefer `find_instrument` to resolve exact chain; if ambiguous, respond with candidates and require explicit selection.
- **`update_own_config.execution.fixedPositionSize`**: accept typed union: `{type: "currency", amount: "1000USD"}` or `{type: "percent", pct: 1.5}`; provide example via schema.
- **`execute_code.dependencies`**: require `["name@version"]` format; reject Git URLs unless allowlisted.

**Agent usage guidance (short)**
- Call `get_schema('...')` for any optional object before populating it.  
- Discover resources first: `find_instrument`, `resolve_bot`, `stat_file`.  
- Compute sizes with `get_account_summary()` + `get_risk_limits()`, or ask for confirmation if using non-default sizing.  
- Use `?dryRun=true` on `create_bot`/`submit_decision` to get validation + cost estimate.

**Implementation roadmap & priority**
- implement `tool-schemas` endpoints, `get_schema` tool, server-side validation with helpful errors, and `get_account_summary`. (High)
- `find_instrument`, name→id resolvers, `stat_file`, venue defaults. (High→Medium)
- strategy schemas & presets, publish_artifact schema, dependency spec and allowlist. (Medium)
- Followup: UI/docs updates, skill instruction updates, advanced validators. (Low)