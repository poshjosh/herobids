import { createHash, randomBytes } from 'node:crypto';

/** Prefix marks an agent runtime key so the API never tries to parse it as a JWT. */
export const AGENT_API_KEY_PREFIX = 'agk_';
const AGENT_API_KEY_RANDOM_BYTES = 32;

export interface GeneratedAgentApiKey {
  /** Raw key — handed to the agent container only, never persisted. */
  rawKey: string;
  /** SHA-256 hex digest — the only form persisted on the runtime session. */
  keyHash: string;
}

export function generateAgentApiKey(): GeneratedAgentApiKey {
  const rawKey = `${AGENT_API_KEY_PREFIX}${randomBytes(AGENT_API_KEY_RANDOM_BYTES).toString('base64url')}`;
  return { rawKey, keyHash: hashAgentApiKey(rawKey) };
}

export function hashAgentApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function isAgentApiKey(token: string): boolean {
  return token.startsWith(AGENT_API_KEY_PREFIX);
}
