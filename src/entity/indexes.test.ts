import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { parse } from "../lens/expr.ts";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { checkIndexDefinition, indexKeys } from "./indexes.ts";
import { BUILD_PAGE, EntityStore, SYNC_BUILD_PAGES, VersionCache } from "./store.ts";

const setup = (options?: Parameters<typeof makeSqlite>[0]) => {
  const sqlite = makeSqlite(options);
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  return { sqlite, layer };
};

/** Runs `fn` once, just before a later batch (the next by default), to interleave another writer. */
const racing = () => {
  let race: (() => void) | undefined;
  let skip = 0;
  const { sqlite, layer } = setup({
    beforeBatch: () => {
      if (skip > 0) {
        skip--;
        return;
      }
      const run = race;
      race = undefined;
      run?.();
    },
  });
  const schedule = (fn: () => void, options?: { readonly skipBatches?: number }) => {
    skip = options?.skipBatches ?? 0;
    race = fn;
  };
  return { sqlite, layer, race: schedule };
};

const Person: EntitySchema = {
  fields: {
    name: { type: "string" },
    email: { type: "string" },
    tags: { type: "array", items: { type: "string" }, optional: true },
    age: { type: "number", optional: true },
  },
};

const byEmail = { name: "email", version: 1, key: "lower(trim(email))", unique: true };

const entries = (sqlite: ReturnType<typeof makeSqlite>) =>
  sqlite.database
    .prepare("SELECT name, value, entity_id FROM index_entries ORDER BY name, value, entity_id")
    .all()
    .map((row) => ({ ...row }));

const COUNT_QUERIES = {
  entities: "SELECT count(*) AS n FROM entities",
  entity_revisions: "SELECT count(*) AS n FROM entity_revisions",
  index_entries: "SELECT count(*) AS n FROM index_entries",
} as const;

const count = (sqlite: ReturnType<typeof makeSqlite>, table: keyof typeof COUNT_QUERIES) =>
  Number((sqlite.database.prepare(COUNT_QUERIES[table]).get() as { n: number }).n);

/** Insert entities straight into storage, as if written before the index existed. */
const insertRaw = (
  sqlite: ReturnType<typeof makeSqlite>,
  rows: ReadonlyArray<{ id: string; data: unknown; rev?: number }>,
) => {
  const insert = sqlite.database.prepare(
    "INSERT INTO entities (id, type, version, rev, data, deleted, created_at, updated_at) VALUES (?, 'person', 1, ?, ?, 0, 0, 0)",
  );
  sqlite.database.exec("BEGIN");
  for (const row of rows) {
    insert.run(row.id, row.rev ?? 1, JSON.stringify(row.data));
  }
  sqlite.database.exec("COMMIT");
};

const seed = Effect.gen(function* () {
  const store = yield* EntityStore;
  yield* store.createType({ name: "person", schema: Person });
  return store;
});

const ids = (page: { readonly items: ReadonlyArray<{ readonly id: string }> }) =>
  page.items.map((item) => item.id);

describe("index keys", () => {
  const compile = (key: string, unique = false) => {
    const expr = parse(key);
    if (Result.isFailure(expr)) throw new Error(expr.failure);
    return { expr: expr.success, unique };
  };

  it("computes string, absent, and array keys", () => {
    expect(indexKeys(compile("lower(email)"), { email: "A@X.com" })).toEqual(
      Result.succeed(["a@x.com"]),
    );
    expect(indexKeys(compile("email"), {})).toEqual(Result.succeed([]));
    expect(indexKeys(compile("email"), { email: null })).toEqual(Result.succeed([]));
    expect(indexKeys(compile("tags"), { tags: ["a", "b", "a", null] })).toEqual(
      Result.succeed(["a", "b"]),
    );
    expect(indexKeys(compile("string(age)"), { age: 42 })).toEqual(Result.succeed(["42"]));
  });

  it("rejects keys that aren't strings, arrays in unique indexes, and oversized keys", () => {
    expect(Result.isFailure(indexKeys(compile("age"), { age: 42 }))).toBe(true);
    expect(Result.isFailure(indexKeys(compile("tags", true), { tags: ["a"] }))).toBe(true);
    expect(Result.isFailure(indexKeys(compile("email"), { email: "x".repeat(2000) }))).toBe(true);
    expect(Result.isFailure(indexKeys(compile("upper(age)"), { age: 1 }))).toBe(true);
  });

  it("checks definitions against the pinned version's fields", () => {
    const check = (key: string) =>
      checkIndexDefinition({ name: "i", version: 1, key, unique: false }, Person);
    expect(Result.isSuccess(check("lower(email)"))).toBe(true);
    expect(check("lower(mail)")).toEqual(
      Result.fail([{ path: "key", message: "'mail' isn't a field of v1" }]),
    );
    expect(Result.isFailure(check("lower(email"))).toBe(true);
  });
});

