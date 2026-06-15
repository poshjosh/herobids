export interface TelegramCommandParseResult {
  targets: string[];
  body: string;
}

type Token = {
  value: string;
  quoted: boolean;
  start: number;
  end: number;
};

const COMMAND_PREFIX = /^\/to(?:@[^\s]+)?\b/i;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) {
      index += 1;
    }

    if (index >= input.length) {
      break;
    }

    const start = index;
    const quote = input[index];
    if (quote === '"' || quote === '\'') {
      index += 1;
      let value = '';
      while (index < input.length && input[index] !== quote) {
        value += input[index];
        index += 1;
      }
      if (index < input.length && input[index] === quote) {
        index += 1;
      }
      tokens.push({ value, quoted: true, start, end: index });
      continue;
    }

    let value = '';
    while (index < input.length && !/\s/.test(input[index]!)) {
      value += input[index];
      index += 1;
    }
    tokens.push({ value, quoted: false, start, end: index });
  }

  return tokens;
}

function isReservedTarget(token: string): boolean {
  return token === '*' || token.toLowerCase() === 'all';
}

/**
 * Parse a Telegram `/to` command into targets and body.
 *
 * Target extraction rules (pure-syntax, no agent-name lookup required):
 * - A quoted token in the leading position is always a target.
 * - A reserved token (`*` / `all`) in the leading position is always a target.
 * - The first bare (unquoted, non-reserved) token is always a target.
 * - After the first bare token, bare tokens stop being targets (body starts).
 * - Quoted or reserved tokens that immediately follow other targets continue
 *   expanding the target list.
 *
 * Callers are responsible for resolving targets against actual agent names and
 * producing user-facing "not found" responses.
 */
export function parseTelegramCommand(text: string): TelegramCommandParseResult | null {
  const trimmed = text.trim();
  const prefixMatch = trimmed.match(COMMAND_PREFIX);
  if (!prefixMatch) {
    return null;
  }

  const remainder = trimmed.slice(prefixMatch[0].length).trimStart();
  if (remainder.length === 0) {
    return { targets: [], body: '' };
  }

  const tokens = tokenize(remainder);
  const targets: string[] = [];
  let bodyStart = 0;

  for (const token of tokens) {
    if (token.quoted || isReservedTarget(token.value)) {
      targets.push(token.value.trim());
      bodyStart = token.end;
      continue;
    }

    // Bare token: the first token when no targets have been collected yet is
    // always a target (enables unknown-name routing at the call site).
    // Once any target exists, a bare token marks the start of the body.
    if (targets.length === 0) {
      targets.push(token.value.trim());
      bodyStart = token.end;
    }

    break;
  }

  const body = targets.length === 0
    ? remainder.trim()
    : remainder.slice(bodyStart).trim();

  return { targets, body };
}