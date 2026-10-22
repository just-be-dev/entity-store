import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Identity } from "../auth/identity.ts";
import { SqlDatabase, SqlError } from "../entity/sql.ts";
import { EntityStore, VersionCache } from "../entity/store.ts";
import { makeSqlite } from "../testing/sqlite.ts";
import type { RpcResult } from "./entityStoreRpc.ts";
import { RPC_PRINCIPAL, entityStoreRpc as rpc } from "./entityStoreRpc.ts";

const storeOn = (sql: Layer.Layer<SqlDatabase>) =>
  EntityStore.layer.pipe(Layer.provide(Layer.mergeAll(sql, VersionCache.layer)));

const layer = () => Layer.mergeAll(storeOn(makeSqlite().layer), Identity.as(RPC_PRINCIPAL));

/** What crosses the binding: structured clone of plain JSON loses nothing. */
const wire = <A>(result: RpcResult<A>) => {
  expect(structuredClone(result)).toEqual(result);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  return result;
};

const ok = <A>(effect: Effect.Effect<RpcResult<A>, never, any>) =>
  Effect.map(effect as Effect.Effect<RpcResult<A>>, (result) => {
    wire(result);
    if (!result.ok) {
      throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    }
    return result.value;
  });

const err = <A>(effect: Effect.Effect<RpcResult<A>, never, any>) =>
  Effect.map(effect as Effect.Effect<RpcResult<A>>, (result) => {
    wire(result);
    if (result.ok) {
      throw new Error("expected an error");
    }
    return result.error;
  });

const person = { fields: { name: { type: "string" } }, title: "name" };

