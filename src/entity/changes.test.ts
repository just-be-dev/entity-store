import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Lens } from "../lens/model.ts";
import type { EntitySchema } from "../schema/model.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import { ChangeDelivery, ChangeQueue, ChangeQueueError, FLUSH_BATCH } from "./changes.ts";
import type { ChangeEvent } from "./model.ts";
import { ChangeMeta } from "./model.ts";
import { EntityStore, VersionCache } from "./store.ts";

const NoteV1: EntitySchema = { fields: { text: { type: "string" } } };
const NoteV2: EntitySchema = {
  fields: { body: { type: "string" }, pinned: { type: "boolean", optional: true } },
};
const v1ToV2: Lens = {
  ops: [
    { op: "rename", from: "text", to: "body" },
    { op: "add", field: "pinned" },
  ],
};

/** A queue that records what it accepted and fails while `failing` is set. */
const makeQueue = () => {
  const state = {
    sent: [] as Array<ReadonlyArray<ChangeEvent>>,
    failing: false,
    onSend: undefined as (() => void) | undefined,
  };
  const service = ChangeQueue.of({
    sendBatch: (events) =>
      Effect.suspend(() => {
        state.onSend?.();
        if (state.failing) {
          return Effect.fail(new ChangeQueueError({ message: "queue unavailable" }));
        }
        state.sent.push(events);
        return Effect.void;
      }),
  });
  return { state, layer: Layer.succeed(ChangeQueue, service) };
};

const setup = (options?: Parameters<typeof makeSqlite>[0]) => {
  const sqlite = makeSqlite(options);
  const queue = makeQueue();
  const store = EntityStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, VersionCache.layer)),
  );
  const delivery = ChangeDelivery.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite.layer, queue.layer)),
  );
  return { sqlite, queue, layer: Layer.mergeAll(store, delivery) };
};

const changeRows = (sqlite: ReturnType<typeof makeSqlite>) =>
  sqlite.database
    .prepare("SELECT seq, entity_id, rev, op, meta FROM entity_changes ORDER BY seq")
    .all();

const cursor = (sqlite: ReturnType<typeof makeSqlite>) =>
  Number(
    sqlite.database.prepare("SELECT after_seq FROM change_delivery WHERE name = 'queue'").get()?.[
      "after_seq"
    ],
  );

