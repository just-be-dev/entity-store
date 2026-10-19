import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Lens } from "../lens/model.ts";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { EntityStore, VersionCache } from "./store.ts";

const PersonV1: EntitySchema = {
  fields: {
    firstName: { type: "string", minLength: 1, pattern: "^\\S+$" },
    lastName: { type: "string", minLength: 1, pattern: "^\\S+$" },
    email: { type: "string", format: "email" },
  },
};
const PersonV2: EntitySchema = {
  fields: {
    fullName: { type: "string", minLength: 3, pattern: "^\\S+ \\S+$" },
    email: { type: "string", format: "email" },
    age: { type: "number", integer: true, min: 0, optional: true },
  },
};
const v1ToV2: Lens = {
  ops: [
    {
      op: "derive",
      forward: { fullName: "firstName + ' ' + lastName" },
      backward: {
        firstName: "split(fullName, ' ')[0]",
        lastName: "split(fullName, ' ')[1]",
      },
    },
    { op: "add", field: "age" },
  ],
};

const setup = (options?: Parameters<typeof makeSqlite>[0]) => {
  const sqlite = makeSqlite(options);
  const layer = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  return { sqlite, layer };
};

const withPeople = Effect.gen(function* () {
  const store = yield* EntityStore;
  yield* store.createType({ name: "person", schema: PersonV1 });
  const ada = yield* store.create("person", {
    id: "ada",
    version: 1,
    data: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  });
  return { store, ada };
});

const failureTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error._tag));

