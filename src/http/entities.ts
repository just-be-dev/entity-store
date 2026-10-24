import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { StoreError } from "../entity/model.ts";
import {
  AddVersionBody,
  CheckEntityBody,
  CheckVersionBody,
  CreateEntityBody,
  CreateTypeBody,
  DeleteBody,
  DeleteTypeBody,
  PatchBody,
  ReplaceBody,
  UpsertBody,
} from "../entity/inputs.ts";
import { EntityId, IndexName } from "../entity/model.ts";
import { EntityStore, SYNC_BUILD_PAGES } from "../entity/store.ts";
import { compileLens } from "../lens/apply.ts";
import { BUILTINS } from "../lens/expr.ts";
import { Direction, Lens } from "../lens/model.ts";
import { checkDefinition, compile } from "../schema/compile.ts";
import { EntitySchema, Version } from "../schema/model.ts";
import { requirePrincipal } from "./auth.ts";
import {
  BadRequest,
  body,
  intParam,
  json,
  optionalBody,
  rawParam,
  respond,
  stringParam,
} from "./response.ts";

const CreateIndexBody = Schema.Struct({
  name: IndexName,
  version: Version,
  key: Schema.String.check(Schema.isMaxLength(4000)),
  unique: Schema.optionalKey(Schema.Boolean),
});

const RunLensBody = Schema.Struct({ lens: Lens, direction: Direction, doc: Schema.Json });

const pathParam = (name: string) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const value = params[name];
    if (value === undefined || value === "") {
      return yield* new BadRequest({ status: 400, message: `Missing ${name}` });
    }
    // The router has already percent-decoded path parameters.
    return value;
  });

/** The `:id` path parameter, which must be a valid entity id (it may be created). */
const entityIdParam = Effect.gen(function* () {
  const id = yield* pathParam("id");
  if (!Schema.is(EntityId)(id)) {
    return yield* new BadRequest({
      status: 400,
      message: "Entity ids use letters, digits, '_', '-', '.' or '@' (max 128), not only dots",
    });
  }
  return id;
});

/** `?include=links` adds `included`: the linked entities, keyed by id. */
const includeLinks = () =>
  Effect.gen(function* () {
    const include = yield* stringParam("include");
    if (include === undefined) {
      return false;
    }
    if (include !== "links") {
      return yield* new BadRequest({ status: 400, message: "include must be 'links'" });
    }
    return true;
  });

/**
 * Every entity-store route requires a verified principal. Any principal may
 * use every operation: Cloudflare Access is the allowlist (see
 * docs/cloudflare.md), so there's no finer-grained authorization yet.
 */
const route = <E extends StoreError | BadRequest, R>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: `/api/${string}`,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => HttpRouter.add(method, path, respond(Effect.andThen(requirePrincipal, handler)));

