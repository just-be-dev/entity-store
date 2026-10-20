import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import type { IndexInfo } from "./entityStore.ts";
import { asObject, field } from "./json.ts";

/** Top-level field names of a schema, sorted: what an index key expression can read. */
export const schemaFields = (schema: Schema.Json): ReadonlyArray<string> =>
  Option.match(asObject(field(schema, "fields")), {
    onNone: () => [],
    onSome: (fields) => Array.sort(Record.keys(fields), Order.String),
  });

/** Indexes that answer lookups. */
export const readyIndexes = (indexes: ReadonlyArray<IndexInfo>): ReadonlyArray<IndexInfo> =>
  Array.filter(indexes, (index) => index.state === "ready");
