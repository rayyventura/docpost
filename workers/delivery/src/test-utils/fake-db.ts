// Test-only helper: a chainable stand-in for the drizzle query builder.
// Every awaited query is recorded as a `DbCall`, and its result comes from the
// `resolve` callback, so unit tests can script the database without Postgres.
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, is, Table, type SQL } from 'drizzle-orm';

export interface DbCall {
  op: 'select' | 'update' | 'insert' | 'delete' | 'execute';
  table?: unknown;
  /** SQL name of `table`; compare on this, since module resets create new table objects. */
  tableName?: string;
  fields?: unknown;
  values?: Record<string, unknown>;
  where?: SQL;
  returning?: boolean;
  join?: boolean;
  groupBy?: boolean;
  limit?: number;
  conflict?: unknown;
  sql?: SQL;
}

interface Chain extends PromiseLike<unknown> {
  from(table: unknown): Chain;
  innerJoin(table: unknown, on: unknown): Chain;
  where(where: SQL | undefined): Chain;
  groupBy(...cols: unknown[]): Chain;
  limit(n: number): Chain;
  set(values: Record<string, unknown>): Chain;
  values(values: Record<string, unknown>): Chain;
  onConflictDoUpdate(config: unknown): Chain;
  returning(fields?: unknown): Chain;
}

const dialect = new PgDialect();

/** Renders a recorded where clause (or raw sql) to `{ sql, params }` for assertions. */
export function render(where: SQL | undefined): { sql: string; params: unknown[] } {
  if (!where) return { sql: '', params: [] };
  return dialect.sqlToQuery(where);
}

function setTable(call: DbCall, table: unknown): DbCall {
  call.table = table;
  call.tableName = is(table, Table) ? getTableName(table) : undefined;
  return call;
}

export function fakeDb(resolve: (call: DbCall) => unknown = () => []) {
  const calls: DbCall[] = [];

  function chain(call: DbCall): Chain {
    const c: Chain = {
      from(table) { setTable(call, table); return c; },
      innerJoin() { call.join = true; return c; },
      where(where) { call.where = where; return c; },
      groupBy() { call.groupBy = true; return c; },
      limit(n) { call.limit = n; return c; },
      set(values) { call.values = values; return c; },
      values(values) { call.values = values; return c; },
      onConflictDoUpdate(config) { call.conflict = config; return c; },
      returning() { call.returning = true; return c; },
      then(onFulfilled, onRejected) {
        calls.push(call);
        return Promise.resolve()
          .then(() => resolve(call))
          .then(onFulfilled, onRejected);
      },
    };
    return c;
  }

  const db = {
    select: (fields?: unknown) => chain({ op: 'select', fields }),
    update: (table: unknown) => chain(setTable({ op: 'update' }, table)),
    insert: (table: unknown) => chain(setTable({ op: 'insert' }, table)),
    delete: (table: unknown) => chain(setTable({ op: 'delete' }, table)),
    execute: async (sql: SQL) => {
      const call: DbCall = { op: 'execute', sql };
      calls.push(call);
      return resolve(call) ?? { rows: [] };
    },
  };

  return { db, calls };
}
