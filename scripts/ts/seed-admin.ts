/**
 * seed-admin.ts — Seeds the first admin/operator user.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme DATABASE_URL=... tsx ts/seed-admin.ts
 *
 * Both ADMIN_EMAIL and ADMIN_PASSWORD must be set; the script does not generate
 * a random password because doing so would print a credential to stdout, which
 * risks leaking it through log shipping in CI or Docker environments.
 *
 * If ADMIN_EMAIL is not set the script logs a notice and exits without error —
 * seeding is optional (non-fatal absence of credentials).
 *
 * If a user with the given email already exists the script is idempotent and exits cleanly.
 *
 * The seeded user is created with is_admin = true. Admin users bypass all plan limits.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createDatabase, closeDatabase, users, localIdentities, userPlans } from '@herobids/db';
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
  const planId = 'free';

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
  try {
  const normalizedEmail = adminEmail.toLowerCase().trim();
  const now = new Date();
  const passwordHash = await hashPassword(password);

  // Derive username and displayName from the admin email, consistent with
  // the auth route user-creation paths.
  const username = normalizedEmail.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const displayName = username
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  const userId = existing?.id ?? crypto.randomUUID();

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(users)
        .set({ isAdmin: true, updatedAt: now })
        .where(eq(users.id, userId));
    } else {
      await tx.insert(users).values({
        id: userId,
        username,
        displayName,
        email: normalizedEmail,
        avatarUrl: null,
        planId,
        isAdmin: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [existingPlanHistory] = await tx
      .select({ id: userPlans.id })
      .from(userPlans)
      .where(eq(userPlans.userId, userId))
      .limit(1);

    await tx.insert(localIdentities).values({
      id: crypto.randomUUID(),
      userId,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: localIdentities.userId,
      set: { passwordHash, updatedAt: now },
    });

    if (!existingPlanHistory) {
      await tx.insert(userPlans).values({
        id: crypto.randomUUID(),
        userId,
        planId,
      });
    }
  });

  console.log(existing
    ? `[seed-admin] Admin user promoted (id=${userId}, email=${normalizedEmail}, isAdmin=true).`
    : `[seed-admin] Admin user created (id=${userId}, email=${normalizedEmail}, isAdmin=true).`);
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error('[seed-admin] Fatal error:', err);
  process.exit(1);
});
