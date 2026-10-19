import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SqlDatabase, SqlError, isConstraintMessage } from "../entity/sql.ts";
import type { SqlValue, Statement } from "../entity/sql.ts";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Apply every migration in order, the way Alchemy applies them to D1. */
export const migrate = (database: DatabaseSync) => {
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
};

const toSqlError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return new SqlError({ message, constraint: isConstraintMessage(message) });
};

const params = (statement: Statement): Array<SqlValue> => [...statement.params];

/**
 * SQLite (node:sqlite) implementation of SqlDatabase for tests. Batches run in
 * a transaction, matching D1's all-or-nothing `batch`. `beforeBatch` lets a
 * test interleave another writer between a read and a batch.
 */
export const makeSqlite = (options?: { readonly beforeBatch?: () => void }) => {
  const database = new DatabaseSync(":memory:");
  migrate(database);
  const service = SqlDatabase.of({
    all: (statement) =>
      Effect.try({
        try: () =>
          database.prepare(statement.sql).all(...params(statement)) as ReadonlyArray<
            Record<string, unknown>
          >,
        catch: toSqlError,
      }),
    batch: (statements) =>
      Effect.try({
        try: () => {
          options?.beforeBatch?.();
          database.exec("BEGIN");
          try {
            const results = statements.map((statement) => ({
              changes: Number(database.prepare(statement.sql).run(...params(statement)).changes),
            }));
            database.exec("COMMIT");
            return results;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
        catch: toSqlError,
      }),
  });
  return { database, service, layer: Layer.succeed(SqlDatabase, service) };
};
