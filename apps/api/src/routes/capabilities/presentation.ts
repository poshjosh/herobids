/**
 * Capability-presentation contract — the generic (capability-agnostic) response
 * shape the web renders WITHOUT any trading semantics. Emphasis is computed
 * server-side so the web only maps `emphasis` → theme tokens.
 *
 * Traderton boundary stays the source of the trading values; this module owns
 * only the wire types (no trading logic).
 */

export type CapabilityPresentationEmphasis = 'neutral' | 'positive' | 'negative' | 'warning';

export type CapabilityAttribute = {
  key: string;
  label: string;
  value: string;
  emphasis?: CapabilityPresentationEmphasis;
};

export type CapabilityFeedItem = {
  id: string;
  title: string;
  detail?: string;
  occurredAt: string;
  emphasis?: CapabilityPresentationEmphasis;
};

export type CapabilityFeed = {
  key: string;
  label: string;
  items: CapabilityFeedItem[];
  /** Full cursor pagination is future work — omitted for the first cut. */
  nextCursor?: string;
};

export type CapabilityConnection = {
  id: string;
  label: string;
  // `'unavailable'` is reserved for future use — the endpoint emits `connection: null` today when no usable binding exists.
  state: 'ready' | 'unavailable';
};

export type CapabilityPresentation = {
  family: string;
  connection: CapabilityConnection | null;
  attributes: CapabilityAttribute[];
  feeds: CapabilityFeed[];
};