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

function normalizeNames(knownAgentNames: string[]): Set<string> {
  return new Set(knownAgentNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

export function parseTelegramCommand(text: string, knownAgentNames: string[] = []): TelegramCommandParseResult | null {
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
  const knownNames = normalizeNames(knownAgentNames);
  const targets: string[] = [];
  let bodyStart = 0;

  for (const token of tokens) {
    const normalized = token.value.trim().toLowerCase();
    const isKnownName = knownNames.has(normalized);
    if (token.quoted || isReservedTarget(token.value) || isKnownName) {
      targets.push(token.value.trim());
      bodyStart = token.end;
      continue;
    }
    break;
  }

  const body = targets.length === 0
    ? remainder.trim()
    : remainder.slice(bodyStart).trim();

  return { targets, body };
}