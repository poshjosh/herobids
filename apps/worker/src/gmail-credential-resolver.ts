import type { Database } from '@herobids/db';
import { connections, userCredentials, agentConnections, providers } from '@herobids/db';
import { eq, and, sql } from 'drizzle-orm';
import { decryptCredential, encryptCredential } from './crypto.js';
import { ok, err, type Result } from '@herobids/domain';
import type { AppConfig } from '@herobids/domain';

export interface GmailTokenResult {
  accessToken: string;
  email: string;
  credentialId: string;
}

export interface GmailTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scope: string;
  token_type: string;
  email: string;
}

export interface GmailCredentialError {
  code: string;
  message: string;
}

export async function resolveGmailTokens(
  db: Database,
  agentId: string,
  gmailConfig: AppConfig['integrations']['gmail'],
): Promise<Result<GmailTokenResult, GmailCredentialError>> {
  const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (!encryptionKey) {
    return err({ code: 'gmail.no_encryption_key', message: 'CREDENTIAL_ENCRYPTION_KEY not set' });
  }

  // TODO: Replace with resolveDefaultFamilyConnectionId(db, agentId, 'email') once implemented.
  // Currently picks the oldest assigned email connection as default. No Gmail-specific
  // "first row wins" rule — deterministic ordering via createdAt.
  const [row] = await db
    .select({
      credentialId: connections.credentialId,
      connectionId: connections.id,
      email: sql<string>`${connections.profile} ->> 'email'`,
      encryptedData: userCredentials.encryptedData,
    })
    .from(agentConnections)
    .innerJoin(connections, eq(connections.id, agentConnections.connectionId))
    .innerJoin(providers, eq(providers.id, connections.provider))
    .innerJoin(userCredentials, eq(userCredentials.id, connections.credentialId))
    .where(
      and(
        eq(agentConnections.agentId, agentId),
        eq(agentConnections.status, 'active'),
        eq(connections.status, 'active'),
        sql`${providers.capabilities} @> '["email"]'`,
      ),
    )
    .orderBy(agentConnections.createdAt)
    .limit(1);

  if (!row || !row.credentialId || !row.encryptedData) {
    return err({ code: 'connection.missing', message: 'No email connection is assigned to this agent.' });
  }

  // Decrypt tokens
  let tokens: GmailTokens;
  try {
    tokens = JSON.parse(decryptCredential(row.encryptedData, encryptionKey)) as GmailTokens;
  } catch {
    return err({ code: 'gmail.decrypt_failed', message: 'Failed to decrypt Gmail credentials.' });
  }

  // Check if access token is near expiry (5 min buffer)
  if (Date.now() < tokens.expiry_date - 5 * 60 * 1000) {
    return ok({ accessToken: tokens.access_token, email: tokens.email, credentialId: row.credentialId });
  }

  // Refresh the access token
  if (!gmailConfig.clientId || !gmailConfig.clientSecret) {
    return err({ code: 'gmail.not_configured', message: 'Gmail integration not configured.' });
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: gmailConfig.clientId,
      client_secret: gmailConfig.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    if ((errBody as { error?: string }).error === 'invalid_grant') {
      return err({
        code: 'gmail.token_refresh_failed',
        message: 'Gmail connection needs re-authorization. Please reconnect your Gmail account.',
      });
    }
    return err({ code: 'gmail.token_refresh_failed', message: `Token refresh failed: ${JSON.stringify(errBody)}` });
  }

  const fresh = (await res.json()) as { access_token: string; expires_in: number };
  const newTokens: GmailTokens = {
    ...tokens,
    access_token: fresh.access_token,
    expiry_date: Date.now() + fresh.expires_in * 1000,
  };

  // Re-encrypt and update DB
  const { encryptedData, encryptionMeta } = encryptCredential(JSON.stringify(newTokens), encryptionKey);
  await db
    .update(userCredentials)
    .set({ encryptedData, encryptionMeta: encryptionMeta as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(userCredentials.id, row.credentialId));

  return ok({ accessToken: fresh.access_token, email: tokens.email, credentialId: row.credentialId });
}
