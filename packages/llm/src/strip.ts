/**
 * Remove keys whose value is null, undefined, or empty string from a flat
 * LLM output object before passing it to a Zod schema for validation.
 *
 * This handles the common LLM failure mode where optional fields are emitted
 * as null/"" instead of being omitted entirely.
 *
 * Note: 0 and false are intentionally preserved — they are valid field values
 * for numeric and boolean fields.
 */
export function stripEmptyValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== '') {
      out[k] = v;
    }
  }
  return out;
}
