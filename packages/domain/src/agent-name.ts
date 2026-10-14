export const AGENT_NAME_ADJECTIVES = [
  'magical', 'green', 'first', 'swift', 'quiet', 'bright', 'brave', 'clever', 'gentle', 'lucky',
  'mellow', 'nimble', 'noble', 'rapid', 'silver', 'steady', 'sunny', 'vivid', 'witty', 'bold',
  'calm', 'crisp', 'eager', 'fresh', 'golden', 'happy', 'jolly', 'keen', 'lively', 'merry',
  'polite', 'royal', 'solid', 'tidy', 'vast', 'warm', 'wise', 'zesty',
] as const;

export const AGENT_NAME_NOUNS = [
  'cleaner', 'minister', 'majesty', 'falcon', 'river', 'harbor', 'compass', 'lantern', 'meadow', 'orchard',
  'pioneer', 'rocket', 'sailor', 'signal', 'summit', 'thunder', 'tiger', 'valley', 'village', 'wizard',
  'anchor', 'beacon', 'cedar', 'comet', 'dolphin', 'engine', 'fox', 'garden', 'hatch', 'island',
  'jaguar', 'kettle', 'ledger', 'marble', 'nectar', 'otter', 'parrot', 'quartz', 'ranger', 'spark',
] as const;

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('agent name word list is empty');
  return item;
}

/** A two-word `adjective-noun` agent name candidate. Uniqueness is the caller's concern. */
export function generateAgentNameCandidate(random: () => number = Math.random): string {
  return `${pick(AGENT_NAME_ADJECTIVES, random)}-${pick(AGENT_NAME_NOUNS, random)}`;
}
