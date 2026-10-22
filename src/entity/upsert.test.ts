import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { EntityStore, VersionCache } from "./store.ts";

const Person: EntitySchema = {
  title: "name",
  fields: {
    name: { type: "string", minLength: 1 },
    email: { type: "string", optional: true },
    address: {
      type: "object",
      optional: true,
      fields: { city: { type: "string" }, zip: { type: "string", optional: true } },
    },
  },
};

const setup = (options?: Parameters<typeof makeSqlite>[0]) => {
  const sqlite = makeSqlite(options);
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  return { sqlite, layer };
};

const withTypes = Effect.gen(function* () {
  const store = yield* EntityStore;
  yield* store.createType({ name: "person", schema: Person });
  yield* store.createType({ name: "note", schema: { fields: { text: { type: "string" } } } });
  return store;
});

describe("upsert", () => {
  it.effect("creates a missing entity from the patch, dropping nulls", () =>
    Effect.gen(function* () {
      const store = yield* withTypes;
      const result = yield* store.upsert("person", "ada@example.com", {
        patch: { name: "Ada", email: null, address: { city: "London", zip: null } },
      });
      expect(result.created).toBe(true);
      expect(result.entity).toMatchObject({
        id: "ada@example.com",
        type: "person",
        version: 1,
        rev: 1,
        data: { name: "Ada", address: { city: "London" } },
      });
      expect((yield* store.history("ada@example.com")).items.map((r) => r.op)).toEqual(["create"]);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("merge-patches a live entity", () =>
    Effect.gen(function* () {
      const store = yield* withTypes;
      yield* store.upsert("person", "ada", {
        patch: { name: "Ada", email: "a@x.io", address: { city: "London", zip: "N1" } },
      });
      const result = yield* store.upsert("person", "ada", {
        patch: { email: null, address: { zip: "W1" } },
      });
      expect(result.created).toBe(false);
      expect(result.entity).toMatchObject({
        rev: 2,
        data: { name: "Ada", address: { city: "London", zip: "W1" } },
      });
      expect((yield* store.history("ada")).items.map((r) => r.op)).toEqual(["patch", "create"]);
      // The patch is validated: removing a required field fails.
      const invalid = yield* Effect.flip(store.upsert("person", "ada", { patch: { name: null } }));
      expect(invalid._tag).toBe("ValidationFailed");
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("recreates a tombstone of the same type at the next rev, from the patch alone", () =>
    Effect.gen(function* () {
      const store = yield* withTypes;
      yield* store.upsert("person", "ada", { patch: { name: "Ada", email: "a@x.io" } });
      yield* store.remove("ada");
      const result = yield* store.upsert("person", "ada", { patch: { name: "Ada again" } });
      expect(result.created).toBe(true);
      // Nothing of the deleted data comes back.
      expect(result.entity).toMatchObject({ rev: 3, data: { name: "Ada again" } });
      expect((yield* store.get("ada")).data).toEqual({ name: "Ada again" });
      expect((yield* store.history("ada")).items.map((r) => [r.rev, r.op])).toEqual([
        [3, "create"],
        [2, "delete"],
        [1, "create"],
      ]);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("fails with EntityTypeMismatch for an id of another type, live or deleted", () =>
    Effect.gen(function* () {
      const store = yield* withTypes;
      yield* store.create("note", { id: "n1", data: { text: "x" } });
      expect(
        yield* Effect.flip(store.upsert("person", "n1", { patch: { name: "A" } })),
      ).toMatchObject({ _tag: "EntityTypeMismatch", id: "n1", type: "person", actual: "note" });
      yield* store.remove("n1");
      expect(
        (yield* Effect.flip(store.upsert("person", "n1", { patch: { name: "A" } })))._tag,
      ).toBe("EntityTypeMismatch");
      // A missing type is reported as such.
      expect((yield* Effect.flip(store.upsert("nope", "z", { patch: {} })))._tag).toBe(
        "TypeNotFound",
      );
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("expectedRev: 0 means missing or deleted; others must match the live rev", () =>
    Effect.gen(function* () {
      const store = yield* withTypes;
      const conflict = (rev: number, patch: object) =>
        Effect.flip(store.upsert("person", "ada", { expectedRev: rev, patch }));

      // Missing: only 0 is accepted.
      expect(yield* conflict(1, { name: "A" })).toMatchObject({
        _tag: "RevConflict",
        expectedRev: 1,
        currentRev: 0,
      });
      const created = yield* store.upsert("person", "ada", {
        expectedRev: 0,
        patch: { name: "A" },
      });
      expect(created).toMatchObject({ created: true, entity: { rev: 1 } });

      // Live at rev 1: 0 and stale revs fail; the current rev applies.
      expect(yield* conflict(0, { name: "B" })).toMatchObject({
        _tag: "RevConflict",
        expectedRev: 0,
        currentRev: 1,
      });
      expect(yield* conflict(2, { name: "B" })).toMatchObject({ currentRev: 1 });
      const patched = yield* store.upsert("person", "ada", {
        expectedRev: 1,
        patch: { name: "B" },
      });
      expect(patched).toMatchObject({ created: false, entity: { rev: 2, data: { name: "B" } } });

      // Deleted at rev 3: it has no live rev, so only 0 recreates it.
      yield* store.remove("ada");
      expect(yield* conflict(3, { name: "C" })).toMatchObject({ currentRev: 0 });
      expect(yield* conflict(2, { name: "C" })).toMatchObject({ currentRev: 0 });
      const revived = yield* store.upsert("person", "ada", {
        expectedRev: 0,
        patch: { name: "C" },
      });
      expect(revived).toMatchObject({ created: true, entity: { rev: 4 } });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.live(
    "a create that loses the race to another writer fails with expectedRev, retries without",
    () => {
      let interleave: (() => void) | undefined;
      const { sqlite, layer } = setup({
        beforeBatch: () => {
          const run = interleave;
          interleave = undefined;
          run?.();
        },
      });
      const insertOther = (id: string) => () => {
        sqlite.database
          .prepare(
            'INSERT INTO entities (id, type, version, rev, data, deleted, created_at, updated_at) VALUES (?, \'person\', 1, 1, \'{"name":"Other","email":"o@x.io"}\', 0, 0, 0)',
          )
          .run(id);
        sqlite.database
          .prepare(
            "INSERT INTO entity_revisions SELECT id, rev, version, 1, 'create', data, updated_at FROM entities WHERE id = ?",
          )
          .run(id);
      };
      return Effect.gen(function* () {
        const store = yield* withTypes;
        interleave = insertOther("a");
        const lost = yield* Effect.flip(
          store.upsert("person", "a", { expectedRev: 0, patch: { name: "Mine" } }),
        );
        expect(lost).toMatchObject({ _tag: "RevConflict", expectedRev: 0, currentRev: 1 });
        expect((yield* store.get("a")).data).toMatchObject({ name: "Other" });

        // Without expectedRev the upsert retries, finds the entity, and patches it.
        interleave = insertOther("b");
        const retried = yield* store.upsert("person", "b", { patch: { name: "Mine" } });
        expect(retried).toMatchObject({
          created: false,
          entity: { rev: 2, data: { name: "Mine", email: "o@x.io" } },
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "writes default to the latest version as of the write; named versions stay pinned",
    () =>
      Effect.gen(function* () {
        const store = yield* withTypes;
        const created = yield* store.create("note", { id: "n", data: { text: "a" } });
        expect(created).toMatchObject({ version: 1, storedVersion: 1 });
        yield* store.addVersion("note", {
          schema: { fields: { body: { type: "string" }, tag: { type: "string", optional: true } } },
          lens: {
            ops: [
              { op: "rename", from: "text", to: "body" },
              { op: "add", field: "tag" },
            ],
          },
        });
        const patched = yield* store.patch("n", { patch: { tag: "t" } });
        expect(patched).toMatchObject({
          version: 2,
          storedVersion: 2,
          data: { body: "a", tag: "t" },
        });
        // An old writer still speaks v1, and its change keeps the field it can't see.
        const old = yield* store.replace("n", { version: 1, data: { text: "b" } });
        expect(old).toMatchObject({ version: 1, storedVersion: 2, data: { text: "b" } });
        expect((yield* store.get("n")).data).toEqual({ body: "b", tag: "t" });
        const upserted = yield* store.upsert("note", "m", { patch: { body: "new" } });
        expect(upserted.entity).toMatchObject({ version: 2, data: { body: "new" } });
        expect(
          (yield* Effect.flip(store.upsert("note", "k", { patch: { text: "v1 shape" } })))._tag,
        ).toBe("ValidationFailed");
      }).pipe(Effect.provide(setup().layer)),
  );
});