describe("EntityStoreRpc", () => {
  it.effect("returns values as plain JSON results", () =>
    Effect.gen(function* () {
      const created = yield* ok(rpc.createType({ name: "person", schema: person }));
      expect(created).toMatchObject({ name: "person", latestVersion: 1 });
      expect((yield* ok(rpc.listTypes())).map((t) => t.name)).toEqual(["person"]);

      const ada = yield* ok(
        rpc.createEntity("person", {
          id: "ada@example.com",
          data: { name: "Ada" },
          meta: { depth: 1 },
        }),
      );
      expect(ada).toMatchObject({ id: "ada@example.com", version: 1, rev: 1 });
      const upserted = yield* ok(
        rpc.upsertEntity("person", "ada@example.com", { patch: { name: "A" } }),
      );
      expect(upserted).toMatchObject({ created: false, entity: { rev: 2 } });
      expect(yield* ok(rpc.getEntity("ada@example.com", { rev: 1 }))).toMatchObject({
        data: { name: "Ada" },
      });
      expect((yield* ok(rpc.listEntities("person", { limit: 10 }))).items).toHaveLength(1);
      expect(yield* ok(rpc.getChange("ada@example.com", 2))).toMatchObject({
        op: "patch",
        before: { name: "Ada" },
        after: { name: "A" },
        meta: null,
      });
      const changes = yield* ok(rpc.listChanges({ after: 0 }));
      expect(changes.items.map((c) => [c.seq, c.op, c.meta])).toEqual([
        [1, "create", { depth: 1 }],
        [2, "patch", null],
      ]);
      expect(yield* ok(rpc.deleteEntity("ada@example.com", { expectedRev: 2 }))).toEqual({
        id: "ada@example.com",
        rev: 3,
      });
      expect(yield* ok(rpc.deleteType("person"))).toEqual({ name: "person" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("returns domain errors with the HTTP API's codes and details", () =>
    Effect.gen(function* () {
      yield* ok(rpc.createType({ name: "person", schema: person }));
      yield* ok(rpc.createType({ name: "note", schema: { fields: { text: { type: "string" } } } }));
      yield* ok(rpc.createEntity("person", { id: "ada", data: { name: "Ada" } }));

      expect(yield* err(rpc.getEntity("nope"))).toMatchObject({
        code: "EntityNotFound",
        message: "No entity with id 'nope'",
      });
      expect(yield* err(rpc.patchEntity("ada", { patch: { name: "B" }, expectedRev: 5 }))).toEqual({
        code: "RevConflict",
        message: "Entity 'ada' is at rev 1, not 5",
        currentRev: 1,
      });
      expect(yield* err(rpc.upsertEntity("note", "ada", { patch: { text: "x" } }))).toMatchObject({
        code: "EntityTypeMismatch",
        id: "ada",
        type: "note",
        actual: "person",
      });
      expect(yield* err(rpc.deleteType("person"))).toMatchObject({
        code: "TypeInUse",
        type: "person",
        reasons: ["it has 1 live entity"],
      });
      expect(yield* err(rpc.createEntity("person", { data: { name: 1 } }))).toMatchObject({
        code: "ValidationFailed",
      });
      expect(yield* err(rpc.getChange("ada", 9))).toMatchObject({ code: "ChangeNotFound" });
      const report = yield* err(
        rpc.createVersion("person", {
          schema: { fields: { other: { type: "string" } } },
          lens: { ops: [] },
        }),
      );
      expect(report).toMatchObject({ code: "LensCheckFailed", report: { ok: false } });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects malformed arguments as BadRequest", () =>
    Effect.gen(function* () {
      yield* ok(rpc.createType({ name: "person", schema: person }));
      const calls: ReadonlyArray<Effect.Effect<RpcResult<unknown>, never, EntityStore | Identity>> =
        [
          rpc.createType({ name: "1bad", schema: person }),
          rpc.createEntity("person", { data: { name: "A" }, meta: { pad: "x".repeat(2000) } }),
          rpc.createEntity("person", { data: { name: "A" }, version: 0 }),
          rpc.upsertEntity("person", "has space", { patch: {} }),
          rpc.upsertEntity("person", "..", { patch: { name: "A" } }),
          rpc.createEntity("person", { id: ".", data: { name: "A" } }),
          rpc.upsertEntity("person", "ok", { patch: [] }),
          rpc.getEntity(42),
          rpc.getChange("ada", 0),
          rpc.listChanges({ after: -1 }),
          rpc.listEntities("person", { index: "email" }),
          rpc.deleteEntity("ada", "soon"),
        ];
      for (const call of calls) {
        expect((yield* err(call)).code).toBe("BadRequest");
      }
    }).pipe(Effect.provide(layer())),
  );

  it.effect("acts as the rpc service binding, and needs a principal", () =>
    Effect.gen(function* () {
      expect(RPC_PRINCIPAL).toEqual({ _tag: "ServiceBinding", name: "rpc" });
      expect(yield* err(rpc.listTypes())).toMatchObject({ code: "Unauthenticated" });
    }).pipe(Effect.provide(Layer.mergeAll(storeOn(makeSqlite().layer), Identity.anonymous))),
  );

  it.effect("never throws: storage errors and defects come back as StorageFailure", () => {
    const failing = Layer.succeed(
      SqlDatabase,
      SqlDatabase.of({
        all: () => Effect.die(new Error("bug")),
        batch: () => Effect.die(new Error("unexpected")),
      }),
    );
    const broken = Layer.succeed(
      SqlDatabase,
      SqlDatabase.of({
        all: () => Effect.fail(new SqlError({ message: "disk full", constraint: false })),
        batch: () => Effect.die(new Error("unexpected")),
      }),
    );
    return Effect.gen(function* () {
      const defect = yield* err(rpc.listTypes()).pipe(
        Effect.provide(Layer.mergeAll(storeOn(failing), Identity.as(RPC_PRINCIPAL))),
      );
      expect(defect).toEqual({ code: "StorageFailure", message: "Storage error" });
      const storage = yield* err(rpc.getType("person")).pipe(
        Effect.provide(Layer.mergeAll(storeOn(broken), Identity.as(RPC_PRINCIPAL))),
      );
      expect(storage).toEqual({ code: "StorageFailure", message: "Storage error" });
    });
  });
});
