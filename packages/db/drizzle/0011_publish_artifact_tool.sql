-- 025: Rename artifact_publish tool/capability to publish_artifact
-- Updates persisted skill tool lists and any stored agent toolPolicy entries.

UPDATE "skills"
SET
  "required_tools" = ARRAY(
    SELECT tool
    FROM (
      SELECT tool, min(ord) AS first_ord
      FROM unnest(array_replace("required_tools", 'artifact_publish', 'publish_artifact')) WITH ORDINALITY AS t(tool, ord)
      GROUP BY tool
    ) deduped
    ORDER BY first_ord
  ),
  "updated_at" = now()
WHERE 'artifact_publish' = ANY("required_tools");

UPDATE "agents"
SET
  "tool_policy" = CASE
    WHEN "tool_policy" ? 'publish_artifact' THEN "tool_policy" - 'artifact_publish'
    ELSE ("tool_policy" - 'artifact_publish') || jsonb_build_object(
      'publish_artifact',
      CASE
        WHEN jsonb_typeof("tool_policy" -> 'artifact_publish') = 'object' THEN jsonb_set(
          "tool_policy" -> 'artifact_publish',
          '{capability}',
          to_jsonb('publish_artifact'::text),
          true
        )
        ELSE "tool_policy" -> 'artifact_publish'
      END
    )
  END,
  "updated_at" = now()
WHERE "tool_policy" ? 'artifact_publish';