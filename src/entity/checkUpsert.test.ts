import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { EntityStore, VersionCache } from "./store.ts";

const Person: EntitySchema = {
  title: "name",
  fields: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", format: "email", optional: true },
    born: { type: "string", format: "datetime", optional: true },
    role: { type: "enum", values: ["admin", "member"], optional: true },
    code: { type: "string", pattern: "^[A-Z]{3}$", optional: true },
    manager: { type: "nullable", of: { type: "link", to: "person" }, optional: true },
  },
};

const setup = () => {
  const sqlite = makeSqlite();
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  return { sqlite, layer };
};

/** Rows in every table a write touches. */
const footprint = (sqlite: ReturnType<typeof makeSqlite>) =>
  ["entities", "entity_revisions", "entity_changes", "entity_links", "index_entries"].map((table) =>
    Number(sqlite.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]),
  );

const withTypes = Effect.gen(function* () {
  const store = yield* EntityStore;
  yield* store.createType({ name: "person", schema: Person });
  yield* store.createType({ name: "note", schema: { fields: { text: { type: "string" } } } });
  yield* store.createIndex("person", { name: "email", version: 1, key: "email", unique: true });
  return store;
});

describe("checkUpsert", () => {
  it.effect("writes nothing and records no change, for a create, a patch, and a revive", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* withTypes;
      const before = footprint(sqlite);
      expect(
        yield* store.checkUpsert("person", "ada", { patch: { name: "Ada", email: null } }),
      ).toEqual({ data: { name: "Ada" }, version: 1, created: true });
      expect(footprint(sqlite)).toEqual(before);

      yield* store.upsert("person", "ada", { patch: { name: "Ada", email: "ada@x.io" } });
      const live = footprint(sqlite);
      expect(yield* store.checkUpsert("person", "ada", { patch: { role: "admin" } })).toEqual({
        data: { name: "Ada", email: "ada@x.io", role: "admin" },
        version: 1,
        created: false,
      });
      expect(footprint(sqlite)).toEqual(live);

      yield* store.remove("ada");
      const deleted = footprint(sqlite);
      expect(yield* store.checkUpsert("person", "ada", { patch: { name: "Back" } })).toEqual({
        data: { name: "Back" },
        version: 1,
        created: true,
      });
      expect(footprint(sqlite)).toEqual(deleted);
      expect((yield* store.history("ada")).items).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("accepts and rejects exactly what upsert does", () =>
    Effect.gen(function* () {
      const store = yield* withTypes;
      const cases: ReadonlyArray<
        readonly [type: string, id: string, patch: object, outcome: string]
      > = [
        ["person", "ada", { name: "Ada", email: "ada@x.io", born: "1815-12-10T00:00:00Z" }, "ok"],
        ["person", "ada", { born: "1815-12-10" }, "ValidationFailed"],
        ["person", "ada", { role: "owner" }, "ValidationFailed"],
        ["person", "ada", { code: "abc" }, "ValidationFailed"],
        ["person", "ada", { code: "ABC", role: "admin" }, "ok"],
        ["person", "ada", { name: null }, "ValidationFailed"],
        ["person", "ada", { extra: 1 }, "ValidationFailed"],
        ["person", "bob", { name: "Bob", manager: "nobody" }, "LinkTargetInvalid"],
        ["person", "bob", { name: "Bob", manager: "ada" }, "ok"],
        ["person", "eve", { name: "Eve", email: "ada@x.io" }, "UniqueViolation"],
        ["person", "eve", { name: "Eve", email: "eve@x.io" }, "ok"],
        ["note", "ada", { text: "x" }, "EntityTypeMismatch"],
        ["nope", "z", { text: "x" }, "TypeNotFound"],
      ];
      for (const [type, id, patch, outcome] of cases) {
        const checked = yield* Effect.result(store.checkUpsert(type, id, { patch }));
        const written = yield* Effect.result(store.upsert(type, id, { patch }));
        const label = `${type}/${id} ${JSON.stringify(patch)}`;
        if (Result.isSuccess(written)) {
          expect([label, "ok"]).toEqual([label, outcome]);
          expect(checked).toEqual(
            Result.succeed({
              data: written.success.entity.data,
              version: written.success.entity.version,
              created: written.success.created,
            }),
          );
        } else {
          expect([label, written.failure._tag]).toEqual([label, outcome]);
          expect(Result.isFailure(checked) && checked.failure._tag).toBe(written.failure._tag);
        }
      }
    }).pipe(Effect.provide(setup().layer)),
  );
});
