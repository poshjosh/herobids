import type { ChatAddressEntry, ChatProvider } from './api-client.js';

/** The address stored for one provider in a `chatAddresses` response, or '' when none. */
export function chatAddressFor(entries: readonly ChatAddressEntry[] | undefined, provider: ChatProvider): string {
  return entries?.find((entry) => entry.provider === provider && entry.status === 'active')?.address ?? '';
}
