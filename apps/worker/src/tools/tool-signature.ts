/**
 * Tool signatures for messages, descriptions and docs.
 *
 * The parameter lists below are the single place the file tools' messages take their
 * signatures from. A parameter ending in `?` is optional. `tool-signature.test.ts`
 * compares each entry with the tool's real Zod schema, so a rename that is not mirrored
 * here fails the test. (A static map avoids an import cycle between the tools and the
 * message module.)
 */
export const FILE_TOOL_PARAMS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path', 'offset?', 'limit?'],
  read_file_lines: ['path', 'startLine?', 'limit?', 'maxChars?'],
  search_files: ['path?', 'query', 'regex?', 'caseInsensitive?', 'maxMatches?', 'contextLines?'],
  append_file: ['path', 'content', 'ensureNewline?'],
  edit_file: ['path', 'oldText', 'newText', 'replaceAll?'],
  write_file: ['path', 'content'],
  list_files: ['path?', 'offset?', 'limit?'],
  delete_file: ['path', 'recursive?'],
  stat_file: ['path'],
  browse_url: ['url', 'limit?'],
};

function paramName(param: string): string {
  return param.endsWith('?') ? param.slice(0, -1) : param;
}

/** Test runs fail loudly on a wrong tool or parameter; production falls back to the bare name. */
function strictMode(): boolean {
  return process.env['NODE_ENV'] === 'test';
}

/** `read_file_lines(path, startLine?, limit?, maxChars?)` */
export function toolSignature(name: string): string {
  const params = FILE_TOOL_PARAMS[name];
  if (!params) {
    if (strictMode()) throw new Error(`toolSignature: unknown tool "${name}"`);
    return name;
  }
  return `${name}(${params.join(', ')})`;
}

/**
 * A short call form naming only the parameters that matter, e.g. `search_files(path, query)`.
 * Checked against the tool's real parameters like `toolCall`.
 */
export function toolUse(name: string, ...argNames: string[]): string {
  const params = FILE_TOOL_PARAMS[name];
  if (!params) {
    if (strictMode()) throw new Error(`toolUse: unknown tool "${name}"`);
    return name;
  }
  const known = new Set(params.map(paramName));
  const unknownKey = argNames.find((key) => !known.has(key));
  if (unknownKey !== undefined) {
    if (strictMode()) throw new Error(`toolUse: "${name}" has no parameter "${unknownKey}"`);
    return name;
  }
  return `${name}(${argNames.join(', ')})`;
}

/** An example call, e.g. `read_file_lines(path: "jobs.json", startLine: 115, limit: 20)`. */
export function toolCall(name: string, args: Readonly<Record<string, string | number | boolean>>): string {
  const params = FILE_TOOL_PARAMS[name];
  if (!params) {
    if (strictMode()) throw new Error(`toolCall: unknown tool "${name}"`);
    return name;
  }
  const known = new Set(params.map(paramName));
  const unknownKey = Object.keys(args).find((key) => !known.has(key));
  if (unknownKey !== undefined) {
    if (strictMode()) throw new Error(`toolCall: "${name}" has no parameter "${unknownKey}"`);
    return name;
  }
  const rendered = Object.entries(args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `${name}(${rendered.join(', ')})`;
}

/**
 * Find signatures in free text (skill instructions, docs) that name a known tool but use
 * a parameter that tool does not have. Returns one problem string per mismatch.
 * Both forms are accepted: `tool(path, offset?)` and `tool(path: "x", offset: 5)`.
 */
export function findSignatureProblems(text: string): string[] {
  const problems: string[] = [];
  for (const [name, params] of Object.entries(FILE_TOOL_PARAMS)) {
    const known = new Set(params.map(paramName));
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${name}\\(([^)]*)\\)`, 'g');
    for (const match of text.matchAll(pattern)) {
      const inner = match[1] ?? '';
      // Template placeholders such as <path> or <n> are filled in at run time.
      const keys = splitArgs(inner).map(argKey).filter((key) => key !== '' && !key.startsWith('<'));
      for (const key of keys) {
        if (!known.has(key)) problems.push(`${name}(${inner}): unknown parameter "${key}"`);
      }
    }
  }
  return problems;
}

/** Split on commas that are outside quotes. */
function splitArgs(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function argKey(arg: string): string {
  const trimmed = arg.trim();
  const colon = trimmed.indexOf(':');
  const key = colon === -1 ? trimmed : trimmed.slice(0, colon).trim();
  return paramName(key);
}
