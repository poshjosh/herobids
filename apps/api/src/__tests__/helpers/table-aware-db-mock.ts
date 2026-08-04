import { vi } from 'vitest';
import type { Database } from '@herobids/db';

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for a table-aware DB mock instance. */
export interface TableAwareDbConfig {
  /** Per-table rows keyed by table identity. Each key maps to a queue of row arrays
   *  consumed in order; the last array repeats if more selects hit the same table. */
  tableRows?: Map<unknown, unknown[][]>;
  /** Responses for raw sql execute() calls, consumed in order. Last repeats. */
  executeResults?: unknown[][];
}

// ── Table-aware select ───────────────────────────────────────────────────────

/**
 * Returns the next batch of rows for a given table. Consumes from the table's
 * queue; repeats the last entry if the queue is exhausted.
 */
function nextTableRows(tableRows: Map<unknown, unknown[][]>, table: unknown): unknown[] {
  const queue = tableRows.get(table);
  if (!queue || queue.length === 0) return [];
  if (queue.length === 1) return queue[0]!;
  return queue.shift()!;
}

/**
 * Create a select() implementation that dispatches by table identity.
 * When .from(table) is called, records the table; when the chain is awaited,
 * returns the next batch of rows for that table.
 */
function createTableAwareSelect(
  tableRows: Map<unknown, unknown[][]>,
): (...args: unknown[]) => Record<string, unknown> {
  return () => {
    let capturedTable: unknown = null;

    const overrides: Record<string, (...args: unknown[]) => unknown> = {
      from: vi.fn((table: unknown) => {
        capturedTable = table;
        // Return an extended chain that also has tableAware from/for chaining
        return makeChainableFromTable(tableRows, table);
      }),
    };

    function makeChainableFromTable(tableRowsMap: Map<unknown, unknown[][]>, table: unknown): Record<string, unknown> {
      const chain: Record<string, unknown> = {};
      // Chain methods
      for (const m of [
        'from', 'where', 'orderBy', 'limit', 'offset', '$dynamic',
        'innerJoin', 'leftJoin', 'groupBy', 'having',
      ]) {
        chain[m] = vi.fn(() => chain);
      }
      // for('update') returns the same chain
      chain['for'] = vi.fn(() => chain);
      // thenable: resolve to rows for the captured table
      (chain as { then: unknown }).then = (
        resolve: (v: unknown) => unknown,
        reject?: (v: unknown) => unknown,
      ) => {
        const rows = nextTableRows(tableRowsMap, table);
        return Promise.resolve(rows).then(resolve, reject);
      };
      return chain;
    }

    // If from() is never called, we still need a thenable
    const chain: Record<string, unknown> = { ...overrides };
    for (const m of [
      'where', 'orderBy', 'limit', 'offset', '$dynamic',
      'innerJoin', 'leftJoin', 'groupBy', 'having',
    ]) {
      chain[m] = vi.fn(() => chain);
    }
    chain['for'] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => {
      // If from() was never called, return empty (shouldn't happen in practice)
      if (capturedTable) {
        const rows = nextTableRows(tableRows, capturedTable);
        return Promise.resolve(rows).then(resolve, reject);
      }
      return Promise.resolve([]).then(resolve, reject);
    };

    return chain;
  };
}

// ── Transaction-aware write stubs ────────────────────────────────────────────

function createWriteStubs() {
  return {
    values: vi.fn().mockResolvedValue(undefined),
    // For returning clause — some handlers may use .returning()
    returning: vi.fn().mockResolvedValue([]),
  };
}

function createTxExecute(executeResults: unknown[][]) {
  return vi.fn().mockImplementation(() => {
    if (executeResults.length === 0) return Promise.resolve([{ cnt: 0 }]);
    if (executeResults.length === 1) return Promise.resolve(executeResults[0]);
    return Promise.resolve(executeResults.shift()!);
  });
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Create a table-aware DB mock.
 *
 * ## Table rows
 * Use `setTableRows(table, [[row1], [row2]])` to configure rows returned by
 * `db.select().from(table)`. Each call consumes the next array; the last array
 * repeats indefinitely.
 *
 * ## Raw SQL execute
 * Use `setExecuteResults([[row1], [row2]])` for `db.execute(sql\`...\`)` and
 * `tx.execute(sql\`...\`)`. Defaults to `[{ cnt: 0 }]` (safe count query result).
 *
 * ## Transactions
 * `db.transaction(fn)` calls `fn(tx)` where `tx` shares the same table rows
 * and execute results as `db`. Within a transaction, `tx.select().from(table)`
 * consumes from the same queues.
 *
 * ## Writes
 * `insert().values()`, `update().set().where()`, `delete().where()` are no-ops
 * that resolve to `undefined`.
 */
export function createTableAwareDb(config?: TableAwareDbConfig): {
  /** Set rows for a specific table. Each array is returned by one select().from(table) call. */
  setTableRows: (table: unknown, rows: unknown[][]) => void;
  /** Append rows to the end of a table's queue. */
  addTableRows: (table: unknown, rows: unknown[][]) => void;
  /** Set responses for execute() calls. */
  setExecuteResults: (results: unknown[][]) => void;
  /** Build and return the mock Database object. */
  build: () => Database;
} {
  const tableRows: Map<unknown, unknown[][]> = config?.tableRows ?? new Map();
  const executeResults: unknown[][] = config?.executeResults ?? [];

  function setTableRows(table: unknown, rows: unknown[][]) {
    tableRows.set(table, rows.map((r) => [...r]));
  }

  function addTableRows(table: unknown, rows: unknown[][]) {
    const existing = tableRows.get(table);
    if (existing) {
      existing.push(...rows.map((r) => [...r]));
    } else {
      tableRows.set(table, rows.map((r) => [...r]));
    }
  }

  function setExecuteResults(results: unknown[][]) {
    executeResults.length = 0;
    executeResults.push(...results);
  }

  function build(): Database {
    // Create select for db-level queries
    const dbSelect = createTableAwareSelect(tableRows);

    // Create execute for db-level raw SQL
    const dbExecute = vi.fn().mockImplementation(() => {
      if (executeResults.length === 0) return Promise.resolve([{ cnt: 0 }]);
      if (executeResults.length === 1) return Promise.resolve([...executeResults[0]!]);
      return Promise.resolve([...(executeResults.shift()!)]);
    });

    // Create inner function to build db/tx
    function buildInstance(): Record<string, unknown> {
      return {
        select: dbSelect,
        execute: dbExecute,
        insert: vi.fn().mockReturnValue(createWriteStubs()),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
        transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          // Build a tx that shares the same table rows and execute results
          const tx = {
            select: createTableAwareSelect(tableRows),
            execute: createTxExecute(executeResults),
            insert: vi.fn().mockReturnValue(createWriteStubs()),
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
              }),
            }),
            delete: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          };
          return fn(tx);
        }),
      };
    }

    return buildInstance() as unknown as Database;
  }

  return { setTableRows, addTableRows, setExecuteResults, build };
}