describe("entity store", () => {
  it.effect("creates types and entities, and reads them back", () =>
    Effect.gen(function* () {
      const { store, ada } = yield* withPeople;
      expect(ada).toMatchObject({ id: "ada", version: 1, storedVersion: 1, rev: 1 });
      const read = yield* store.get("ada");
      expect(read.data).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      });
      const generated = yield* store.create("person", {
        version: 1,
        data: { firstName: "Grace", lastName: "Hopper", email: "g@example.com" },
      });
      expect(generated.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("rejects invalid data, unknown fields, and duplicates", () =>
    Effect.gen(function* () {
      const { store } = yield* withPeople;
      expect(
        yield* failureTag(
          store.create("person", { version: 1, data: { firstName: "x", lastName: "y" } }),
        ),
      ).toBe("ValidationFailed");
      expect(
        yield* failureTag(
          store.create("person", {
            version: 1,
            data: { firstName: "x", lastName: "y", email: "a@b.co", extra: 1 },
          }),
        ),
      ).toBe("ValidationFailed");
      expect(
        yield* failureTag(
          store.create("person", {
            id: "ada",
            version: 1,
            data: { firstName: "A", lastName: "B", email: "a@b.co" },
          }),
        ),
      ).toBe("EntityAlreadyExists");
      expect(yield* failureTag(store.create("person", { version: 2, data: {} }))).toBe(
        "VersionNotFound",
      );
      expect(yield* failureTag(store.createType({ name: "person", schema: PersonV1 }))).toBe(
        "TypeAlreadyExists",
      );
      expect(
        yield* failureTag(
          store.createType({ name: "bad", schema: { fields: { "not ok": { type: "string" } } } }),
        ),
      ).toBe("InvalidSchema");
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("records every write in history with the writer's version", () =>
    Effect.gen(function* () {
      const { store } = yield* withPeople;
      yield* store.patch("ada", { version: 1, patch: { email: "ada@lovelace.org" } });
      yield* store.replace("ada", {
        version: 1,
        data: { firstName: "Augusta", lastName: "King", email: "ada@lovelace.org" },
      });
      yield* store.remove("ada");
      expect(yield* failureTag(store.get("ada"))).toBe("EntityDeleted");

      const history = yield* store.history("ada");
      expect(history.items.map((r) => [r.rev, r.op])).toEqual([
        [4, "delete"],
        [3, "replace"],
        [2, "patch"],
        [1, "create"],
      ]);
      expect(history.items[2]?.data).toMatchObject({ email: "ada@lovelace.org" });

      const old = yield* store.get("ada", { rev: 1 });
      expect(old.data).toMatchObject({ email: "ada@example.com" });

      const paged = yield* store.history("ada", { limit: 2 });
      expect(paged.items.map((r) => r.rev)).toEqual([4, 3]);
      expect(paged.nextBefore).toBe(3);
      const rest = yield* store.history("ada", { limit: 2, before: 3 });
      expect(rest.items.map((r) => r.rev)).toEqual([2, 1]);
      expect(rest.nextBefore).toBeUndefined();
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("refuses a version whose lens fails the check, unless forced", () =>
    Effect.gen(function* () {
      const { store } = yield* withPeople;
      const broken: Lens = { ops: [] };
      expect(
        yield* failureTag(store.addVersion("person", { schema: PersonV2, lens: broken })),
      ).toBe("LensCheckFailed");
      const check = yield* store.checkVersion("person", { schema: PersonV2, lens: v1ToV2 });
      expect(check.report.ok).toBe(true);
      expect(check.report.existing.checked).toBe(1);
      const added = yield* store.addVersion("person", { schema: PersonV2, lens: v1ToV2 });
      expect(added.version.version).toBe(2);
      expect((yield* store.getType("person")).latestVersion).toBe(2);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("lenses old data on read and serves old readers new data", () =>
    Effect.gen(function* () {
      const { store } = yield* withPeople;
      yield* store.addVersion("person", { schema: PersonV2, lens: v1ToV2 });

      const latest = yield* store.get("ada");
      expect(latest).toMatchObject({ version: 2, storedVersion: 1 });
      expect(latest.data).toEqual({ fullName: "Ada Lovelace", email: "ada@example.com" });

      const grace = yield* store.create("person", {
        id: "grace",
        version: 2,
        data: { fullName: "Grace Hopper", email: "g@example.com", age: 85 },
      });
      expect(grace.storedVersion).toBe(2);
      const asV1 = yield* store.get("grace", { version: 1 });
      expect(asV1.data).toEqual({ firstName: "Grace", lastName: "Hopper", email: "g@example.com" });

      const page = yield* store.list("person", { version: 1 });
      expect(page.items.map((e) => e.id)).toEqual(["ada", "grace"]);
      expect(page.failures).toEqual([]);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("an old writer's edit keeps fields it can't see", () =>
    Effect.gen(function* () {
      const { store } = yield* withPeople;
      yield* store.addVersion("person", { schema: PersonV2, lens: v1ToV2 });
      yield* store.create("person", {
        id: "grace",
        version: 2,
        data: { fullName: "Grace Hopper", email: "g@example.com", age: 85 },
      });

      const edited = yield* store.patch("grace", { version: 1, patch: { lastName: "Murray" } });
      expect(edited).toMatchObject({ version: 1, storedVersion: 2 });
      expect(edited.data).toEqual({
        firstName: "Grace",
        lastName: "Murray",
        email: "g@example.com",
      });

      const now = yield* store.get("grace");
      expect(now.data).toEqual({ fullName: "Grace Murray", email: "g@example.com", age: 85 });

      const [latest] = (yield* store.history("grace")).items;
      expect(latest).toMatchObject({ op: "patch", writerVersion: 1, storedVersion: 2 });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("a new writer migrates stored data forward", () =>
    Effect.gen(function* () {
      const { store } = yield* withPeople;
      yield* store.addVersion("person", { schema: PersonV2, lens: v1ToV2 });
      const edited = yield* store.patch("ada", { version: 2, patch: { age: 36 } });
      expect(edited).toMatchObject({ storedVersion: 2, rev: 2 });
      expect((yield* store.get("ada", { version: 1 })).data).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      });
      // History keeps the v1 snapshot; it is lensed to whatever version is asked for.
      const history = yield* store.history("ada", { version: 2 });
      expect(history.items.map((r) => r.storedVersion)).toEqual([2, 1]);
      expect(history.items[1]?.data).toEqual({
        fullName: "Ada Lovelace",
        email: "ada@example.com",
      });
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("optimistic concurrency: stale expectedRev fails, blind writes retry", () => {
    let interleave: (() => void) | undefined;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        const run = interleave;
        interleave = undefined;
        run?.();
      },
    });
    return Effect.gen(function* () {
      const { store } = yield* withPeople;
      const stale = yield* Effect.flip(
        store.patch("ada", { version: 1, expectedRev: 7, patch: { firstName: "X" } }),
      );
      expect(stale).toMatchObject({ _tag: "RevConflict", expectedRev: 7, currentRev: 1 });

      // Another writer commits rev 2 between our read and our batch.
      const bumpEmail = () => {
        sqlite.database
          .prepare(
            "UPDATE entities SET rev = 2, data = json_set(data, '$.email', 'other@x.io') WHERE id = 'ada'",
          )
          .run();
        sqlite.database
          .prepare(
            "INSERT INTO entity_revisions SELECT id, rev, version, 1, 'patch', data, updated_at FROM entities WHERE id = 'ada'",
          )
          .run();
      };
      interleave = bumpEmail;
      const lost = yield* Effect.flip(
        store.patch("ada", { version: 1, expectedRev: 1, patch: { firstName: "X" } }),
      );
      expect(lost._tag).toBe("RevConflict");

      interleave = () => {
        sqlite.database.prepare("UPDATE entities SET rev = 3 WHERE id = 'ada'").run();
        sqlite.database
          .prepare(
            "INSERT INTO entity_revisions SELECT id, rev, version, 1, 'patch', data, updated_at FROM entities WHERE id = 'ada'",
          )
          .run();
      };
      const retried = yield* store.patch("ada", { version: 1, patch: { firstName: "Augusta" } });
      expect(retried.rev).toBe(4);
      // The retry re-read the entity, so the concurrent email change survived.
      expect(retried.data).toMatchObject({ firstName: "Augusta", email: "other@x.io" });
      const revs = (yield* store.history("ada")).items.map((r) => r.rev);
      expect(revs).toEqual([4, 3, 2, 1]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a failed batch leaves neither the entity nor history changed", () => {
    let fail = false;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        if (fail) {
          // Poison the revision insert so the second statement fails.
          sqlite.database.exec(
            "CREATE TRIGGER poison BEFORE INSERT ON entity_revisions BEGIN SELECT RAISE(ABORT, 'boom'); END",
          );
        }
      },
    });
    return Effect.gen(function* () {
      const { store } = yield* withPeople;
      fail = true;
      const error = yield* Effect.flip(
        store.patch("ada", { version: 1, patch: { firstName: "X" } }),
      );
      expect(error._tag).toBe("StorageFailure");
      fail = false;
      sqlite.database.exec("DROP TRIGGER poison");
      expect((yield* store.get("ada")).rev).toBe(1);
      expect((yield* store.history("ada")).items).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("paginates lists by id", () =>
    Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: { fields: { text: { type: "string" } } } });
      for (const id of ["a", "b", "c", "d", "e"]) {
        yield* store.create("note", { id, version: 1, data: { text: id } });
      }
      yield* store.remove("c");
      const first = yield* store.list("note", { limit: 2 });
      expect(first.items.map((e) => e.id)).toEqual(["a", "b"]);
      const second = yield* store.list("note", { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((e) => e.id)).toEqual(["d", "e"]);
      expect(second.nextCursor).toBeUndefined();
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("reports projection failures per item instead of failing the page", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const { store } = yield* withPeople;
      yield* store.addVersion("person", { schema: PersonV2, lens: v1ToV2 });
      // Data that slipped past validation (e.g. written before a bug fix).
      sqlite.database
        .prepare("UPDATE entities SET data = '{\"firstName\":\"Ada\"}' WHERE id = 'ada'")
        .run();
      const page = yield* store.list("person");
      expect(page.items).toEqual([]);
      expect(page.failures[0]).toMatchObject({ id: "ada", storedVersion: 1 });
      expect(page.failures[0]?.error).toMatch(/Lens failed|doesn't match/);
    }).pipe(Effect.provide(layer));
  });
});
