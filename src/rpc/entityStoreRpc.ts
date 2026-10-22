import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Principal } from "../auth/identity.ts";
import { Identity } from "../auth/identity.ts";
import { errorBody } from "../entity/errors.ts";
import {
  AddVersionBody,
  CheckVersionBody,
  CreateEntityBody,
  CreateTypeBody,
  DeleteBody,
  PatchBody,
  ReplaceBody,
  UpsertBody,
} from "../entity/inputs.ts";
import type { StoreError } from "../entity/model.ts";
import { EntityId, Rev } from "../entity/model.ts";
import { EntityStore } from "../entity/store.ts";
import { TypeName, Version } from "../schema/model.ts";

/**
 * The entity store as RPC methods for other Workers, called over a service
 * binding. Holding the binding is the authorization: calls act as
 * {@link RPC_PRINCIPAL}. Every method takes and returns plain JSON and
 * never throws for domain errors. It returns a {@link RpcResult} whose
 * error `code` is the same string the HTTP API uses. Unexpected failures
 * come back as `StorageFailure`.
 *
 * The API Worker serves these on its default entrypoint. Alchemy's Effect
 * Workers (2.0.0-beta.83) only export the default entrypoint, Durable
 * Objects, and Workflows from the bundle, so a named `EntityStoreRpc`
 * WorkerEntrypoint class would be dropped.
 */

export type RpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: RpcError };

export interface RpcError {
  readonly code: string;
  readonly message: string;
  readonly [detail: string]: unknown;
}

export const RPC_PRINCIPAL: Principal = { _tag: "ServiceBinding", name: "rpc" };

/** An argument didn't decode. Reported with the HTTP API's code for malformed input. */
class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {}

const decode = <S extends Schema.Codec<any, unknown>>(schema: S, what: string, value: unknown) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(value, { errors: "all" }),
    (error) => new BadRequest({ message: `Invalid ${what}: ${error.message}` }),
  ) as Effect.Effect<S["Type"], BadRequest>;

/** An optional trailing options argument; `undefined` means none. */
const options = <S extends Schema.Codec<any, unknown>>(schema: S, value: unknown) =>
  value === undefined ? Effect.succeed({} as S["Type"]) : decode(schema, "options", value);

const Limit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const ListEntitiesOptions = Schema.Struct({
  version: Schema.optionalKey(Version),
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Limit),
  index: Schema.optionalKey(Schema.String),
  eq: Schema.optionalKey(Schema.String),
});

const GetEntityOptions = Schema.Struct({
  version: Schema.optionalKey(Version),
  rev: Schema.optionalKey(Rev),
});

const GetChangeOptions = Schema.Struct({ version: Schema.optionalKey(Version) });

const ListChangesOptions = Schema.Struct({
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Limit),
});

const failure = (error: StoreError | BadRequest | Unauthenticated): RpcError => {
  switch (error._tag) {
    case "BadRequest":
      return { code: "BadRequest", message: error.message };
    case "Unauthenticated":
      return { code: "Unauthenticated", message: "This call has no principal" };
    default:
      return errorBody(error);
  }
};

const run = <A, R>(
  name: string,
  effect: Effect.Effect<A, StoreError | BadRequest | Unauthenticated, R>,
): Effect.Effect<RpcResult<A>, never, R | Identity> =>
  Effect.gen(function* () {
    const identity = yield* Identity;
    if (Option.isNone(identity.principal)) {
      return yield* new Unauthenticated();
    }
    return yield* effect;
  }).pipe(
    Effect.map((value): RpcResult<A> => ({ ok: true, value })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (error._tag === "StorageFailure") {
          // Log the method name only; storage messages can echo data.
          yield* Effect.logError("Storage failure", { method: name });
        }
        return { ok: false, error: failure(error) } satisfies RpcResult<A>;
      }),
    ),
    Effect.catchCause(() =>
      Effect.as(Effect.logError("Unexpected RPC failure", { method: name }), {
        ok: false,
        error: { code: "StorageFailure", message: "Storage error" },
      } satisfies RpcResult<A>),
    ),
    Effect.withSpan(`EntityStoreRpc.${name}`),
  );

