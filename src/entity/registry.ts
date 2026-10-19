import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { CompiledLens } from "../lens/apply.ts";
import { compileLens } from "../lens/apply.ts";
import { Lens } from "../lens/model.ts";
import type { CompiledSchema } from "../schema/compile.ts";
import { compiled } from "../schema/compile.ts";
import { EntitySchema } from "../schema/model.ts";
import type { TypeSummary, VersionInfo } from "./model.ts";
import { StorageFailure, TypeNotFound, VersionNotFound } from "./model.ts";
import { SqlDatabase, sql } from "./sql.ts";

/** A schema version with its validator and the lens that leads into it. */
export interface LoadedVersion {
  readonly info: VersionInfo;
  readonly schema: CompiledSchema;
  /** Lens from `version - 1`; absent for v1. */
  readonly lens: CompiledLens | undefined;
}

const MAX_CACHED = 2000;

/**
 * Compiled schema versions, shared across requests for the isolate's lifetime.
 * Versions are immutable once written, so entries never go stale; only the
 * latest-version pointer is read from storage each time.
 */
export class VersionCache extends Context.Service<
  VersionCache,
  {
    readonly get: (type: string, version: number) => LoadedVersion | undefined;
    readonly set: (loaded: LoadedVersion) => void;
  }
>()("entity-store/VersionCache") {
  static readonly make = () => {
    const entries = new Map<string, LoadedVersion>();
    const key = (type: string, version: number) => `${type}\u0000${version}`;
    return VersionCache.of({
      get: (type, version) => entries.get(key(type, version)),
      set: (loaded) => {
        if (entries.size >= MAX_CACHED) {
          entries.clear();
        }
        entries.set(key(loaded.info.type, loaded.info.version), loaded);
      },
    });
  };
  static readonly layer = Layer.sync(VersionCache, VersionCache.make);
}

const TypeRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  latest_version: Schema.Number,
  created_at: Schema.Number,
  updated_at: Schema.Number,
});

const VersionRow = Schema.Struct({
  type: Schema.String,
  version: Schema.Number,
  schema: Schema.fromJsonString(EntitySchema),
  lens: Schema.NullOr(Schema.fromJsonString(Lens)),
  note: Schema.String,
  created_at: Schema.Number,
});

export const decodeRows =
  <S extends Schema.Codec<any, any>>(schema: S, what: string) =>
  (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(schema)(row).pipe(
        Effect.mapError(
          (error) =>
            new StorageFailure({ message: `Stored ${what} no longer decodes: ${error.message}` }),
        ),
      ),
    ) as Effect.Effect<ReadonlyArray<S["Type"]>, StorageFailure>;

export const toSummary = (row: typeof TypeRow.Type): TypeSummary => ({
  name: row.name,
  description: row.description,
  latestVersion: row.latest_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const storageFailure = (error: { readonly message: string }) =>
  new StorageFailure({ message: error.message });

/** Reads types and schema versions, compiling and caching versions on first use. */
export const makeRegistry = Effect.gen(function* () {
  const db = yield* SqlDatabase;
  const cache = yield* VersionCache;

  const listTypes = Effect.fn("Registry.listTypes")(function* () {
    const rows = yield* db
      .all(sql("SELECT * FROM entity_types ORDER BY name"))
      .pipe(Effect.mapError(storageFailure));
    return (yield* decodeRows(TypeRow, "type")(rows)).map(toSummary);
  });

  const getType = Effect.fn("Registry.getType")(function* (name: string) {
    const rows = yield* db
      .all(sql("SELECT * FROM entity_types WHERE name = ?", name))
      .pipe(Effect.mapError(storageFailure));
    const [row] = yield* decodeRows(TypeRow, "type")(rows);
    if (row === undefined) {
      return yield* new TypeNotFound({ type: name });
    }
    return toSummary(row);
  });

  const toLoaded = (row: typeof VersionRow.Type) =>
    Effect.gen(function* () {
      const lens =
        row.lens === null ? undefined : compileLens(row.lens);
      if (lens !== undefined && Result.isFailure(lens)) {
        return yield* new StorageFailure({
          message: `Stored lens for ${row.type} v${row.version} no longer compiles`,
        });
      }
      const info: VersionInfo = {
        type: row.type,
        version: row.version,
        schema: row.schema,
        ...(row.lens === null ? {} : { lens: row.lens }),
        note: row.note,
        createdAt: row.created_at,
      };
      const loaded: LoadedVersion = {
        info,
        schema: compiled(row.schema),
        lens: lens === undefined ? undefined : lens.success,
      };
      return loaded;
    });

  /** Load versions `from..to` (inclusive), hitting storage only for uncached ones. */
  const versions = Effect.fn("Registry.versions")(function* (
    type: string,
    from: number,
    to: number,
  ) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const missing: Array<number> = [];
    for (let v = lo; v <= hi; v++) {
      if (cache.get(type, v) === undefined) {
        missing.push(v);
      }
    }
    if (missing.length > 0) {
      const rows = yield* db
        .all(
          sql(
            "SELECT * FROM schema_versions WHERE type = ? AND version BETWEEN ? AND ? ORDER BY version",
            type,
            Math.min(...missing),
            Math.max(...missing),
          ),
        )
        .pipe(Effect.mapError(storageFailure));
      for (const row of yield* decodeRows(VersionRow, "schema version")(rows)) {
        cache.set(yield* toLoaded(row));
      }
    }
    const out: Array<LoadedVersion> = [];
    for (let v = lo; v <= hi; v++) {
      const loaded = cache.get(type, v);
      if (loaded === undefined) {
        return yield* new VersionNotFound({ type, version: v });
      }
      out.push(loaded);
    }
    return out;
  });

  const version = Effect.fn("Registry.version")(function* (type: string, v: number) {
    const [loaded] = yield* versions(type, v, v);
    if (loaded === undefined) {
      return yield* new VersionNotFound({ type, version: v });
    }
    return loaded;
  });

  return { listTypes, getType, versions, version };
});

export type Registry = Effect.Success<typeof makeRegistry>;
