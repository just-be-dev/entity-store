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
import type { LoadedIndex } from "./indexes.ts";
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

/** The indexes writers maintain for a type, as of one `indexes_rev`. */
export interface LoadedIndexes {
  readonly rev: number;
  readonly items: ReadonlyArray<LoadedIndex>;
}

/**
 * Compiled schema versions and index definitions, shared across requests for
 * the isolate's lifetime. Versions are immutable for as long as their type
 * exists, so entries never go stale; only the latest-version pointer is read
 * from storage each time. A deleted type can be created again under the same
 * name, so versions are keyed by the type's `incarnation` as last observed in
 * a type row. Index definitions are keyed by the type's `indexes_rev`, which
 * every write reads with the entity and re-checks in its batch.
 */
export class VersionCache extends Context.Service<
  VersionCache,
  {
    /** Record the incarnation a type row was read with. */
    readonly observe: (type: string, incarnation: string) => void;
    /** A version of the type's observed incarnation. */
    readonly get: (type: string, version: number) => LoadedVersion | undefined;
    readonly set: (loaded: LoadedVersion, incarnation: string) => void;
    readonly isObserved: (type: string) => boolean;
    readonly getIndexes: (type: string) => LoadedIndexes | undefined;
    readonly setIndexes: (type: string, indexes: LoadedIndexes) => void;
  }
>()("entity-store/VersionCache") {
  static readonly make = () => {
    const entries = new Map<string, LoadedVersion>();
    const incarnations = new Map<string, string>();
    const indexes = new Map<string, LoadedIndexes>();
    const key = (type: string, incarnation: string, version: number) =>
      `${type}\u0000${incarnation}\u0000${version}`;
    return VersionCache.of({
      observe: (type, incarnation) => {
        if (incarnations.get(type) !== incarnation) {
          if (incarnations.size >= MAX_CACHED) {
            incarnations.clear();
          }
          incarnations.set(type, incarnation);
          indexes.delete(type);
        }
      },
      get: (type, version) => {
        const incarnation = incarnations.get(type);
        return incarnation === undefined ? undefined : entries.get(key(type, incarnation, version));
      },
      set: (loaded, incarnation) => {
        if (entries.size >= MAX_CACHED) {
          entries.clear();
        }
        entries.set(key(loaded.info.type, incarnation, loaded.info.version), loaded);
      },
      isObserved: (type) => incarnations.has(type),
      getIndexes: (type) => indexes.get(type),
      setIndexes: (type, loaded) => {
        if (indexes.size >= MAX_CACHED) {
          indexes.clear();
        }
        indexes.set(type, loaded);
      },
    });
  };
  static readonly layer = Layer.sync(VersionCache, VersionCache.make);
}

const TypeRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  latest_version: Schema.Number,
  indexes_rev: Schema.Number,
  incarnation: Schema.String,
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
  /** The type's incarnation, read in the same statement as the version. */
  incarnation: Schema.String,
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
    const decoded = yield* decodeRows(TypeRow, "type")(rows);
    decoded.forEach((row) => cache.observe(row.name, row.incarnation));
    return decoded.map(toSummary);
  });

  /** A type with the `indexes_rev` its writers must check. */
  const typeState = Effect.fn("Registry.typeState")(function* (name: string) {
    const rows = yield* db
      .all(sql("SELECT * FROM entity_types WHERE name = ?", name))
      .pipe(Effect.mapError(storageFailure));
    const [row] = yield* decodeRows(TypeRow, "type")(rows);
    if (row === undefined) {
      return yield* new TypeNotFound({ type: name });
    }
    cache.observe(name, row.incarnation);
    return {
      summary: toSummary(row),
      indexesRev: row.indexes_rev,
      incarnation: row.incarnation,
    };
  });

  const getType = Effect.fn("Registry.getType")(function* (name: string) {
    return (yield* typeState(name)).summary;
  });

  const toLoaded = (row: typeof VersionRow.Type) =>
    Effect.gen(function* () {
      const lens = row.lens === null ? undefined : compileLens(row.lens);
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
    // Collect into a local map: the shared cache may evict while we load.
    const found = new Map<number, LoadedVersion>();
    const missing: Array<number> = [];
    for (let v = lo; v <= hi; v++) {
      const cached = cache.get(type, v);
      if (cached === undefined) {
        missing.push(v);
      } else {
        found.set(v, cached);
      }
    }
    if (missing.length > 0) {
      const rows = yield* db
        .all(
          sql(
            "SELECT v.*, t.incarnation FROM schema_versions v JOIN entity_types t ON t.name = v.type WHERE v.type = ? AND v.version BETWEEN ? AND ? ORDER BY v.version",
            type,
            Math.min(...missing),
            Math.max(...missing),
          ),
        )
        .pipe(Effect.mapError(storageFailure));
      for (const row of yield* decodeRows(VersionRow, "schema version")(rows)) {
        const loaded = yield* toLoaded(row);
        // Cache under the incarnation read with the row, never the observed
        // one: the type may have been deleted and recreated in between.
        if (!cache.isObserved(type)) {
          cache.observe(type, row.incarnation);
        }
        cache.set(loaded, row.incarnation);
        found.set(loaded.info.version, loaded);
      }
    }
    const out: Array<LoadedVersion> = [];
    for (let v = lo; v <= hi; v++) {
      const loaded = found.get(v);
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

  return { listTypes, typeState, getType, versions, version };
});

export type Registry = Effect.Success<typeof makeRegistry>;
