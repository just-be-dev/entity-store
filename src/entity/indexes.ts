import * as Result from "effect/Result";
import type { Expr, Json } from "../lens/expr.ts";
import { freeVariables, parse, run } from "../lens/expr.ts";
import type { EntitySchema } from "../schema/model.ts";
import type { IndexState, Issue } from "./model.ts";

/**
 * Secondary indexes, the pure part: checking definitions and computing keys.
 *
 * An index is pinned to one schema version. Its keys come from evaluating the
 * `key` expression against an entity's data lensed to that version. Versions
 * and lenses are immutable, so an entity's keys only change when the entity
 * does; new schema versions never invalidate an index.
 */

/** Bounds write fan-out: every maintained index costs work on every write. */
export const MAX_INDEXES_PER_TYPE = 16;
export const MAX_KEY_LENGTH = 1024;
/** Distinct keys one entity may have in one (non-unique, array-valued) index. */
export const MAX_KEYS_PER_ENTITY = 64;

export interface IndexDefinition {
  readonly name: string;
  readonly version: number;
  readonly key: string;
  readonly unique: boolean;
}

/** A definition ready for use by writers and the backfill. */
export interface LoadedIndex extends IndexDefinition {
  readonly expr: Expr;
  readonly state: IndexState;
  readonly generation: number;
}

/** Check a definition against the schema of the version it's pinned to. */
export const checkIndexDefinition = (
  definition: IndexDefinition,
  schema: EntitySchema,
): Result.Result<Expr, ReadonlyArray<Issue>> => {
  const parsed = parse(definition.key);
  if (Result.isFailure(parsed)) {
    return Result.fail([{ path: "key", message: parsed.failure }]);
  }
  const unknown = [...freeVariables(parsed.success)].filter(
    (name) => !Object.hasOwn(schema.fields, name),
  );
  if (unknown.length > 0) {
    return Result.fail(
      unknown.map((name) => ({
        path: "key",
        message: `'${name}' isn't a field of v${definition.version}`,
      })),
    );
  }
  return Result.succeed(parsed.success);
};

const describe = (value: Json): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "arrays";
  return typeof value;
};

/** `value` as a key, or why it can't be one. */
const toKey = (value: Json): Result.Result<string, string> => {
  if (typeof value !== "string") {
    return Result.fail(`keys must be strings, not ${describe(value)} (use string(...) to convert)`);
  }
  if (value.length > MAX_KEY_LENGTH) {
    return Result.fail(`keys are limited to ${MAX_KEY_LENGTH} characters`);
  }
  return Result.succeed(value);
};

/**
 * The keys `doc` (already at the index's version) has in an index. A missing
 * or null key means the entity isn't in the index. Arrays give one key per
 * distinct element, for non-unique indexes only.
 */
export const indexKeys = (
  index: Pick<LoadedIndex, "expr" | "unique">,
  doc: Json,
): Result.Result<ReadonlyArray<string>, string> => {
  let value: Json | undefined;
  try {
    value = run(index.expr, doc);
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error));
  }
  if (value === undefined || value === null) {
    return Result.succeed([]);
  }
  if (Array.isArray(value)) {
    if (index.unique) {
      return Result.fail("unique index keys can't be arrays");
    }
    const keys = new Set<string>();
    for (const item of value) {
      if (item === null) {
        continue;
      }
      const key = toKey(item);
      if (Result.isFailure(key)) {
        return Result.fail(key.failure);
      }
      keys.add(key.success);
    }
    if (keys.size > MAX_KEYS_PER_ENTITY) {
      return Result.fail(`an entity may have at most ${MAX_KEYS_PER_ENTITY} keys in one index`);
    }
    return Result.succeed([...keys]);
  }
  return Result.map(toKey(value), (key) => [key]);
};

/** Keys in `a` that aren't in `b`. */
export const keysMinus = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const drop = new Set(b);
  return a.filter((key) => !drop.has(key));
};
