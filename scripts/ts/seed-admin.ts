/**
 * seed-admin.ts — Seeds the first admin/operator user.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme DATABASE_URL=... tsx ts/seed-admin.ts
 *
 * Optional:
 *   ADMIN_PLAN_ID=pro   — plan to assign (defaults to 'free').
 *                          Must match a plan key in config/default.yaml.
 *
 * Both ADMIN_EMAIL and ADMIN_PASSWORD must be set; the script does not generate
 * a random password because doing so would print a credential to stdout, which
 * risks leaking it through log shipping in CI or Docker environments.
 *
 * If ADMIN_EMAIL is not set the script logs a notice and exits without error —
 * seeding is optional (non-fatal absence of credentials).
 *
 * If a user with the given email already exists the script is idempotent and exits cleanly.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createDatabase, users, localIdentities, userPlans } from '@herobids/db';
import { eq } from 'drizzle-orm';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function main() {
  const adminEmail = process.env['ADMIN_EMAIL'];
  const adminPassword = process.env['ADMIN_PASSWORD'];
  const databaseUrl = process.env['DATABASE_URL'];
  // Honour ADMIN_PLAN_ID so operators can seed with a non-default plan.
  // Defaults to 'free' to match the app's plans.defaultPlanId baseline.
  const planId = process.env['ADMIN_PLAN_ID'] ?? 'free';

  if (!adminEmail) {
    console.log('[seed-admin] ADMIN_EMAIL not set — skipping admin user seeding.');
    return;
  }

  if (!adminPassword) {
    console.error('[seed-admin] ADMIN_PASSWORD is required when ADMIN_EMAIL is set.');
    console.error('[seed-admin] Auto-generating a password is intentionally not supported to avoid logging credentials.');
    process.exit(1);
  }

  if (!databaseUrl) {
    console.error('[seed-admin] DATABASE_URL is required.');
    process.exit(1);
  }

  const password = adminPassword;

  const db = createDatabase(databaseUrl);

  // Check if user already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, adminEmail.toLowerCase().trim()))
    .limit(1);

  if (existing) {
    console.log(`[seed-admin] Admin user already exists (id=${existing.id}) — skipping.`);
    return;
  }

  const userId = crypto.randomUUID();
  const now = new Date();
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      displayName: 'Admin',
      email: adminEmail.toLowerCase().trim(),
      avatarUrl: null,
      planId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(localIdentities).values({
      id: crypto.randomUUID(),
      userId,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(userPlans).values({
      id: crypto.randomUUID(),
      userId,
      planId,
    });
  });

  console.log(`[seed-admin] Admin user created (id=${userId}, email=${adminEmail}, planId=${planId}).`);
}

main().catch((err: unknown) => {
  console.error('[seed-admin] Fatal error:', err);
  process.exit(1);
});
