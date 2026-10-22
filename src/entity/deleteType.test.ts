import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { EntityStore, VersionCache } from "./store.ts";

const Note: EntitySchema = { fields: { text: { type: "string" } } };
const Post: EntitySchema = {
  fields: {
    title: { type: "string" },
    author: { type: "nullable", of: { type: "link", to: "author" } },
  },
};

const setup = (options?: Parameters<typeof makeSqlite>[0]) => {
  const sqlite = makeSqlite(options);
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  return { sqlite, layer };
};

const count = (sqlite: ReturnType<typeof makeSqlite>, table: string) =>
  Number(sqlite.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);

describe("deleteType", () => {
  it.effect("refuses while the type has live entities", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: Note });
      yield* store.create("note", { id: "a", data: { text: "a" } });
      yield* store.create("note", { id: "b", data: { text: "b" } });
      expect(yield* Effect.flip(store.deleteType("note"))).toMatchObject({
        _tag: "TypeInUse",
        type: "note",
        reasons: ["it has 2 live entities"],
      });
      yield* store.remove("a");
      expect(yield* Effect.flip(store.deleteType("note"))).toMatchObject({
        reasons: ["it has 1 live entity"],
      });
      expect(count(sqlite, "entities")).toBe(2);
      expect((yield* Effect.flip(store.deleteType("nope")))._tag).toBe("TypeNotFound");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses while another type's latest schema links to it, not an older one", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "author", schema: { fields: { name: { type: "string" } } } });
      yield* store.createType({ name: "post", schema: Post });
      expect(yield* Effect.flip(store.deleteType("author"))).toMatchObject({
        reasons: ["post's latest schema (v1) links to it"],
      });
      // A field named `to` isn't a link.
      yield* store.createType({
        name: "memo",
        schema: { fields: { to: { type: "string" }, author: { type: "string" } } },
      });
      // post v2 drops the link: only older versions mention author now.
      yield* store.addVersion("post", {
        schema: { fields: { title: { type: "string" } } },
        lens: { ops: [{ op: "remove", field: "author", default: null }] },
      });
      expect(yield* store.deleteType("author")).toEqual({ name: "author" });
      // A type linking to itself can be deleted.
      yield* store.createType({
        name: "tree",
        schema: { fields: { parent: { type: "nullable", of: { type: "link", to: "tree" } } } },
      });
      expect(yield* store.deleteType("tree")).toEqual({ name: "tree" });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("removes the type, its versions, indexes, tombstones, revisions and changes", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: Note });
      yield* store.createType({ name: "other", schema: Note });
      yield* store.createIndex("note", { name: "text", version: 1, key: "text" });
      yield* store.create("note", { id: "a", data: { text: "a" } });
      yield* store.patch("a", { patch: { text: "b" } });
      yield* store.remove("a");
      yield* store.create("other", { id: "keep", data: { text: "k" } });

      expect(yield* store.deleteType("note")).toEqual({ name: "note" });
      for (const [table, left] of [
        ["entity_types", 1],
        ["schema_versions", 1],
        ["entity_indexes", 0],
        ["index_entries", 0],
        ["entities", 1],
        ["entity_revisions", 1],
        ["entity_changes", 1],
      ] as const) {
        expect([table, count(sqlite, table)]).toEqual([table, left]);
      }
      expect((yield* Effect.flip(store.getType("note")))._tag).toBe("TypeNotFound");
      expect((yield* store.get("keep")).data).toEqual({ text: "k" });
      // The id is free again, even for another type.
      expect((yield* store.create("other", { id: "a", data: { text: "new" } })).rev).toBe(1);
      expect((yield* store.getChange("a", 1)).type).toBe("other");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a type created again under the same name never sees the old one's cached versions",
    () =>
      Effect.gen(function* () {
        const store = yield* EntityStore;
        yield* store.createType({ name: "note", schema: Note });
        yield* store.createIndex("note", { name: "text", version: 1, key: "text", unique: true });
        // Warm this isolate's caches with the old type's v1 and index definitions.
        yield* store.create("note", { id: "a", data: { text: "a" } });
        expect((yield* store.get("a")).data).toEqual({ text: "a" });
        yield* store.remove("a");
        yield* store.deleteType("note");

        yield* store.createType({
          name: "note",
          schema: { fields: { title: { type: "string" }, n: { type: "number" } } },
        });
        expect(
          (yield* Effect.flip(store.create("note", { id: "b", data: { text: "x" } })))._tag,
        ).toBe("ValidationFailed");
        const b = yield* store.create("note", { id: "b", data: { title: "t", n: 1 } });
        expect((yield* store.get(b.id)).data).toEqual({ title: "t", n: 1 });
        // The old unique index is gone, so a second entity may share the title.
        yield* store.create("note", { id: "c", data: { title: "t", n: 2 } });
        expect((yield* store.list("note")).items.map((e) => e.id)).toEqual(["b", "c"]);
      }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("an entity created between the check and the batch keeps the type", () => {
    let interleave: (() => void) | undefined;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        const run = interleave;
        interleave = undefined;
        run?.();
      },
    });
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: Note });
      interleave = () =>
        sqlite.database
          .prepare(
            "INSERT INTO entities (id, type, version, rev, data, deleted, created_at, updated_at) VALUES ('late', 'note', 1, 1, '{\"text\":\"x\"}', 0, 0, 0)",
          )
          .run();
      expect(yield* Effect.flip(store.deleteType("note"))).toMatchObject({
        _tag: "TypeInUse",
        reasons: ["it has 1 live entity"],
      });
      expect((yield* store.getType("note")).versions).toHaveLength(1);
      expect((yield* store.get("late")).data).toEqual({ text: "x" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a schema write fails if a type it links to is deleted before its batch", () => {
    let interleave: (() => void) | undefined;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        const run = interleave;
        interleave = undefined;
        run?.();
      },
    });
    const deleteAuthor = () =>
      sqlite.database.exec(
        "DELETE FROM schema_versions WHERE type = 'author'; DELETE FROM entity_types WHERE name = 'author'",
      );
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "author", schema: { fields: { name: { type: "string" } } } });
      interleave = deleteAuthor;
      expect(yield* Effect.flip(store.createType({ name: "post", schema: Post }))).toMatchObject({
        _tag: "InvalidSchema",
        issues: [{ message: "Links point at 'author', which isn't an entity type" }],
      });
      expect(count(sqlite, "entity_types")).toBe(0);
      expect(count(sqlite, "schema_versions")).toBe(0);

      yield* store.createType({ name: "author", schema: { fields: { name: { type: "string" } } } });
      yield* store.createType({ name: "post", schema: { fields: { title: { type: "string" } } } });
      interleave = deleteAuthor;
      const added = yield* Effect.flip(
        store.addVersion("post", {
          schema: Post,
          lens: { ops: [{ op: "add", field: "author", default: null }] },
        }),
      );
      expect(added._tag).toBe("InvalidSchema");
      expect((yield* store.getType("post")).latestVersion).toBe(1);
      expect(count(sqlite, "schema_versions")).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
