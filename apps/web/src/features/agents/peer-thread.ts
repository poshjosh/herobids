import type { PeerMessage } from '../../lib/api-client.js';

export type PeerMessageSide = 'self' | 'peer';

const REFUSAL_REASON_KEYS = new Map<string, string>([
  ['peer.paused', 'agentDetail.peerThreads.refusal.paused'],
  ['peer.rate_limited', 'agentDetail.peerThreads.refusal.rateLimited'],
  ['peer.recipient_not_running', 'agentDetail.peerThreads.refusal.recipientNotRunning'],
  ['peer.unavailable', 'agentDetail.peerThreads.refusal.unavailable'],
]);

export const GENERIC_REFUSAL_KEY = 'agentDetail.peerThreads.refusal.generic';

/** The viewed agent's own messages are `self`; anything else in the thread came from the peer. */
export function peerMessageSide(message: Pick<PeerMessage, 'senderId'>, agentId: string): PeerMessageSide {
  return message.senderId === agentId ? 'self' : 'peer';
}

/** The i18n key explaining a refusal; unknown or missing codes fall back to the generic one. */
export function refusalReasonKey(code: string | null): string {
  return (code !== null ? REFUSAL_REASON_KEYS.get(code) : undefined) ?? GENERIC_REFUSAL_KEY;
}

/** Union by id (later lists win), oldest first, ties broken by id: the order the server pages in. */
export function mergePeerMessages(...lists: PeerMessage[][]): PeerMessage[] {
  const byId = new Map<string, PeerMessage>();
  for (const list of lists) {
    for (const message of list) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => (
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.createdAt < b.createdAt ? -1 : 1)
  ));
}
