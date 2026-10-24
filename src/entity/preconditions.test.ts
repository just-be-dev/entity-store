import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Lens } from "../lens/model.ts";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { errorBody } from "./errors.ts";
import { VersionConflict } from "./model.ts";
import { EntityStore, VersionCache } from "./store.ts";

const NoteV1: EntitySchema = { fields: { text: { type: "string" } } };
const NoteV2: EntitySchema = {
  fields: { text: { type: "string" }, tag: { type: "string", optional: true } },
};
const addTag: Lens = { ops: [{ op: "add", field: "tag" }] };
const NoteV3: EntitySchema = {
  fields: { body: { type: "string" }, tag: { type: "string", optional: true } },
};
const renameText: Lens = { ops: [{ op: "rename", from: "text", to: "body" }] };

/** A store whose next batch first runs `interleave`, as another writer would. */
const setup = () => {
  let interleave: (() => void) | undefined;
  const sqlite = makeSqlite({
    beforeBatch: () => {
      const run = interleave;
      interleave = undefined;
      run?.();
    },
  });
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  /** Another writer's v2 of `note`, committed straight to the database. */
  const addV2Behind = () => {
    interleave = () =>
      sqlite.database.exec(
        `INSERT INTO schema_versions (type, version, schema, lens, note, created_at) VALUES ('note', 2, '${JSON.stringify(NoteV2)}', '${JSON.stringify(addTag)}', '', 0);
         UPDATE entity_types SET latest_version = 2 WHERE name = 'note'`,
      );
  };
  return { sqlite, layer, addV2Behind };
};

const versions = (sqlite: ReturnType<typeof makeSqlite>) =>
  Number(sqlite.database.prepare("SELECT count(*) AS n FROM schema_versions").get()?.["n"]);

describe("expectedVersion on version writes", () => {
  it.effect("adds and checks a version from the version the author read", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      const checked = yield* store.checkVersion("note", {
        schema: NoteV2,
        lens: addTag,
        expectedVersion: 1,
      });
      expect(checked).toMatchObject({ from: 1, to: 2, report: { ok: true } });
      const added = yield* store.addVersion("note", {
        schema: NoteV2,
        lens: addTag,
        expectedVersion: 1,
      });
      expect(added.version.version).toBe(2);
      // Omitted, it's still "whatever is latest".
      const next = yield* store.addVersion("note", { schema: NoteV3, lens: renameText });
      expect(next.version.version).toBe(3);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("refuses a stale expectedVersion before checking the lens", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      yield* store.addVersion("note", { schema: NoteV2, lens: addTag });
      // This lens doesn't fit v2 (it renames a field v2 lacks): a stale
      // request is refused before the lens is compiled or property-checked.
      const broken: Lens = { ops: [{ op: "rename", from: "missing", to: "body" }] };
      const attempts: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        store.addVersion("note", { schema: NoteV3, lens: broken, expectedVersion: 1 }),
        store.checkVersion("note", { schema: NoteV3, lens: broken, expectedVersion: 1 }),
      ];
      for (const attempt of attempts) {
        const error = yield* Effect.flip(attempt);
        expect(error).toMatchObject({
          _tag: "VersionConflict",
          type: "note",
          expected: 1,
          currentVersion: 2,
        });
      }
      // At the current version, the same lens gets as far as the check.
      const current = yield* Effect.flip(
        store.addVersion("note", { schema: NoteV3, lens: broken, expectedVersion: 2 }),
      );
      expect(current._tag).toBe("LensCheckFailed");
      expect(versions(sqlite)).toBe(2);
      expect((yield* store.getType("note")).latestVersion).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a version added between the check and the batch fails the write", () => {
    const { sqlite, layer, addV2Behind } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      addV2Behind();
      const error = yield* Effect.flip(
        store.addVersion("note", { schema: NoteV2, lens: addTag, expectedVersion: 1 }),
      );
      expect(error).toMatchObject({ _tag: "VersionConflict", expected: 1, currentVersion: 2 });
      expect(versions(sqlite)).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it("presents VersionConflict with the current version", () => {
    const conflict = { type: "note", expected: 1 };
    expect(errorBody(new VersionConflict({ ...conflict, currentVersion: 3 }))).toEqual({
      code: "VersionConflict",
      message: "note is at v3, not v1; reload and try again",
      type: "note",
      expected: 1,
      currentVersion: 3,
    });
    expect(errorBody(new VersionConflict(conflict))).toEqual({
      code: "VersionConflict",
      message: "Another version of note was added first; reload and try again",
      type: "note",
      expected: 1,
    });
  });
});

describe("expectedVersion on deleteType", () => {
  it.effect("deletes at the expected version and refuses a stale one", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      yield* store.addVersion("note", { schema: NoteV2, lens: addTag });
      expect(yield* Effect.flip(store.deleteType("note", { expectedVersion: 1 }))).toMatchObject({
        _tag: "VersionConflict",
        type: "note",
        expected: 1,
        currentVersion: 2,
      });
      expect(versions(sqlite)).toBe(2);
      expect(yield* store.deleteType("note", { expectedVersion: 2 })).toEqual({ name: "note" });
      expect(versions(sqlite)).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a stale expectedVersion wins over TypeInUse", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      yield* store.create("note", { id: "a", data: { text: "a" } });
      expect((yield* Effect.flip(store.deleteType("note", { expectedVersion: 2 })))._tag).toBe(
        "VersionConflict",
      );
      expect((yield* Effect.flip(store.deleteType("note", { expectedVersion: 1 })))._tag).toBe(
        "TypeInUse",
      );
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("a version added between the check and the batch keeps the type", () => {
    const { sqlite, layer, addV2Behind } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      addV2Behind();
      expect(yield* Effect.flip(store.deleteType("note", { expectedVersion: 1 }))).toMatchObject({
        _tag: "VersionConflict",
        expected: 1,
        currentVersion: 2,
      });
      expect((yield* store.getType("note")).versions).toHaveLength(2);
      expect(versions(sqlite)).toBe(2);
      expect(yield* store.deleteType("note", { expectedVersion: 2 })).toEqual({ name: "note" });
    }).pipe(Effect.provide(layer));
  });
});
