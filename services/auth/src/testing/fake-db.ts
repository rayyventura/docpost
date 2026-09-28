/**
 * Test-only stand-in for the Drizzle client returned by `getDb()`.
 *
 * Every query-builder chain (`select().from().where().limit()`, `insert().values()`,
 * `update().set().where().returning()`, `delete().where()`) records its calls and, when
 * awaited, resolves to the next queued result. Queue one result per awaited query, in
 * the order the code under test awaits them. Queue an `Error` to make that query reject.
 * `transaction(fn)` runs `fn` against the same fake.
 */
export interface FakeDbCall {
  method: string;
  args: unknown[];
}

export interface FakeDb {
  db: unknown;
  calls: FakeDbCall[];
  queue: (...results: unknown[]) => void;
  reset: () => void;
  /** Arguments of every call to `method`, in order. */
  argsOf: (method: string) => unknown[][];
  remaining: () => number;
}

export function createFakeDb(): FakeDb {
  const pending: unknown[] = [];
  const calls: FakeDbCall[] = [];

  const nextResult = (): unknown => {
    if (pending.length === 0) {
      return [];
    }
    const result = pending.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const builder: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            try {
              resolve(nextResult());
            } catch (err) {
              reject(err);
            }
          };
        }
        if (typeof prop === 'symbol') {
          return undefined;
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return builder;
        };
      },
    },
  );

  const start =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  const db = {
    select: start('select'),
    insert: start('insert'),
    update: start('update'),
    delete: start('delete'),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      calls.push({ method: 'transaction', args: [] });
      return fn(db);
    },
  };

  return {
    db,
    calls,
    queue: (...results: unknown[]) => {
      pending.push(...results);
    },
    reset: () => {
      pending.length = 0;
      calls.length = 0;
    },
    argsOf: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
    remaining: () => pending.length,
  };
}
