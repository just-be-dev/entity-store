import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { errorBody } from "../entity/errors.ts";
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
  Effect.flatMap(readBody(schema), (decoded) =>
    decoded === undefined
      ? Effect.fail(new BadRequest({ status: 400, message: "Expected a JSON body" }))
      : Effect.succeed(decoded),
  );

/** Like {@link body}, but an empty body decodes to `undefined`. */
export const optionalBody = <S extends Schema.Codec<any, unknown>>(schema: S) => readBody(schema);

const readBody = <S extends Schema.Codec<any, unknown>>(schema: S) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const declared = Number(request.headers["content-length"] ?? "0");
    if (declared > MAX_BODY_BYTES) {
      return yield* new BadRequest({ status: 413, message: "Request body is too large" });
    }
    const text = yield* request.text.pipe(
      Effect.mapError(() => new BadRequest({ status: 400, message: "Couldn't read the body" })),
    );
    if (text.trim() === "") {
      return undefined;
    }
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
    return decoded.success as S["Type"] | undefined;
  });

const searchParams = (url: string) => new URLSearchParams(url.split("?")[1] ?? "");

/** An optional integer query parameter, at least `min` (default 1). */
export const intParam = (name: string, options?: { readonly min?: number }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = searchParams(request.url).get(name);
    if (raw === null || raw === "") {
      return undefined;
    }
    const min = options?.min ?? 1;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) {
      return yield* new BadRequest({
        status: 400,
        message:
          min === 1 ? `${name} must be a positive integer` : `${name} must be an integer ≥ ${min}`,
      });
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
    case "ChangeNotFound":
      return 404;
    case "TypeAlreadyExists":
    case "TypeInUse":
    case "EntityAlreadyExists":
    case "EntityTypeMismatch":
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
    default:
      return errorBody(error).message;
  }
};

const bodyOf = (error: HttpError): Record<string, unknown> => {
  if (error._tag === "BadRequest" || error._tag === "Unauthenticated") {
    return { error: messageOf(error), code: error._tag };
  }
  const { code, message, ...details } = errorBody(error);
  return { error: message, code, ...details };
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
        return json(bodyOf(error), statusOf(error));
      }),
    ),
  );
