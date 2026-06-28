// ── Secret patterns (same as security analyzer) ─────────────────────────────

const SECRET_REGEXES: RegExp[] = [
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

const REDACTED_PLACEHOLDER = '[REDACTED]';

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Redact sensitive data from a string.
 * Strips known secret patterns and replaces them with `[REDACTED]`.
 */
export function redact(text: string): string {
  let result = text;
  for (const regex of SECRET_REGEXES) {
    result = result.replace(regex, REDACTED_PLACEHOLDER);
  }
  return result;
}

/**
 * Redact sensitive data from a JSON-serializable value (deep, non-mutating).
 */
export function redactJson(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJson(v);
    }
    return out;
  }
  return value;
}