/** The methods that write entities: each records a change to deliver. */
export const RPC_WRITES: ReadonlySet<string> = new Set([
  "createEntity",
  "replaceEntity",
  "patchEntity",
  "upsertEntity",
  "deleteEntity",
]);

/** Every RPC method. Arguments are untrusted and decoded with Schema. */
export const entityStoreRpc = {
  listTypes: () =>
    run(
      "listTypes",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        return yield* store.listTypes();
      }),
    ),

  getType: (name: unknown) =>
    run(
      "getType",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        return yield* store.getType(yield* decode(Schema.String, "type name", name));
      }),
    ),

  createType: (input: unknown) =>
    run(
      "createType",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        return yield* store.createType(yield* decode(CreateTypeBody, "type", input));
      }),
    ),

  checkVersion: (type: unknown, input: unknown) =>
    run(
      "checkVersion",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const name = yield* decode(Schema.String, "type name", type);
        const body = yield* decode(CheckVersionBody, "version", input);
        return yield* store.checkVersion(
          name,
          body,
          body.samples === undefined ? undefined : { samples: body.samples },
        );
      }),
    ),

  createVersion: (type: unknown, input: unknown) =>
    run(
      "createVersion",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const name = yield* decode(Schema.String, "type name", type);
        return yield* store.addVersion(name, yield* decode(AddVersionBody, "version", input));
      }),
    ),

  deleteType: (name: unknown) =>
    run(
      "deleteType",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        return yield* store.deleteType(yield* decode(Schema.String, "type name", name));
      }),
    ),

  listEntities: (type: unknown, input?: unknown) =>
    run(
      "listEntities",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const name = yield* decode(Schema.String, "type name", type);
        const { index, eq, ...page } = yield* options(ListEntitiesOptions, input);
        if ((index === undefined) !== (eq === undefined)) {
          return yield* new BadRequest({ message: "index and eq go together" });
        }
        return index === undefined || eq === undefined
          ? yield* store.list(name, page)
          : yield* store.lookup(name, index, eq, page);
      }),
    ),

  getEntity: (id: unknown, input?: unknown) =>
    run(
      "getEntity",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const entityId = yield* decode(Schema.String, "entity id", id);
        return yield* store.get(entityId, yield* options(GetEntityOptions, input));
      }),
    ),

  createEntity: (type: unknown, input: unknown) =>
    run(
      "createEntity",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const name = yield* decode(TypeName, "type name", type);
        return yield* store.create(name, yield* decode(CreateEntityBody, "entity", input));
      }),
    ),

  replaceEntity: (id: unknown, input: unknown) =>
    run(
      "replaceEntity",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const entityId = yield* decode(Schema.String, "entity id", id);
        return yield* store.replace(entityId, yield* decode(ReplaceBody, "replacement", input));
      }),
    ),

  patchEntity: (id: unknown, input: unknown) =>
    run(
      "patchEntity",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const entityId = yield* decode(Schema.String, "entity id", id);
        return yield* store.patch(entityId, yield* decode(PatchBody, "patch", input));
      }),
    ),

  upsertEntity: (type: unknown, id: unknown, input: unknown) =>
    run(
      "upsertEntity",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const name = yield* decode(TypeName, "type name", type);
        const entityId = yield* decode(EntityId, "entity id", id);
        return yield* store.upsert(name, entityId, yield* decode(UpsertBody, "upsert", input));
      }),
    ),

  deleteEntity: (id: unknown, input?: unknown) =>
    run(
      "deleteEntity",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const entityId = yield* decode(Schema.String, "entity id", id);
        return yield* store.remove(entityId, yield* options(DeleteBody, input));
      }),
    ),

  getChange: (id: unknown, rev: unknown, input?: unknown) =>
    run(
      "getChange",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        const entityId = yield* decode(Schema.String, "entity id", id);
        const at = yield* decode(Rev, "rev", rev);
        return yield* store.getChange(entityId, at, yield* options(GetChangeOptions, input));
      }),
    ),

  listChanges: (input?: unknown) =>
    run(
      "listChanges",
      Effect.gen(function* () {
        const store = yield* EntityStore;
        return yield* store.listChanges(yield* options(ListChangesOptions, input));
      }),
    ),
};

export type EntityStoreRpc = typeof entityStoreRpc;
