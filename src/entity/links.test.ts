import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { EntityStore, VersionCache } from "./store.ts";

const setup = (options?: Parameters<typeof makeSqlite>[0]) => {
  const sqlite = makeSqlite(options);
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  return { sqlite, layer };
};

const Person: EntitySchema = {
  fields: {
    name: { type: "string" },
    manager: { type: "nullable", of: { type: "link", to: "person" } },
  },
};
const Post: EntitySchema = {
  fields: {
    title: { type: "string" },
    author: { type: "link", to: "person" },
    reviewers: { type: "array", items: { type: "link", to: "person" } },
    meta: { type: "object", fields: { editor: { type: "link", to: "person", optional: true } } },
  },
};

const seed = Effect.gen(function* () {
  const store = yield* EntityStore;
  yield* store.createType({ name: "person", schema: Person });
  yield* store.createType({ name: "post", schema: Post });
  for (const id of ["ada", "grace", "alan"]) {
    yield* store.create("person", { id, version: 1, data: { name: id, manager: null } });
  }
  return store;
});

const linkRows = (sqlite: ReturnType<typeof makeSqlite>) =>
  sqlite.database
    .prepare("SELECT source, path, target FROM entity_links ORDER BY source, path, target")
    .all();

describe("links between entities", () => {
  it.effect("schemas may only link to existing types or themselves", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const error = yield* Effect.flip(store.createType({ name: "post", schema: Post }));
      expect(error).toMatchObject({ _tag: "InvalidSchema" });
      yield* store.createType({ name: "person", schema: Person });
      yield* store.createType({ name: "post", schema: Post });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("checks targets on write with readable problems", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      yield* store.create("post", {
        id: "p0",
        version: 1,
        data: { title: "x", author: "ada", reviewers: [], meta: {} },
      });
      const error = yield* Effect.flip(
        store.create("post", {
          id: "p1",
          version: 1,
          data: { title: "x", author: "nobody", reviewers: ["grace", "p0"], meta: {} },
        }),
      );
      expect(error).toMatchObject({
        _tag: "LinkTargetInvalid",
        problems: [
          { path: "author", target: "nobody", message: "no entity 'nobody'" },
          { path: "reviewers[]", target: "p0", message: "'p0' is a post, not a person" },
        ],
      });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("maintains the link index only when links change", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      yield* store.create("post", {
        id: "p1",
        version: 1,
        data: { title: "x", author: "ada", reviewers: ["grace", "alan", "grace"], meta: {} },
      });
      expect(linkRows(sqlite)).toEqual([
        { source: "p1", path: "author", target: "ada" },
        { source: "p1", path: "reviewers[]", target: "alan" },
        { source: "p1", path: "reviewers[]", target: "grace" },
      ]);
      yield* store.patch("p1", { version: 1, patch: { title: "y" } });
      yield* store.patch("p1", {
        version: 1,
        patch: { author: "grace", reviewers: ["alan"], meta: { editor: "ada" } },
      });
      expect(linkRows(sqlite)).toEqual([
        { source: "p1", path: "author", target: "grace" },
        { source: "p1", path: "meta.editor", target: "ada" },
        { source: "p1", path: "reviewers[]", target: "alan" },
      ]);
      const back = yield* store.backlinks("grace");
      expect(back.items).toEqual([{ source: "p1", type: "post", path: "author" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to delete a linked entity, and unlinks on delete", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* seed;
      yield* store.patch("grace", { version: 1, patch: { manager: "grace" } });
      yield* store.create("post", {
        id: "p1",
        version: 1,
        data: { title: "x", author: "ada", reviewers: [], meta: {} },
      });
      const refused = yield* Effect.flip(store.remove("ada"));
      expect(refused).toMatchObject({
        _tag: "EntityLinked",
        id: "ada",
        linkedFrom: [{ source: "p1", type: "post", path: "author" }],
      });
      // A self-link doesn't block deleting yourself.
      yield* store.remove("grace");
      yield* store.remove("p1");
      expect(linkRows(sqlite)).toEqual([]);
      yield* store.remove("ada");
      expect(yield* Effect.flip(store.get("ada"))).toMatchObject({ _tag: "EntityDeleted" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("allows linking to an entity being created (self-links)", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const me = yield* store.create("person", {
        id: "self",
        version: 1,
        data: { name: "me", manager: "self" },
      });
      expect(me.data).toMatchObject({ manager: "self" });
      expect((yield* store.backlinks("self")).items).toEqual([
        { source: "self", type: "person", path: "manager" },
      ]);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("the database refuses a link to a target deleted after the check", () => {
    let race: (() => void) | undefined;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        const run = race;
        race = undefined;
        run?.();
      },
    });
    return Effect.gen(function* () {
      const store = yield* seed;
      race = () =>
        sqlite.database.prepare("UPDATE entities SET deleted = 1 WHERE id = 'ada'").run();
      const error = yield* Effect.flip(
        store.create("post", {
          id: "p1",
          version: 1,
          data: { title: "x", author: "ada", reviewers: [], meta: {} },
        }),
      );
      expect(error._tag).toBe("LinkTargetInvalid");
      expect(
        sqlite.database.prepare("SELECT count(*) AS n FROM entities WHERE id = 'p1'").get(),
      ).toEqual({ n: 0 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("the database refuses a delete when a link appears after the check", () => {
    let race: (() => void) | undefined;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        const run = race;
        race = undefined;
        run?.();
      },
    });
    return Effect.gen(function* () {
      const store = yield* seed;
      race = () =>
        sqlite.database
          .prepare("INSERT INTO entity_links VALUES ('grace', 'manager', 'ada', 'person')")
          .run();
      const error = yield* Effect.flip(store.remove("ada", { expectedRev: 1 }));
      expect(error._tag).toBe("EntityLinked");
      expect((yield* store.get("ada")).rev).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves links for reading, at each target's latest version", () =>
    Effect.gen(function* () {
      const store = yield* seed;
      const post = yield* store.create("post", {
        id: "p1",
        version: 1,
        data: { title: "x", author: "ada", reviewers: ["alan"], meta: {} },
      });
      const included = yield* store.resolveLinks([post]);
      expect(Object.keys(included).sort()).toEqual(["ada", "alan"]);
      expect(included["ada"]).toMatchObject({ type: "person", data: { name: "ada" } });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("an old writer's edit keeps links its version can't see", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "person", schema: { fields: { name: { type: "string" } } } });
      yield* store.create("person", { id: "ada", version: 1, data: { name: "Ada" } });
      yield* store.createType({ name: "note", schema: { fields: { text: { type: "string" } } } });
      yield* store.addVersion("note", {
        schema: {
          fields: {
            text: { type: "string" },
            about: { type: "link", to: "person", optional: true },
          },
        },
        lens: { ops: [{ op: "add", field: "about" }] },
      });
      yield* store.create("note", { id: "n1", version: 2, data: { text: "hi", about: "ada" } });
      yield* store.patch("n1", { version: 1, patch: { text: "hello" } });
      expect((yield* store.get("n1")).data).toEqual({ text: "hello", about: "ada" });
      expect(linkRows(sqlite)).toEqual([{ source: "n1", path: "about", target: "ada" }]);
    }).pipe(Effect.provide(layer));
  });
});