describe("change feed", () => {
  it.effect("every write records exactly one change, with its meta", () => {
    const { sqlite, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      yield* store.create("note", { id: "n", data: { text: "a" }, meta: { depth: 1 } });
      yield* store.replace("n", { data: { text: "b" } });
      yield* store.patch("n", { patch: { text: "c" }, meta: { depth: 2, sourceEventId: "e1" } });
      yield* store.upsert("note", "n", { patch: { text: "d" } });
      yield* store.remove("n", { meta: { changeId: "c9" } });
      // Deleting a deleted entity writes nothing, so it records nothing.
      yield* store.remove("n");
      yield* store.upsert("note", "n", { patch: { text: "again" } });

      expect(changeRows(sqlite)).toEqual([
        { seq: 1, entity_id: "n", rev: 1, op: "create", meta: '{"depth":1}' },
        { seq: 2, entity_id: "n", rev: 2, op: "replace", meta: null },
        { seq: 3, entity_id: "n", rev: 3, op: "patch", meta: '{"depth":2,"sourceEventId":"e1"}' },
        { seq: 4, entity_id: "n", rev: 4, op: "patch", meta: null },
        { seq: 5, entity_id: "n", rev: 5, op: "delete", meta: '{"changeId":"c9"}' },
        { seq: 6, entity_id: "n", rev: 6, op: "create", meta: null },
      ]);
      const revisions = sqlite.database
        .prepare("SELECT rev, op FROM entity_revisions WHERE entity_id = 'n' ORDER BY rev")
        .all();
      expect(revisions.map((r) => [r["rev"], r["op"]])).toEqual(
        changeRows(sqlite).map((c) => [c["rev"], c["op"]]),
      );

      const page = yield* store.listChanges({ after: 1, limit: 2 });
      expect(page.items.map((c) => c.seq)).toEqual([2, 3]);
      expect(page.nextAfter).toBe(3);
      expect(page.items[1]).toEqual({
        v: 1,
        seq: 3,
        type: "note",
        id: "n",
        rev: 3,
        op: "patch",
        meta: { depth: 2, sourceEventId: "e1" },
        createdAt: 0,
      });
      const last = yield* store.listChanges({ after: 5 });
      expect(last.items.map((c) => c.seq)).toEqual([6]);
      expect(last.nextAfter).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a change commits if and only if its write does", () => {
    let poison: string | undefined;
    const { sqlite, layer } = setup({
      beforeBatch: () => {
        if (poison !== undefined) {
          sqlite.database.exec(
            `CREATE TRIGGER poison BEFORE ${poison} BEGIN SELECT RAISE(ABORT, 'boom'); END`,
          );
          poison = undefined;
        }
      },
    });
    const unpoison = () => sqlite.database.exec("DROP TRIGGER IF EXISTS poison");
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      yield* store.create("note", { id: "n", data: { text: "a" } });

      // Whichever statement of the batch fails, before or after the change
      // row, neither the write nor its change is kept.
      for (const [table, onPatch] of [
        ["entity_revisions", "INSERT"],
        ["entities", "UPDATE"],
        ["entity_changes", "INSERT"],
      ] as const) {
        poison = `${onPatch} ON ${table}`;
        const failed = yield* Effect.flip(store.patch("n", { patch: { text: table } }));
        expect(failed._tag).toBe("StorageFailure");
        unpoison();
        poison = `INSERT ON ${table}`;
        const create = yield* Effect.flip(
          store.create("note", { id: `x-${table}`, data: { text: "x" } }),
        );
        expect(create._tag).toBe("StorageFailure");
        unpoison();
      }
      // A write refused by the store's own rules records nothing either.
      yield* Effect.flip(store.patch("n", { expectedRev: 9, patch: { text: "stale" } }));
      yield* Effect.flip(store.create("note", { id: "n", data: { text: "dup" } }));

      expect((yield* store.get("n")).rev).toBe(1);
      expect(changeRows(sqlite)).toEqual([
        { seq: 1, entity_id: "n", rev: 1, op: "create", meta: null },
      ]);
      expect((yield* store.get("n", { rev: 1 })).data).toEqual({ text: "a" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("getChange returns before and after, lensed to any version", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      yield* store.createType({ name: "note", schema: NoteV1 });
      yield* store.create("note", { id: "n", data: { text: "a" }, meta: { depth: 0 } });
      yield* store.addVersion("note", { schema: NoteV2, lens: v1ToV2 });
      yield* store.patch("n", { version: 2, patch: { pinned: true } });
      yield* store.remove("n");
      yield* store.upsert("note", "n", { version: 1, patch: { text: "back" } });

      const created = yield* store.getChange("n", 1);
      expect(created).toMatchObject({
        v: 1,
        seq: 1,
        type: "note",
        id: "n",
        rev: 1,
        op: "create",
        meta: { depth: 0 },
        version: 2,
        before: null,
        after: { body: "a" },
      });
      // Stored at v1 then v2; presented at either.
      expect(yield* store.getChange("n", 2)).toMatchObject({
        op: "patch",
        version: 2,
        before: { body: "a" },
        after: { body: "a", pinned: true },
      });
      expect(yield* store.getChange("n", 2, { version: 1 })).toMatchObject({
        version: 1,
        before: { text: "a" },
        after: { text: "a" },
      });
      expect(yield* store.getChange("n", 3)).toMatchObject({
        op: "delete",
        before: { body: "a", pinned: true },
        after: null,
      });
      // Recreated after a delete: nothing before it.
      expect(yield* store.getChange("n", 4)).toMatchObject({
        op: "create",
        before: null,
        after: { body: "back" },
      });

      expect((yield* Effect.flip(store.getChange("n", 5)))._tag).toBe("ChangeNotFound");
      expect((yield* Effect.flip(store.getChange("nope", 1)))._tag).toBe("ChangeNotFound");
      expect((yield* Effect.flip(store.getChange("n", 1, { version: 3 })))._tag).toBe(
        "VersionNotFound",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("meta is a JSON object of at most 1 KB", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownResult(ChangeMeta);
      const sized = (bytes: number) => ({ pad: "x".repeat(bytes - '{"pad":""}'.length) });
      expect(Result.isSuccess(decode(sized(1024)))).toBe(true);
      expect(Result.isFailure(decode(sized(1025)))).toBe(true);
      // Multi-byte characters count as bytes, not characters.
      expect(Result.isFailure(decode({ pad: "é".repeat(600) }))).toBe(true);
      expect(Result.isFailure(decode([1]))).toBe(true);
      expect(Result.isFailure(decode("depth"))).toBe(true);
    }),
  );
});

describe("change delivery", () => {
  it.effect("sends changes after the cursor, and a failed send skips nothing", () => {
    const { sqlite, queue, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      const delivery = yield* ChangeDelivery;
      yield* store.createType({ name: "note", schema: NoteV1 });
      expect(yield* delivery.flush({ maxBatches: 5 })).toEqual({ sent: 0, after: 0 });

      for (const id of ["a", "b", "c"]) {
        yield* store.create("note", { id, data: { text: id } });
      }
      queue.state.failing = true;
      expect((yield* Effect.flip(delivery.flush({ maxBatches: 5 })))._tag).toBe("ChangeQueueError");
      expect(cursor(sqlite)).toBe(0);

      yield* store.patch("a", { patch: { text: "a2" } });
      queue.state.failing = false;
      expect(yield* delivery.flush({ maxBatches: 5 })).toEqual({ sent: 4, after: 4 });
      expect(queue.state.sent.flat().map((e) => [e.seq, e.id, e.rev, e.op])).toEqual([
        [1, "a", 1, "create"],
        [2, "b", 1, "create"],
        [3, "c", 1, "create"],
        [4, "a", 2, "patch"],
      ]);
      expect(cursor(sqlite)).toBe(4);

      // Nothing new: nothing sent.
      expect(yield* delivery.flush({ maxBatches: 5 })).toEqual({ sent: 0, after: 4 });
      expect(queue.state.sent).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends in batches of 100, up to maxBatches per flush", () => {
    const { sqlite, queue, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      const delivery = yield* ChangeDelivery;
      yield* store.createType({ name: "note", schema: NoteV1 });
      for (let i = 0; i < 2 * FLUSH_BATCH + 50; i++) {
        yield* store.create("note", { id: `n${String(i).padStart(3, "0")}`, data: { text: "x" } });
      }
      expect(yield* delivery.flush({ maxBatches: 2 })).toEqual({ sent: 200, after: 200 });
      expect(queue.state.sent.map((batch) => batch.length)).toEqual([100, 100]);
      expect(yield* delivery.flush({ maxBatches: 2 })).toEqual({ sent: 50, after: 250 });
      const seqs = queue.state.sent.flat().map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
      expect(cursor(sqlite)).toBe(250);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a flusher that loses the cursor race stops and never moves it back", () => {
    const { sqlite, queue, layer } = setup();
    return Effect.gen(function* () {
      const store = yield* EntityStore;
      const delivery = yield* ChangeDelivery;
      yield* store.createType({ name: "note", schema: NoteV1 });
      for (const id of ["a", "b", "c"]) {
        yield* store.create("note", { id, data: { text: id } });
      }
      // Another flusher sends and advances further while this one is sending.
      queue.state.onSend = () => {
        queue.state.onSend = undefined;
        sqlite.database.prepare("UPDATE change_delivery SET after_seq = 3").run();
      };
      const result = yield* delivery.flush({ maxBatches: 5 });
      expect(result).toEqual({ sent: 3, after: 0 });
      expect(cursor(sqlite)).toBe(3);
    }).pipe(Effect.provide(layer));
  });
});
