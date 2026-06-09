export interface DeterministicRandom {
  next(): number;
}

function hashSeed(seed: number | string): number {
  const value = String(seed);
  let hash = 2_169_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function createDeterministicRandom(seed: number | string): DeterministicRandom {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return {
    next: () => {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
}