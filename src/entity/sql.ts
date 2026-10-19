import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The storage capability the entity store needs: parameterized queries and an
 * atomic batch. D1 provides both natively (`batch` runs in one transaction),
 * and tests use SQLite with an explicit transaction.
 */
export type SqlValue = string | number | null;

export interface Statement {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
}

export const sql = (text: string, ...params: ReadonlyArray<SqlValue>): Statement => ({
  sql: text,
  params,
});

export class SqlError extends Schema.TaggedError<SqlError>()("SqlError", {
  message: Schema.String,
  /** A UNIQUE/PRIMARY KEY violation: another writer got there first. */
  constraint: Schema.Boolean,
}) {}

export const isConstraintMessage = (message: string) => /constraint failed/i.test(message);

export class SqlDatabase extends Context.Service<
  SqlDatabase,
  {
    readonly all: (
      statement: Statement,
    ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>;
    /** Run statements atomically; all commit or none do. Returns rows changed per statement. */
    readonly batch: (
      statements: ReadonlyArray<Statement>,
    ) => Effect.Effect<ReadonlyArray<{ readonly changes: number }>, SqlError>;
  }
>()("entity-store/SqlDatabase") {}
