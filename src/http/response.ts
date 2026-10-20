import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { StoreError } from "../entity/model.ts";

export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

/** Request bodies are capped. Entity documents larger than this belong in object storage. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Deeply nested JSON would overflow the stack in the decoder and in lenses. */
const MAX_DEPTH = 64;

/** Maximum bracket nesting in JSON text, skipping string contents. */
const nestingDepth = (text: string): number => {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) {
        i++;
      } else if (c === 34) {
        inString = false;
      }
    } else if (c === 34) {
      inString = true;
    } else if (c === 91 || c === 123) {
      depth++;
      max = Math.max(max, depth);
    } else if (c === 93 || c === 125) {
      depth--;
    }
  }
  return max;
};

/** The request has no verified principal. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {}

/** A request the HTTP layer rejects before it reaches an application operation. */
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  status: Schema.Int,
  message: Schema.String,
}) {}

/** Read and decode a JSON body, enforcing the size cap. */
export const body = <S extends Schema.Codec<any, unknown>>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > MAX_BODY_BYTES) {
      return yield* new BadRequest({ status: 413, message: "Request body is too large" });
    }
    const text = yield* request.text.pipe(
      Effect.mapError(() => new BadRequest({ status: 400, message: "Couldn't read the body" })),
    );
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return yield* new BadRequest({ status: 413, message: "Request body is too large" });
    }
    if (nestingDepth(text) > MAX_DEPTH) {
      return yield* new BadRequest({
        status: 400,
        message: `JSON may nest at most ${MAX_DEPTH} levels`,
      });
    }
    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text, {
      errors: "all",
    });
    if (Result.isFailure(decoded)) {
      return yield* new BadRequest({ status: 400, message: decoded.failure.message });
    }
    return decoded.success as S["Type"];
  });

const searchParams = (url: string) => new URLSearchParams(url.split("?")[1] ?? "");

/** An optional positive integer query parameter. */
export const intParam = (name: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = searchParams(request.url).get(name);
    if (raw === null || raw === "") {
      return undefined;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      return yield* new BadRequest({ status: 400, message: `${name} must be a positive integer` });
    }
    return value;
  });

/** A query parameter as given, keeping `?name=` as the empty string. */
export const rawParam = (name: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return searchParams(request.url).get(name) ?? undefined;
  });

export const stringParam = (name: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const value = searchParams(request.url).get(name);
    return value === null || value === "" ? undefined : value;
  });

export type HttpError = StoreError | BadRequest | Unauthenticated;

const statusOf = (error: HttpError): number => {
  switch (error._tag) {
    case "BadRequest":
      return error.status;
    case "Unauthenticated":
      return 401;
    case "TypeNotFound":
    case "VersionNotFound":
    case "EntityNotFound":
    case "RevisionNotFound":
    case "IndexNotFound":
      return 404;
    case "TypeAlreadyExists":
    case "EntityAlreadyExists":
    case "VersionConflict":
    case "RevConflict":
    case "EntityLinked":
    case "IndexAlreadyExists":
    case "IndexNotReady":
    case "UniqueViolation":
      return 409;
    case "EntityDeleted":
      return 410;
    case "InvalidSchema":
    case "InvalidLens":
    case "LensCheckFailed":
    case "ValidationFailed":
    case "ProjectionFailed":
    case "LinkTargetInvalid":
    case "InvalidIndex":
    case "IndexKeyFailed":
      return 422;
    case "StorageFailure":
      return 500;
  }
};

const messageOf = (error: HttpError): string => {
  switch (error._tag) {
    case "BadRequest":
      return error.message;
    case "Unauthenticated":
      return "Sign in through Cloudflare Access to use this API";
    case "TypeNotFound":
      return `No entity type named '${error.type}'`;
    case "TypeAlreadyExists":
      return `Entity type '${error.type}' already exists`;
    case "VersionNotFound":
      return `${error.type} has no version ${error.version}`;
    case "VersionConflict":
      return `Another version of ${error.type} was added first; reload and try again`;
    case "InvalidSchema":
      return "The schema definition is invalid";
    case "InvalidLens":
      return "The lens definition is invalid";
    case "LensCheckFailed":
      return "The lens produced invalid documents; see report (or pass force: true)";
    case "EntityNotFound":
      return `No entity with id '${error.id}'`;
    case "EntityDeleted":
      return `Entity '${error.id}' was deleted at rev ${error.rev}`;
    case "EntityAlreadyExists":
      return `An entity with id '${error.id}' already exists`;
    case "RevisionNotFound":
      return `Entity '${error.id}' has no rev ${error.rev}`;
    case "RevConflict":
      return `Entity '${error.id}' is at rev ${error.currentRev}, not ${error.expectedRev}`;
    case "ValidationFailed":
      return `Data doesn't match ${error.type} v${error.version}: ${error.message}`;
    case "ProjectionFailed":
      return `Couldn't present ${error.type} v${error.from} data as v${error.to}: ${error.message}`;
    case "LinkTargetInvalid":
      return error.problems.length === 0
        ? "A linked entity doesn't exist, was deleted, or has the wrong type"
        : error.problems.map((p) => `${p.path}: ${p.message}`).join("; ");
    case "EntityLinked":
      return `Entity '${error.id}' is linked from other entities; remove those links first`;
    case "InvalidIndex":
      return "The index definition is invalid";
    case "IndexAlreadyExists":
      return `${error.type} already has an index named '${error.index}'`;
    case "IndexNotFound":
      return `${error.type} has no index named '${error.index}'`;
    case "IndexNotReady":
      return error.state === "failed"
        ? `Index '${error.index}' failed to build; see the index for why, then drop and recreate it`
        : `Index '${error.index}' is still building; try again shortly`;
    case "IndexKeyFailed":
      return `Couldn't compute index '${error.index}' for this ${error.type}: ${error.message}`;
    case "UniqueViolation":
      return error.conflicts.length === 0
        ? "Another entity already has this unique index key"
        : error.conflicts
            .map((c) => `${c.index}: '${c.key}' is taken${c.id === undefined ? "" : ` by ${c.id}`}`)
            .join("; ");
    case "StorageFailure":
      return "Storage error";
  }
};

const detailsOf = (error: HttpError): Record<string, unknown> => {
  switch (error._tag) {
    case "InvalidSchema":
    case "InvalidLens":
    case "InvalidIndex":
      return { issues: error.issues };
    case "IndexNotReady":
      return { state: error.state };
    case "UniqueViolation":
      return { conflicts: error.conflicts };
    case "LensCheckFailed":
      return { report: error.report };
    case "RevConflict":
      return { currentRev: error.currentRev };
    case "EntityDeleted":
      return { rev: error.rev };
    case "LinkTargetInvalid":
      return { problems: error.problems };
    case "EntityLinked":
      return { linkedFrom: error.linkedFrom };
    default:
      return {};
  }
};

/** Map every expected failure to a JSON error response. */
export const respond = <E extends HttpError, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  effect.pipe(
    Effect.catch((error: HttpError) =>
      Effect.gen(function* () {
        if (error._tag === "StorageFailure") {
          // Log the operation name only; storage messages can echo data.
          yield* Effect.logError("Storage failure");
        }
        return json(
          { error: messageOf(error), code: error._tag, ...detailsOf(error) },
          statusOf(error),
        );
      }),
    ),
  );
