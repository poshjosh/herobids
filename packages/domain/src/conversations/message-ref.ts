/** Display length of a short message id: the first 8 hex characters of the stored UUID. */
export const SHORT_MESSAGE_ID_LENGTH = 8;

const SHORT_REF_PATTERN = /^#?([0-9a-f]{8})$/i;
const FULL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The short display form of a stored message id, as `#xxxxxxxx` is shown to the model. */
export function shortMessageId(messageId: string): string {
  return messageId.slice(0, SHORT_MESSAGE_ID_LENGTH).toLowerCase();
}

/**
 * Normalises a message reference typed by the model: an 8-hex short id (optionally `#`-prefixed) or a full UUID.
 * Returns the lowercase reference, or null for anything else. Because only hex and hyphens pass, a reference can
 * never carry a LIKE wildcard into a query.
 */
export function parseMessageRef(input: string): string | null {
  const trimmed = input.trim();
  const short = SHORT_REF_PATTERN.exec(trimmed);
  if (short?.[1]) return short[1].toLowerCase();
  return isFullMessageId(trimmed) ? trimmed.toLowerCase() : null;
}

/** True for a full message id: a UUID, in any letter case. */
export function isFullMessageId(value: string): boolean {
  return FULL_ID_PATTERN.test(value);
}