describe("secondary indexes", () => {
  it.effect("looks entities up by a normalized unique key and follows changes", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      const created = yield* store.createIndex("person", byEmail);
      expect(created).toMatchObject({ name: "email", state: "ready", unique: true, version: 1 });

      yield* store.create("person", {
        id: "ada",
        version: 1,
        data: { name: "Ada", email: " Ada@Example.com " },
      });
      const found = yield* store.lookup("person", "email", "ada@example.com");
      expect(ids(found)).toEqual(["ada"]);
      expect(found.items[0]).toMatchObject({ data: { name: "Ada" } });

      // Unrelated edits don't touch the index; changing the key moves the entry.
      yield* store.patch("ada", { version: 1, patch: { name: "Ada L." } });
      yield* store.patch("ada", { version: 1, patch: { email: "ada@lovelace.org" } });
      expect(entries(sqlite)).toEqual([
        { name: "email", value: "ada@lovelace.org", entity_id: "ada" },
      ]);
      expect(ids(yield* store.lookup("person", "email", "ada@example.com"))).toEqual([]);

      // Deleting frees the key, so the address can be used again.
      yield* store.remove("ada");
      expect(entries(sqlite)).toEqual([]);
      yield* store.create("person", {
        id: "ada2",
        version: 1,
        data: { name: "Ada", email: "ada@lovelace.org" },
      });
      expect(ids(yield* store.lookup("person", "email", "ada@lovelace.org"))).toEqual(["ada2"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a second entity with the same unique key, with who holds it", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      yield* store.createIndex("person", byEmail);
      yield* store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a@x" } });
      yield* store.create("person", { id: "bob", version: 1, data: { name: "B", email: "b@x" } });

      const onCreate = yield* Effect.flip(
        store.create("person", { id: "eve", version: 1, data: { name: "E", email: "A@X" } }),
      );
      expect(onCreate).toMatchObject({
        _tag: "UniqueViolation",
        conflicts: [{ index: "email", key: "a@x", id: "ada" }],
      });
      const onPatch = yield* Effect.flip(
        store.patch("bob", { version: 1, patch: { email: "a@x" } }),
      );
      expect(onPatch).toMatchObject({ _tag: "UniqueViolation" });
      expect((yield* store.get("bob")).rev).toBe(1);
      expect(count(sqlite, "entity_revisions")).toBe(2);
      // Re-saving your own key is fine.
      yield* store.patch("ada", { version: 1, patch: { email: "A@x" } });
    }).pipe(Effect.provide(layer));
  });

  it.effect("the database refuses a unique key claimed after the check", () => {
    const { sqlite, layer, race } = racing();
    return Effect.gen(function* () {
      const store = yield* seed;
      yield* store.createIndex("person", byEmail);
      race(() =>
        sqlite.database
          .prepare(
            "INSERT INTO index_entries (type, name, value, entity_id, uniq) VALUES ('person', 'email', 'a@x', 'zed', 1)",
          )
          .run(),
      );
      const error = yield* Effect.flip(
        store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a@x" } }),
      );
      expect(error).toMatchObject({ _tag: "UniqueViolation", conflicts: [] });
      expect(count(sqlite, "entities")).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses writes whose key can't be computed", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.createIndex("person", { name: "age", version: 1, key: "age" });
      yield* store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a" } });
      const error = yield* Effect.flip(store.patch("ada", { version: 1, patch: { age: 36 } }));
      expect(error).toMatchObject({ _tag: "IndexKeyFailed", index: "age" });
      expect((yield* store.get("ada")).rev).toBe(1);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("indexes arrays element by element and pages through matches", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.createIndex("person", { name: "tag", version: 1, key: "tags" });
      for (const id of ["a", "b", "c"]) {
        yield* store.create("person", {
          id,
          version: 1,
          data: { name: id, email: id, tags: id === "b" ? ["other"] : ["x", "x", "y"] },
        });
      }
      const first = yield* store.lookup("person", "tag", "x", { limit: 1 });
      expect(ids(first)).toEqual(["a"]);
      const second = yield* store.lookup("person", "tag", "x", {
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(ids(second)).toEqual(["c"]);
      expect(second.nextCursor).toBeUndefined();
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("a pinned index keeps working as the schema evolves", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.createIndex("person", byEmail);
      yield* store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a@x" } });
      yield* store.addVersion("person", {
        schema: {
          fields: {
            name: { type: "string" },
            contact: { type: "string" },
            tags: { type: "array", items: { type: "string" }, optional: true },
            age: { type: "number", optional: true },
          },
        },
        lens: { ops: [{ op: "rename", from: "email", to: "contact" }] },
      });
      // Written at v2 (field renamed), keyed at v1 through the backward lens.
      yield* store.create("person", {
        id: "bob",
        version: 2,
        data: { name: "B", contact: "B@x" },
      });
      const page = yield* store.lookup("person", "email", "b@x");
      expect(page.items).toMatchObject([{ id: "bob", version: 2, data: { contact: "B@x" } }]);
      const old = yield* store.lookup("person", "email", "a@x", { version: 1 });
      expect(old.items).toMatchObject([{ id: "ada", version: 1, data: { email: "a@x" } }]);
      // A v2 writer can't take a key a v1 entity holds.
      const error = yield* Effect.flip(
        store.create("person", { id: "eve", version: 2, data: { name: "E", contact: "a@x" } }),
      );
      expect(error._tag).toBe("UniqueViolation");
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("backfills existing entities, finishing large types in later steps", () => {
    const { sqlite, layer } = setup();
    const total = BUILD_PAGE * SYNC_BUILD_PAGES + 7;
    return Effect.gen(function* () {
      const store = yield* seed;
      insertRaw(
        sqlite,
        Array.from({ length: total }, (_, i) => ({
          id: `p${String(i).padStart(5, "0")}`,
          data: { name: `p${i}`, email: `P${i}@x` },
        })),
      );
      const created = yield* store.createIndex("person", byEmail);
      expect(created.state).toBe("building");
      expect(yield* Effect.flip(store.lookup("person", "email", "p1@x"))).toMatchObject({
        _tag: "IndexNotReady",
        state: "building",
      });
      // Writers maintain a building index too.
      yield* store.create("person", { id: "zz", version: 1, data: { name: "z", email: "z@x" } });

      const [built] = yield* store.buildPendingIndexes({ steps: 5, maxIndexes: 4 });
      expect(built).toMatchObject({ name: "email", state: "ready" });
      expect(count(sqlite, "index_entries")).toBe(total + 1);
      expect(ids(yield* store.lookup("person", "email", `p${total - 1}@x`))).toEqual([
        `p${String(total - 1).padStart(5, "0")}`,
      ]);
      expect(ids(yield* store.lookup("person", "email", "z@x"))).toEqual(["zz"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a backfill that finds duplicates fails the index and clears it", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      insertRaw(sqlite, [
        { id: "ada", data: { name: "A", email: "a@x" } },
        { id: "bob", data: { name: "B", email: "A@X" } },
      ]);
      const failed = yield* store.createIndex("person", byEmail);
      expect(failed).toMatchObject({
        state: "failed",
        error: "'a@x' is the key of both ada and bob",
      });
      expect(count(sqlite, "index_entries")).toBe(0);
      expect(yield* Effect.flip(store.lookup("person", "email", "a@x"))).toMatchObject({
        _tag: "IndexNotReady",
        state: "failed",
      });
      // Failed indexes aren't maintained; fix the data, then drop and recreate.
      yield* store.patch("bob", { version: 1, patch: { email: "b@x" } });
      expect(count(sqlite, "index_entries")).toBe(0);
      expect(yield* Effect.flip(store.createIndex("person", byEmail))).toMatchObject({
        _tag: "IndexAlreadyExists",
      });
      yield* store.dropIndex("person", "email");
      expect((yield* store.createIndex("person", byEmail)).state).toBe("ready");
      expect(ids(yield* store.lookup("person", "email", "b@x"))).toEqual(["bob"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a backfill fails the index when an entity's key can't be computed", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      insertRaw(sqlite, [{ id: "ada", data: { name: "A", email: "a", age: 3 } }]);
      const failed = yield* store.createIndex("person", { name: "age", version: 1, key: "age" });
      expect(failed.state).toBe("failed");
      expect(failed.error).toMatch(/^entity 'ada': keys must be strings/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a write that raced an index's creation retries and maintains it", () => {
    const { sqlite, layer, race } = racing();
    return Effect.gen(function* () {
      const store = yield* seed;
      yield* store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a@x" } });
      // Another isolate defines the index after this write read the (empty) definitions.
      race(() => {
        sqlite.database.exec(
          "INSERT INTO entity_indexes (type, name, generation, version, key, is_unique, state, cursor, error, created_at, updated_at) VALUES ('person', 'email', 1, 1, 'lower(email)', 1, 'building', '', NULL, 0, 0); UPDATE entity_types SET indexes_rev = 1 WHERE name = 'person';",
        );
      });
      yield* store.patch("ada", { version: 1, patch: { name: "Ada" } });
      // Building indexes get every key written, even when it didn't change.
      expect(entries(sqlite)).toEqual([{ name: "email", value: "a@x", entity_id: "ada" }]);
      expect((yield* store.get("ada")).rev).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a create that raced an index's creation retries and maintains it", () => {
    const { sqlite, layer, race } = racing();
    return Effect.gen(function* () {
      const store = yield* seed;
      race(() => {
        sqlite.database.exec(
          "INSERT INTO entity_indexes (type, name, generation, version, key, is_unique, state, cursor, error, created_at, updated_at) VALUES ('person', 'email', 1, 1, 'email', 1, 'ready', '', NULL, 0, 0); UPDATE entity_types SET indexes_rev = 1 WHERE name = 'person';",
        );
      });
      yield* store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a@x" } });
      expect(entries(sqlite)).toEqual([{ name: "email", value: "a@x", entity_id: "ada" }]);
      expect(count(sqlite, "entity_revisions")).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the backfill skips entities written since it read them", () => {
    const { sqlite, layer, race } = racing();
    return Effect.gen(function* () {
      const store = yield* seed;
      insertRaw(sqlite, [
        { id: "ada", data: { name: "A", email: "a@x" } },
        { id: "bob", data: { name: "B", email: "b@x" } },
      ]);
      // bob moves on after the backfill read him but before its batch (the
      // first batch defines the index); his writer maintains his entry.
      race(
        () =>
          sqlite.database
            .prepare(
              `UPDATE entities SET rev = 2, data = '{"name":"B","email":"new@x"}' WHERE id = 'bob'`,
            )
            .run(),
        { skipBatches: 1 },
      );
      const built = yield* store.createIndex("person", byEmail);
      expect(built.state).toBe("ready");
      expect(entries(sqlite)).toEqual([{ name: "email", value: "a@x", entity_id: "ada" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("dropping an index removes its entries and writers stop maintaining it", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      yield* store.createIndex("person", byEmail);
      yield* store.create("person", { id: "ada", version: 1, data: { name: "A", email: "a@x" } });
      expect(yield* store.listIndexes("person")).toMatchObject([{ name: "email" }]);
      yield* store.dropIndex("person", "email");
      expect(count(sqlite, "index_entries")).toBe(0);
      yield* store.patch("ada", { version: 1, patch: { email: "b@x" } });
      expect(count(sqlite, "index_entries")).toBe(0);
      expect(yield* Effect.flip(store.lookup("person", "email", "b@x"))).toMatchObject({
        _tag: "IndexNotFound",
      });
      expect(yield* store.listIndexes("person")).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("validates definitions", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      expect(
        yield* Effect.flip(store.createIndex("person", { ...byEmail, key: "lower(mail)" })),
      ).toMatchObject({ _tag: "InvalidIndex" });
      expect(
        yield* Effect.flip(store.createIndex("person", { ...byEmail, version: 2 })),
      ).toMatchObject({ _tag: "VersionNotFound" });
      expect(yield* Effect.flip(store.createIndex("nobody", byEmail))).toMatchObject({
        _tag: "TypeNotFound",
      });
      for (let i = 0; i < 16; i++) {
        yield* store.createIndex("person", { name: `i${i}`, version: 1, key: "name" });
      }
      expect(
        yield* Effect.flip(
          store.createIndex("person", { name: "one-more", version: 1, key: "name" }),
        ),
      ).toMatchObject({ _tag: "InvalidIndex" });
    }).pipe(Effect.provide(setup().layer)),
  );
});
