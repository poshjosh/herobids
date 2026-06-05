import type { Journal, JournalEntry } from './journal.js';

/**
 * In-memory journal — useful for testing and paper mode.
 * Stores entries in a simple array.
 */
export class InMemoryJournal implements Journal {
  readonly entries: Omit<JournalEntry, 'id' | 'createdAt'>[] = [];

  async append(entry: Omit<JournalEntry, 'id' | 'createdAt'>): Promise<void> {
    this.entries.push(entry);
  }

  async appendBatch(entries: Omit<JournalEntry, 'id' | 'createdAt'>[]): Promise<void> {
    this.entries.push(...entries);
  }

  /** Get entries filtered by type */
  byType(type: JournalEntry['type']): Omit<JournalEntry, 'id' | 'createdAt'>[] {
    return this.entries.filter((e) => e.type === type);
  }

  /** Get entries filtered by actor */
  byActor(actorType: string, actorId: string): Omit<JournalEntry, 'id' | 'createdAt'>[] {
    return this.entries.filter((e) => e.actorType === actorType && e.actorId === actorId);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
