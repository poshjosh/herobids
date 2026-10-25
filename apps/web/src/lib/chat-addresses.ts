import type { ChatAddressEntry, ChatAddressInput, ChatProvider } from './api-client.js';

/** The address stored for one provider in a `chatAddresses` response, or '' when none. */
export function chatAddressFor(entries: readonly ChatAddressEntry[] | undefined, provider: ChatProvider): string {
  return entries?.find((entry) => entry.provider === provider && entry.status === 'active')?.address ?? '';
}

/** Request body entry that sets (non-blank) or clears (blank) one provider's address. */
export function chatAddressInput(provider: ChatProvider, address: string): ChatAddressInput {
  return { provider, address: address.trim() || null };
}
