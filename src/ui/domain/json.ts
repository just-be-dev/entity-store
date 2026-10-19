import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownResult(Schema.Json);

/** Parse text from a JSON textarea, keeping the parser's message on failure. */
export const parseJson = (text: string): Result.Result<Schema.Json, string> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Result.mapError(decodeJson(parsed), (error) => error.message);
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : "Invalid JSON");
  }
};

export const prettyJson = (value: Schema.Json): string => JSON.stringify(value, null, 2);

/** One-line JSON, for dense tables. */
export const compactJson = (value: Schema.Json): string => JSON.stringify(value);

const asObject = (value: unknown): Option.Option<Readonly<Record<string, unknown>>> =>
  typeof value === "object" && value !== null && !globalThis.Array.isArray(value)
    ? Option.some(value as Readonly<Record<string, unknown>>)
    : Option.none();

const field = (value: unknown, key: string): unknown =>
  Option.match(asObject(value), {
    onNone: () => undefined,
    onSome: (object) => object[key],
  });

const exampleFor = (type: unknown): Schema.Json => {
  const kind = field(type, "type");
  if (kind === "string") {
    return "";
  }
  if (kind === "number") {
    return 0;
  }
  if (kind === "boolean") {
    return false;
  }
  if (kind === "enum") {
    const values = field(type, "values");
    return globalThis.Array.isArray(values) && typeof values[0] === "string" ? values[0] : "";
  }
  if (kind === "array") {
    return [];
  }
  if (kind === "object") {
    return exampleFields(field(type, "fields"));
  }
  return null;
};

const exampleFields = (fields: unknown): Schema.Json =>
  Option.match(asObject(fields), {
    onNone: () => ({}),
    onSome: (object) =>
      Record.fromEntries(
        Array.filterMap(Record.toEntries(object), ([name, type]) =>
          field(type, "optional") === true
            ? Result.failVoid
            : Result.succeed([name, exampleFor(type)] as const),
        ),
      ),
  });

/**
 * A starting document for an entity schema (docs/data-model.md): required
 * fields with blank values, optional fields left out.
 */
export const exampleDocument = (schema: Schema.Json): Schema.Json =>
  exampleFields(field(schema, "fields"));
