-- 026: Rename code_execute tool/capability to execute_code and seed programming skill.
-- Updates persisted skill tool lists and any stored agent toolPolicy entries.

UPDATE "skills"
SET
  "required_tools" = ARRAY(
    SELECT tool
    FROM (
      SELECT tool, min(ord) AS first_ord
      FROM unnest(array_replace("required_tools", 'code_execute', 'execute_code')) WITH ORDINALITY AS t(tool, ord)
      GROUP BY tool
    ) deduped
    ORDER BY first_ord
  ),
  "updated_at" = now()
WHERE 'code_execute' = ANY("required_tools");

UPDATE "agents"
SET
  "tool_policy" = CASE
    WHEN "tool_policy" ? 'execute_code' THEN jsonb_set(
      "tool_policy" - 'code_execute',
      '{execute_code,capability}',
      to_jsonb('execute_code'::text),
      true
    )
    ELSE ("tool_policy" - 'code_execute') || jsonb_build_object(
      'execute_code',
      CASE
        WHEN jsonb_typeof("tool_policy" -> 'code_execute') = 'object' THEN jsonb_set(
          "tool_policy" -> 'code_execute',
          '{capability}',
          to_jsonb('execute_code'::text),
          true
        )
        ELSE "tool_policy" -> 'code_execute'
      END
    )
  END,
  "updated_at" = now()
WHERE "tool_policy" ? 'code_execute';

INSERT INTO "skills" (
  "id", "author_id", "name", "description", "instructions",
  "required_tools", "context_requirements", "required_guardrails",
  "capability_families", "suggested_tick_interval_ms", "visibility", "tags",
  "created_at", "updated_at"
) VALUES (
  'programming',
  NULL,
  'Programming',
  'Run sandboxed code for analysis, calculations, and implementation support.',
  'You can run sandboxed JavaScript for analysis, calculations, and implementation support.
Use execute_code for code execution tasks.
Use send_message to report findings or ask for clarification when needed.
Use publish_artifact when a structured output is more useful than plain text.',
  ARRAY['execute_code', 'send_message', 'publish_artifact'],
  ARRAY['costs', 'session_elapsed'],
  ARRAY['token-budget'],
  ARRAY[]::text[],
  900000,
  'public',
  ARRAY[]::text[],
  now(),
  now()
)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "instructions" = EXCLUDED."instructions",
  "required_tools" = EXCLUDED."required_tools",
  "context_requirements" = EXCLUDED."context_requirements",
  "required_guardrails" = EXCLUDED."required_guardrails",
  "capability_families" = EXCLUDED."capability_families",
  "suggested_tick_interval_ms" = EXCLUDED."suggested_tick_interval_ms",
  "visibility" = EXCLUDED."visibility",
  "updated_at" = now()
WHERE "skills"."author_id" IS NULL;