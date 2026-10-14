import { and, eq } from 'drizzle-orm';
import { agents, type Database } from '@herobids/db';
import { generateAgentNameCandidate } from '@herobids/domain';
import { randomBytes } from 'node:crypto';

const MAX_CANDIDATE_ATTEMPTS = 10;

/** Pick an `adjective-noun` name that no agent of this user already has. */
export async function allocateAgentName(db: Database, userId: string, random: () => number = Math.random): Promise<string> {
  for (let attempt = 0; attempt < MAX_CANDIDATE_ATTEMPTS; attempt++) {
    const candidate = generateAgentNameCandidate(random);
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.name, candidate)))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${generateAgentNameCandidate(random)}-${randomBytes(2).toString('hex')}`;
}
