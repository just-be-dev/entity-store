import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Http from "foldkit/http";
import { ApiFailure, ErrorBody } from "@/domain/entityStore";
import { parseJson } from "@/domain/json";

/** API URLs are relative to the app's base path, so the UI works under a project prefix. */
export const apiUrl = (path: string, query: Readonly<Record<string, string>> = {}): string => {
  const search = new URLSearchParams(query).toString();
  return `${import.meta.env.BASE_URL}api/${path}${search === "" ? "" : `?${search}`}`;
};

/** Encode one path segment (type names and entity ids). */
export const segment = (value: string): string => encodeURIComponent(value);

const failure = (status: number, error: string): ApiFailure =>
  ApiFailure.make({
    status,
    error,
    code: Option.none(),
    issues: [],
    report: Option.none(),
    currentRev: Option.none(),
  });

const decodeErrorBody = Schema.decodeUnknownResult(ErrorBody);

/** Normalize an error response body (`{ error, code, ...details }`). */
export const toApiFailure = (status: number, body: unknown): ApiFailure =>
  Result.match(decodeErrorBody(body), {
    onFailure: () => failure(status, `Request failed with status ${status}`),
    onSuccess: (decoded) =>
      ApiFailure.make({
        status,
        error: decoded.error,
        code: decoded.code,
        issues: decoded.issues ?? [],
        report: decoded.report,
        currentRev: decoded.currentRev,
      }),
  });

export const unreachable = failure(0, "Couldn't reach the API. Check your connection and retry.");

const send = <A>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, ApiFailure> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.acceptJson(request))
      .pipe(Effect.mapError(() => unreachable));
    const text = yield* response.text.pipe(Effect.mapError(() => unreachable));
    const body = parseJson(text);
    if (response.status >= 400) {
      return yield* Effect.fail(
        toApiFailure(
          response.status,
          Result.getOrElse(body, () => null),
        ),
      );
    }
    if (Result.isFailure(body)) {
      return yield* Effect.fail(
        failure(response.status, "The API returned a response that isn't JSON"),
      );
    }
    return yield* Schema.decodeUnknownEffect(schema)(body.success).pipe(
      Effect.mapError((error) =>
        failure(response.status, `Unexpected response from the API: ${error.message}`),
      ),
    );
  }).pipe(Effect.provide(Http.layer));

export const getJson = <A>(url: string, schema: Schema.Decoder<A>) =>
  send(HttpClientRequest.get(url), schema);

export const postJson = <A>(url: string, body: unknown, schema: Schema.Decoder<A>) =>
  send(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body), schema);

export const putJson = <A>(url: string, body: unknown, schema: Schema.Decoder<A>) =>
  send(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(url), body), schema);

export const deleteJson = <A>(url: string, schema: Schema.Decoder<A>) =>
  send(HttpClientRequest.make("DELETE")(url), schema);
