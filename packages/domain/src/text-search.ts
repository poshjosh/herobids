/**
 * Shared text-search primitives for agent-facing search tools.
 *
 * These functions handle query tokenization, stopword removal, and
 * lightweight English stemming. They are backend-agnostic — consumers
 * decide whether to run them against an in-memory index (platform docs)
 * or build SQL clauses from the resulting tokens (skill search).
 *
 * The external skills.sh subprocess tokenizer in tools/skills.ts is
 * intentionally separate — it builds CLI argv, not search queries.
 */

// ── Stopwords ───────────────────────────────────────────────────────────────

/**
 * Common English function words removed during tokenization.
 * Prevents noise when LLM agents send natural-language queries
 * like "what is the best trading strategy".
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'the', 'a', 'an',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'and', 'or', 'not', 'but', 'if', 'so', 'no',
  'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'he', 'she', 'they',
  'what', 'how', 'why', 'when', 'where', 'which', 'who',
  'can', 'will', 'would', 'could', 'should', 'may', 'do', 'does',
  'has', 'have', 'had', 'get', 'got',
  'me', 'my', 'our', 'your', 'us',
  'just', 'only', 'also', 'very', 'too',
]);

// ── Tokenization ────────────────────────────────────────────────────────────

const MIN_TOKEN_LENGTH = 2;

/**
 * Split a query string into individual search tokens.
 *
 * - Lowercases the input.
 * - Splits on non-alphanumeric boundaries.
 * - Drops tokens shorter than 2 characters.
 * - Removes common English stopwords.
 *
 * Each token is matched independently, so "crypto exchange venue"
 * yields `['crypto', 'exchange', 'venue']`.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
    .filter((t) => !STOPWORDS.has(t));
}

// ── Stemming ────────────────────────────────────────────────────────────────

/**
 * Lightweight English stemming — strips common suffixes so that
 * "venues" ↔ "venue", "trading" ↔ "trade", "configuration" ↔ "configure".
 *
 * No external deps. Sufficient for small catalogs (skills, docs).
 */
export function stem(word: string): string {
  return word
    .replace(/(ies|ied)$/, 'y')                 // "strategies" → "strategy"
    .replace(/(sses|shes|ches|xes|zzes)$/, (m) => m.slice(0, -2)) // "watches" → "watch"
    .replace(/(ss|sh|ch|x|zz)es$/, '$1')        // "bosses" → "boss" (keep ending)
    .replace(/ses$/, 's')                        // "houses" → "hous" (close enough)
    .replace(/s$/, '')                           // "venues" → "venue"
    .replace(/(ing|ed)$/, '')                    // "trading" → "trad", "configured" → "configur"
    .replace(/(ation|ition)$/, 'e')              // "configuration" → "configure"
    .replace(/(ement|ness|able|ible)$/, '');     // "payment" → "pay"
}

// ── Token expansion ─────────────────────────────────────────────────────────

const MIN_STEM_LENGTH = 3;

/**
 * Expand a token into all its matchable forms: the original token
 * and (if the stem is distinct and non-trivial) its stem.
 *
 * Stems shorter than 3 characters are dropped to avoid noise:
 * "is" → "i" would match nearly every document.
 */
export function expandToken(token: string): string[] {
  const forms = [token];
  const s = stem(token);
  if (s !== token && s.length >= MIN_STEM_LENGTH) {
    forms.push(s);
  }
  return forms;
}
