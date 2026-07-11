# DUPLICATED CONFIG LOADING BY API AND WORKER

config.ts and config.ts are near-identical copies. When a new env var like EMAIL_FROM_EMAIL needs to wire into operator config, both must be updated — but only one was, which made the API's auth mailer silently skip email delivery. The fix is to extract loadConfig() + ENV_OVERRIDES into @herobids/domain so there's a single source of truth.

It's a legitimate DRY violation — the same ENV_OVERRIDES, loadConfig, deepMerge, coerceEnvValue, and applyEnvOverrides are duplicated in both packages. This happened because:

The API and worker grew independently as separate services, each needing config loading
The config loading logic was copied rather than extracted into a shared package
@herobids/domain owns the AppConfigSchema (Zod validation), but not the loading machinery (YAML parsing, env overrides)
The proper fix would be to extract loadConfig() and ENV_OVERRIDES into @herobids/domain (since it already owns the schema) or a new @herobids/config package, so both api and worker import from a single source. Then adding a new env var like EMAIL_FROM_EMAIL would be a one-line change instead of two.

That refactor is out of scope for this feature, but worth filing as a quick follow-up. Want me to?