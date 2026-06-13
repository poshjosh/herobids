/**
 * upsert-system-skills.ts — Upserts the built-in system skills into Postgres.
 *
 * Usage:
 *   pnpm --filter @herobids/scripts upsert-system-skills
 *
 * By default the script targets the local Docker Postgres instance exposed on
 * localhost:5432. Override DATABASE_URL to point at a different database.
 */

import { SYSTEM_SKILLS } from '@herobids/domain';
import { createDatabase, closeDatabase, skills as skillsTable } from '@herobids/db';

const DEFAULT_DATABASE_URL = 'postgres://herobids:herobids@localhost:5432/herobids';

async function main() {
  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const db = createDatabase(databaseUrl);
  try {
  const now = new Date();

  for (const skill of SYSTEM_SKILLS) {
    await db
      .insert(skillsTable)
      .values({
        id: skill.id,
        authorId: null,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        requiredTools: skill.requiredTools,
        contextRequirements: skill.contextRequirements,
        requiredGuardrails: skill.requiredGuardrails,
        capabilityFamilies: skill.capabilityFamilies,
        suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
        visibility: skill.visibility,
        tags: [],
      })
      .onConflictDoUpdate({
        target: skillsTable.id,
        set: {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          requiredTools: skill.requiredTools,
          contextRequirements: skill.contextRequirements,
          requiredGuardrails: skill.requiredGuardrails,
          capabilityFamilies: skill.capabilityFamilies,
          suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
          visibility: skill.visibility,
          updatedAt: now,
        },
      });
  }

  console.log(`[upsert-system-skills] Synced ${SYSTEM_SKILLS.length} built-in skills.`);
  } finally {
    await closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error('[upsert-system-skills] Fatal error:', error);
  process.exit(1);
});