export const entityRoutes = Layer.mergeAll(
  // ── Types and schema versions ──
  route(
    "GET",
    "/api/types",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json({ items: yield* store.listTypes() });
    }),
  ),
  route(
    "POST",
    "/api/types",
    Effect.gen(function* () {
      const input = yield* body(CreateTypeBody);
      const store = yield* EntityStore;
      return json(yield* store.createType(input), 201);
    }),
  ),
  route(
    "GET",
    "/api/types/:type",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(yield* store.getType(yield* pathParam("type")));
    }),
  ),
  route(
    "GET",
    "/api/types/:type/versions/:version",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const version = Number(yield* pathParam("version"));
      if (!Number.isSafeInteger(version) || version < 1) {
        return yield* new BadRequest({
          status: 400,
          message: "version must be a positive integer",
        });
      }
      const info = yield* store.getVersion(yield* pathParam("type"), version);
      // Effect generates standard JSON Schema from the compiled schema, for clients and forms.
      const jsonSchema = Schema.toJsonSchemaDocument(compile(info.schema));
      return json({ ...info, jsonSchema });
    }),
  ),
  route(
    "DELETE",
    "/api/types/:type",
    Effect.gen(function* () {
      const input = yield* optionalBody(DeleteTypeBody);
      const store = yield* EntityStore;
      return json(
        yield* store.deleteType(yield* pathParam("type"), {
          expectedVersion: input?.expectedVersion ?? (yield* intParam("expectedVersion")),
        }),
      );
    }),
  ),
  route(
    "POST",
    "/api/types/:type/versions/check",
    Effect.gen(function* () {
      const input = yield* body(CheckVersionBody);
      const store = yield* EntityStore;
      const checked = yield* store.checkVersion(
        yield* pathParam("type"),
        input,
        input.samples === undefined ? undefined : { samples: input.samples },
      );
      return json(checked);
    }),
  ),
  route(
    "POST",
    "/api/types/:type/versions",
    Effect.gen(function* () {
      const input = yield* body(AddVersionBody);
      const store = yield* EntityStore;
      return json(yield* store.addVersion(yield* pathParam("type"), input), 201);
    }),
  ),

  // ── Entities ──
  route(
    "GET",
    "/api/types/:type/entities",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const type = yield* pathParam("type");
      const options = {
        version: yield* intParam("version"),
        cursor: yield* stringParam("cursor"),
        limit: yield* intParam("limit"),
      };
      const index = yield* stringParam("index");
      const eq = yield* rawParam("eq");
      if ((index === undefined) !== (eq === undefined)) {
        return yield* new BadRequest({
          status: 400,
          message: "index and eq go together: ?index=<name>&eq=<key>",
        });
      }
      const page =
        index === undefined || eq === undefined
          ? yield* store.list(type, options)
          : yield* store.lookup(type, index, eq, options);
      return json(
        (yield* includeLinks())
          ? { ...page, included: yield* store.resolveLinks(page.items) }
          : page,
      );
    }),
  ),
  route(
    "POST",
    "/api/types/:type/entities",
    Effect.gen(function* () {
      const input = yield* body(CreateEntityBody);
      const store = yield* EntityStore;
      return json(yield* store.create(yield* pathParam("type"), input), 201);
    }),
  ),
  route(
    "POST",
    "/api/types/:type/entities/:id/check",
    Effect.gen(function* () {
      const input = yield* body(CheckEntityBody);
      const store = yield* EntityStore;
      const id = yield* entityIdParam;
      return json(yield* store.checkUpsert(yield* pathParam("type"), id, input));
    }),
  ),
  route(
    "PUT",
    "/api/types/:type/entities/:id",
    Effect.gen(function* () {
      const input = yield* body(UpsertBody);
      const store = yield* EntityStore;
      const id = yield* entityIdParam;
      const upserted = yield* store.upsert(yield* pathParam("type"), id, input);
      return json(upserted, upserted.created ? 201 : 200);
    }),
  ),
  route(
    "GET",
    "/api/entities/:id",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      const entity = yield* store.get(yield* pathParam("id"), {
        version: yield* intParam("version"),
        rev: yield* intParam("rev"),
      });
      return json(
        (yield* includeLinks())
          ? { ...entity, included: yield* store.resolveLinks([entity]) }
          : entity,
      );
    }),
  ),
  route(
    "PUT",
    "/api/entities/:id",
    Effect.gen(function* () {
      const input = yield* body(ReplaceBody);
      const store = yield* EntityStore;
      return json(yield* store.replace(yield* pathParam("id"), input));
    }),
  ),
  route(
    "PATCH",
    "/api/entities/:id",
    Effect.gen(function* () {
      const input = yield* body(PatchBody);
      const store = yield* EntityStore;
      return json(yield* store.patch(yield* pathParam("id"), input));
    }),
  ),
  route(
    "DELETE",
    "/api/entities/:id",
    Effect.gen(function* () {
      const input = yield* optionalBody(DeleteBody);
      const store = yield* EntityStore;
      return json(
        yield* store.remove(yield* pathParam("id"), {
          expectedRev: input?.expectedRev ?? (yield* intParam("expectedRev")),
          meta: input?.meta,
        }),
      );
    }),
  ),
  route(
    "GET",
    "/api/entities/:id/backlinks",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(
        yield* store.backlinks(yield* pathParam("id"), {
          cursor: yield* stringParam("cursor"),
          limit: yield* intParam("limit"),
        }),
      );
    }),
  ),
  route(
    "GET",
    "/api/entities/:id/history",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(
        yield* store.history(yield* pathParam("id"), {
          version: yield* intParam("version"),
          before: yield* intParam("before"),
          limit: yield* intParam("limit"),
        }),
      );
    }),
  ),

  // ── Changes ──
  route(
    "GET",
    "/api/changes",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(
        yield* store.listChanges({
          after: yield* intParam("after", { min: 0 }),
          limit: yield* intParam("limit"),
        }),
      );
    }),
  ),

  // ── Indexes ──
  route(
    "GET",
    "/api/types/:type/indexes",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json({ items: yield* store.listIndexes(yield* pathParam("type")) });
    }),
  ),
  route(
    "POST",
    "/api/types/:type/indexes",
    Effect.gen(function* () {
      const input = yield* body(CreateIndexBody);
      const store = yield* EntityStore;
      return json(yield* store.createIndex(yield* pathParam("type"), input), 201);
    }),
  ),
  route(
    "GET",
    "/api/types/:type/indexes/:name",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(yield* store.getIndex(yield* pathParam("type"), yield* pathParam("name")));
    }),
  ),
  route(
    "DELETE",
    "/api/types/:type/indexes/:name",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(yield* store.dropIndex(yield* pathParam("type"), yield* pathParam("name")));
    }),
  ),
  route(
    "POST",
    "/api/types/:type/indexes/:name/build",
    Effect.gen(function* () {
      const store = yield* EntityStore;
      return json(
        yield* store.buildIndex(yield* pathParam("type"), yield* pathParam("name"), {
          steps: SYNC_BUILD_PAGES,
        }),
      );
    }),
  ),

  // ── Lens and schema authoring helpers (pure, no storage) ──
  route(
    "POST",
    "/api/lens/run",
    Effect.gen(function* () {
      const input = yield* body(RunLensBody);
      const lens = compileLens(input.lens);
      if (Result.isFailure(lens)) {
        return json({ ok: false, issues: lens.failure });
      }
      const output = lens.success[input.direction](input.doc);
      return Result.isSuccess(output)
        ? json({ ok: true, output: output.success })
        : json({ ok: false, error: output.failure });
    }),
  ),
  route(
    "POST",
    "/api/schema/check",
    Effect.gen(function* () {
      const input = yield* body(Schema.Struct({ schema: EntitySchema }));
      const issues = checkDefinition(input.schema);
      return json({ ok: issues.length === 0, issues });
    }),
  ),
  route(
    "GET",
    "/api/lens/functions",
    Effect.succeed(
      json({
        items: Object.entries(BUILTINS).map(([name, fn]) => ({
          name,
          doc: fn.doc,
          minArgs: fn.min,
          maxArgs: fn.max === Infinity ? null : fn.max,
        })),
      }),
    ),
  ),
);
