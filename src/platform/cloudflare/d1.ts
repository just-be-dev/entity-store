import type * as runtime from "@cloudflare/workers-types";
import type * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Statement } from "../../entity/sql.ts";
import { SqlDatabase, SqlError, isConstraintMessage } from "../../entity/sql.ts";

const toSqlError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return new SqlError({ message, constraint: isConstraintMessage(message) });
};

const prepare = (raw: runtime.D1Database, statement: Statement) =>
  raw.prepare(statement.sql).bind(...statement.params);

/**
 * SqlDatabase on a D1 binding. Build it per request: it captures the request's
 * RuntimeContext so the store's operations stay free of platform requirements.
 * D1's `batch` is a transaction, which is what the store relies on.
 */
export const d1SqlDatabase = (
  binding: Effect.Effect<runtime.D1Database, never, Alchemy.RuntimeContext>,
) =>
  Layer.effect(
    SqlDatabase,
    Effect.gen(function* () {
      const context = yield* Effect.context<Alchemy.RuntimeContext>();
      const database = binding.pipe(Effect.provideContext(context));
      return SqlDatabase.of({
        all: (statement) =>
          Effect.flatMap(database, (raw) =>
            Effect.tryPromise({
              try: () => prepare(raw, statement).all<Record<string, unknown>>(),
              catch: toSqlError,
            }),
          ).pipe(Effect.map((result) => result.results ?? [])),
        batch: (statements) =>
          Effect.flatMap(database, (raw) =>
            Effect.tryPromise({
              try: () => raw.batch(statements.map((statement) => prepare(raw, statement))),
              catch: toSqlError,
            }),
          ).pipe(
            Effect.map((results) => results.map((result) => ({ changes: result.meta.changes }))),
          ),
      });
    }),
  );
