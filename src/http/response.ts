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

export const stringParam = (name: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const value = searchParams(request.url).get(name);
    return value === null || value === "" ? undefined : value;
  });

const statusOf = (error: StoreError | BadRequest): number => {
  switch (error._tag) {
    case "BadRequest":
      return error.status;
    case "TypeNotFound":
    case "VersionNotFound":
    case "EntityNotFound":
    case "RevisionNotFound":
      return 404;
    case "TypeAlreadyExists":
    case "EntityAlreadyExists":
    case "VersionConflict":
    case "RevConflict":
      return 409;
    case "EntityDeleted":
      return 410;
    case "InvalidSchema":
    case "InvalidLens":
    case "LensCheckFailed":
    case "ValidationFailed":
    case "ProjectionFailed":
      return 422;
    case "StorageFailure":
      return 500;
  }
};

const messageOf = (error: StoreError | BadRequest): string => {
  switch (error._tag) {
    case "BadRequest":
      return error.message;
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
    case "StorageFailure":
      return "Storage error";
  }
};

const detailsOf = (error: StoreError | BadRequest): Record<string, unknown> => {
  switch (error._tag) {
    case "InvalidSchema":
    case "InvalidLens":
      return { issues: error.issues };
    case "LensCheckFailed":
      return { report: error.report };
    case "RevConflict":
      return { currentRev: error.currentRev };
    case "EntityDeleted":
      return { rev: error.rev };
    default:
      return {};
  }
};

/** Map every expected failure to a JSON error response. */
export const respond = <E extends StoreError | BadRequest, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  effect.pipe(
    Effect.catch((error: StoreError | BadRequest) =>
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
