import { z } from 'zod';
import { CHAT_PROVIDERS } from '@herobids/domain';
import {
  isChatAddressClaimedByOtherUser,
  listChatAddressesForOutput,
  setChatAddress,
  type ChatAddressOutput,
  type ChatAddressScope,
  type Database,
} from '@herobids/db';

/** One entry of a `chatAddresses` request body. A null address clears the scope's address for that provider. */
export const ChatAddressInputSchema = z.object({
  provider: z.enum(CHAT_PROVIDERS),
  address: z.string().max(64).nullable(),
});

export const ChatAddressesInputSchema = z.array(ChatAddressInputSchema)
  .max(CHAT_PROVIDERS.length)
  .refine((entries) => new Set(entries.map((entry) => entry.provider)).size === entries.length, {
    message: 'chatAddresses must list each provider at most once',
  });

export type ChatAddressesInput = z.infer<typeof ChatAddressesInputSchema>;

/** A Telegram chat is already bound to another user's account. The write transaction rolls back. */
export class ChatAddressInUseError extends Error {
  readonly code = 'chat_address.in_use';

  constructor() {
    super('This Telegram account is already connected to another OpenAIdom account.');
    this.name = 'ChatAddressInUseError';
  }
}

/**
 * Applies each entry to one scope. Run it inside the write transaction. A telegram address owned by another user
 * throws ChatAddressInUseError before anything is written for that entry; the transaction then rolls back.
 */
export async function applyChatAddresses(
  executor: Pick<Database, 'insert' | 'delete' | 'select' | 'execute'>,
  scope: ChatAddressScope,
  entries: ChatAddressesInput,
): Promise<void> {
  for (const entry of entries) {
    if (
      entry.provider === 'telegram'
      && entry.address !== null
      && entry.address.trim() !== ''
      && await isChatAddressClaimedByOtherUser(executor, 'telegram', entry.address, scope.userId)
    ) {
      throw new ChatAddressInUseError();
    }
    await setChatAddress(executor, scope, entry.provider, entry.address);
  }
}

/** Adds `chatAddresses` (the agent's own rows) to each agent object, using one query for the whole list. */
export async function withAgentChatAddresses<T extends { id: string }>(
  db: Pick<Database, 'select'>,
  userId: string,
  agentObjects: readonly T[],
): Promise<Array<T & { chatAddresses: ChatAddressOutput[] }>> {
  const { byAgent } = await listChatAddressesForOutput(db, userId, agentObjects.map((agent) => agent.id));
  return agentObjects.map((agent) => ({ ...agent, chatAddresses: byAgent.get(agent.id) ?? [] }));
}

/** The user-level chat addresses of one user, for `GET /auth/me` and `PATCH /auth/me` responses. */
export async function listUserChatAddresses(db: Pick<Database, 'select'>, userId: string): Promise<ChatAddressOutput[]> {
  const { user } = await listChatAddressesForOutput(db, userId, []);
  return user;
}

/** Copies output rows into request-body form for another scope (active rows only). */
export function chatAddressesToInput(rows: readonly ChatAddressOutput[]): ChatAddressesInput {
  return rows
    .filter((row) => row.status === 'active')
    .map((row) => ({ provider: row.provider, address: row.address }));
}
